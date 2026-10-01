// Person tracking with MediaPipe:
//  - PoseLandmarker  → body landmarks, to anchor the rings on the person
//  - ImageSegmenter  → person mask, so the rings can pass *behind* the person
//
// The mask is a float texture on MediaPipe's GPU context. Reading float
// textures back to JS is slow and unreliable across GPUs, so MediaPipe's
// DrawingUtils renders it as plain 8-bit RGB into the segmenter's own canvas,
// that is blitted into a small 2D canvas, and the renderer uploads the 2D
// canvas as a texture. No float readback and no shared GL state between
// MediaPipe and Three.js (sharing one context corrupts MediaPipe's graph).

import { FilesetResolver, PoseLandmarker, ImageSegmenter, DrawingUtils } from '@mediapipe/tasks-vision';

const BASE = import.meta.env.BASE_URL;
const WASM_PATH = `${BASE}mediapipe`;
const POSE_MODELS = {
  lite: `${BASE}models/pose_landmarker_lite.task`,
  full: `${BASE}models/pose_landmarker_full.task`,
};
const MASK_MODELS = {
  // 1 confidence mask: person
  fast: { path: `${BASE}models/selfie_segmenter.tflite`, personIsBackgroundInverse: false },
  // 6 masks; [0] is background, so person = 1 - background
  hq: { path: `${BASE}models/selfie_multiclass_256x256.tflite`, personIsBackgroundInverse: true },
};
const MASK_MAX_EDGE = 384; // mask canvas resolution (it is feathered anyway)
const MASK_BLEND = 0.65; // weight of the newest mask vs. the previous (temporal smoothing)
// Opaque colours: confidence ends up in .r with alpha 1, so premultiplied
// alpha can't distort it when the canvas is uploaded as a texture.
const BLACK = [0, 0, 0, 255];
const WHITE = [255, 255, 255, 255];

async function withGpuFallback(create) {
  try {
    return { task: await create('GPU'), delegate: 'GPU' };
  } catch (err) {
    console.warn('GPU delegate failed, falling back to CPU', err);
    return { task: await create('CPU'), delegate: 'CPU' };
  }
}

export class PersonTracker {
  constructor() {
    this.fileset = null;
    this.pose = null; // array of {x, y, v} in normalized video coords, or null
    this.landmarker = null;
    this.segmenter = null;
    this.glCanvas = null; // MediaPipe's own WebGL canvas (segmenter context)
    this.maskCanvas = null; // 2D canvas holding the latest person mask (.r)
    this.maskVersion = 0;
    this.hasMask = false;
    this.lastVideoTime = -1;
    this.lastTs = 0;
  }

  async _fileset() {
    if (!this.fileset) this.fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    return this.fileset;
  }

  async init(poseModel = 'lite', maskModel = 'fast') {
    await Promise.all([this.initPose(poseModel), this.initMask(maskModel)]);
  }

  async initPose(model = 'lite') {
    const fileset = await this._fileset();
    const old = this.landmarker;
    this.landmarker = null;
    old?.close();
    const { task } = await withGpuFallback((delegate) =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: POSE_MODELS[model] ?? POSE_MODELS.lite, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
    );
    this.landmarker = task;
    this.poseModel = model;
  }

  async initMask(model = 'fast') {
    const fileset = await this._fileset();
    const old = this.segmenter;
    this.segmenter = null;
    old?.close();
    this.hasMask = false;
    const cfg = MASK_MODELS[model] ?? MASK_MODELS.fast;

    // Fresh canvas per segmenter: it owns the GL context MediaPipe runs on.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const { task } = await withGpuFallback((delegate) =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: cfg.path, delegate },
        canvas: delegate === 'GPU' ? canvas : undefined,
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      }),
    );
    this.glCanvas = canvas;
    this.drawer = new DrawingUtils(canvas.getContext('webgl2'));
    if (!this.maskCanvas) {
      this.maskCanvas = document.createElement('canvas');
      this.maskCtx = this.maskCanvas.getContext('2d');
    }
    this.maskCfg = cfg;
    this.segmenter = task;
    this.maskModel = model;
  }

  /** Run detection on the current video frame if it's new. */
  detect(video) {
    if (video.readyState < 2) return false;
    if (video.currentTime === this.lastVideoTime) return false;
    this.lastVideoTime = video.currentTime;

    // Timestamps must be strictly increasing.
    const ts = Math.max(performance.now(), this.lastTs + 1);
    this.lastTs = ts;

    // A single bad frame must never kill the render loop, hence the try/catch.
    if (this.landmarker) {
      try {
        const res = this.landmarker.detectForVideo(video, ts);
        const lm = res.landmarks?.[0];
        this.pose = lm ? lm.map((p) => ({ x: p.x, y: p.y, v: p.visibility ?? 1 })) : null;
        this.poseVersion = (this.poseVersion ?? 0) + 1; // a fresh sample to filter
        this.poseTime = ts / 1000;
      } catch (err) {
        console.warn('Pose detection failed for a frame', err);
      }
    }

    if (this.segmenter) {
      try {
        this.segmenter.segmentForVideo(video, ts, (res) => {
          // Mask textures are only valid inside this callback: draw it now.
          const m = res.confidenceMasks?.[0];
          if (!m || !this.pose) {
            this.hasMask = false;
            return;
          }
          const s = Math.min(1, MASK_MAX_EDGE / Math.max(m.width, m.height));
          const w = Math.max(1, Math.round(m.width * s));
          const h = Math.max(1, Math.round(m.height * s));
          const out = this.maskCanvas;
          let fresh = !this.hasMask;
          if (out.width !== w || out.height !== h) {
            out.width = w;
            out.height = h;
            fresh = true;
          }
          // Draw at MediaPipe's own canvas size (it manages that canvas; resizing
          // it breaks drawing), then downscale while copying into our canvas.
          // The copy must happen now: MediaPipe reuses its canvas afterwards.
          if (this.maskCfg.personIsBackgroundInverse) this.drawer.drawConfidenceMask(m, WHITE, BLACK);
          else this.drawer.drawConfidenceMask(m, BLACK, WHITE);
          // Blend over the previous mask (temporal smoothing): steadier body
          // edges with no flicker, at the cost of a very slight trail.
          this.maskCtx.globalAlpha = fresh ? 1 : MASK_BLEND;
          this.maskCtx.drawImage(this.glCanvas, 0, 0, w, h);
          this.maskCtx.globalAlpha = 1;
          this.hasMask = true;
          this.maskVersion++;
        });
      } catch (err) {
        console.warn('Segmentation failed for a frame', err);
      }
    }
    return true;
  }

  get hasPerson() {
    return !!this.pose;
  }
}
