// World-lock AR mode (WebXR immersive-ar + ARCore), used by the Lock button
// on supporting Android phones.
//
// ARCore tracks the phone's position and rotation in the room, so once the
// content is pinned it stays put like a real object while you walk around.
// We still draw everything (camera image from WebXR camera-access, person
// cut-out, text, fireworks) onto our own canvas, which Chrome shows via DOM
// overlay, so the existing recorder keeps working.

const PLACE_TIMEOUT_MS = 1500; // wait this long for a floor hit before estimating
const NO_CAMERA_FRAMES = 90; // give up if camera-access never delivers images

export class WorldLockXR {
  /**
   * Why world-lock AR can or can't run here, in plain words. Only call this
   * from a user tap: it starts Google's AR service, which crashes on some
   * phones ("Google Play services keeps stopping").
   */
  static async diagnose() {
    if (!window.isSecureContext) return { ok: false, reason: 'page is not opened over https://' };
    if (!navigator.xr) return { ok: false, reason: 'this browser has no WebXR (use Chrome on Android)' };
    try {
      if (!(await navigator.xr.isSessionSupported('immersive-ar'))) {
        return { ok: false, reason: 'AR not supported: install/update "Google Play Services for AR"' };
      }
    } catch (err) {
      return { ok: false, reason: `AR check failed (${err.message})` };
    }
    return { ok: true, reason: 'AR supported' };
  }

  /**
   * @param {object} o
   * @param {import('./arScene.js').ARScene} o.ar
   * @param {import('./tracker.js').PersonTracker} o.tracker
   * @param {() => object} o.getSettings
   * @param {(reason?: string) => void} o.onEnd  called once when the session ends
   * @param {() => void} [o.onAfterFrame]  called after each frame is drawn
   */
  constructor({ ar, tracker, getSettings, onEnd, onAfterFrame }) {
    this.ar = ar;
    this.tracker = tracker;
    this.getSettings = getSettings;
    this.onEnd = onEnd;
    this.onAfterFrame = onAfterFrame;
    this.session = null;
    this.active = false;
    this._onFrame = this._onFrame.bind(this);
  }

  async start() {
    const gl = this.ar.renderer.getContext();
    await gl.makeXRCompatible();
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local', 'camera-access'],
      optionalFeatures: ['dom-overlay', 'hit-test'],
      domOverlay: { root: document.body },
    });
    this.session = session;
    this.active = true;
    this.binding = new XRWebGLBinding(session, gl);
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
    this.refSpace = await session.requestReferenceSpace('local');
    this.viewerSpace = await session.requestReferenceSpace('viewer').catch(() => null);
    this.hitTest = session.enabledFeatures ? session.enabledFeatures.includes('hit-test') : !!this.viewerSpace;
    session.addEventListener('end', () => this._ended());
    this._lastT = null;
    this._noCamera = 0;
    this._placeStart = null;
    this._hitSource = null;
    session.requestAnimationFrame(this._onFrame);
  }

  end(reason) {
    this._endReason = reason;
    this.session?.end().catch(() => this._ended());
  }

  _ended() {
    if (!this.active) return;
    this.active = false;
    this._hitSource?.cancel?.();
    this._hitSource = null;
    this.session = null;
    this.onEnd?.(this._endReason);
  }

  _onFrame(t, frame) {
    const session = frame.session;
    session.requestAnimationFrame(this._onFrame);
    const pose = frame.getViewerPose(this.refSpace);
    if (!pose) return; // tracking not ready yet
    const view = pose.views[0];
    if (!view.camera) {
      if (++this._noCamera > NO_CAMERA_FRAMES) this.end('Camera access is not available in AR mode on this phone.');
      return;
    }
    const cameraTexture = this.binding.getCameraImage(view.camera);
    if (!cameraTexture) return;

    const ar = this.ar;
    const settings = this.getSettings();
    const dt = this._lastT === null ? 1 / 60 : Math.min(0.05, (t - this._lastT) / 1000);
    this._lastT = t;

    // 1. camera image onto our canvas
    ar.setXRView(view, cameraTexture);
    ar.renderBackground();

    // 2. detect on that image (the canvas currently holds only the camera)
    const placed = ar.xr.placed;
    this.tracker.detectSource(ar.renderer.domElement, { pose: !placed });
    ar.updateMask(this.tracker);

    // 3. pin the content once we know where the person is
    if (!placed) this._tryPlace(frame, view, t);
    else ar.updateXRAppear(dt);

    // 4. draw the content (cut-out only once placed)
    ar.update(dt, { settings, gyro: null });
    ar.renderContent(settings.occlusion && ar.xr.placed);
    this.onAfterFrame?.();
  }

  _tryPlace(frame, view, t) {
    const ar = this.ar;
    const measure = ar.measurePersonForXR(this.tracker.pose, view);
    if (!measure) {
      this._placeStart = null; // wait until the person is in view
      return;
    }
    if (this._placeStart === null) {
      this._placeStart = t;
      // Ray from the phone through the person's feet: where it hits the floor
      // tells us exactly how far away they are.
      if (this.hitTest && this.viewerSpace && !this._hitRequested) {
        this._hitRequested = true;
        const d = measure.feetDir;
        this.session
          .requestHitTestSource({
            space: this.viewerSpace,
            offsetRay: new XRRay(new DOMPointReadOnly(0, 0, 0, 1), new DOMPointReadOnly(d.x, d.y, d.z, 0)),
          })
          .then((src) => (this._hitSource = src))
          .catch(() => (this.hitTest = false));
      }
    }

    let floor = null;
    if (this._hitSource) {
      const hit = frame.getHitTestResults(this._hitSource)[0];
      const p = hit?.getPose(this.refSpace)?.transform.position;
      if (p) floor = { x: p.x, y: p.y, z: p.z };
    }
    if (floor || t - this._placeStart > PLACE_TIMEOUT_MS) {
      ar.placeInWorld(measure, floor ? new (ar.anchor.hip.constructor)(floor.x, floor.y, floor.z) : null);
      this._hitSource?.cancel?.();
      this._hitSource = null;
    }
  }
}
