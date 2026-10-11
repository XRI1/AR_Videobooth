// Records the composited AR canvas (plus optional mic audio) to a video file.
//
// MP4 (H.264 video + AAC audio) is the goal, because every phone, gallery
// and messaging app plays it. Three ways, best first:
//   1. WebCodecs + mp4-muxer: hardware H.264 encoder -> standard MP4 file.
//      Works in Chrome on Android, where MediaRecorder can only do WebM.
//   2. MediaRecorder with native MP4 (Safari / iOS, newer browsers).
//   3. MediaRecorder WebM, as a last resort.

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

// MP4 types MediaRecorder may support (Safari; Chrome 126+ incl. Android)
const MEDIARECORDER_MP4 = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,opus',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/mp4;codecs=avc1',
  'video/mp4;codecs=avc3',
  'video/mp4',
];
const MEDIARECORDER_WEBM = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
// H.264 profiles/levels to try (High, Main, Baseline; level 4.0 covers 1080x1920,
// 5.1 larger, 3.1 is the most widely supported for 720p)
const AVC_CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.640033', 'avc1.42e033', 'avc1.42001f', 'avc1.4d001f'];
// Longest edge to try, best first. Many Android hardware encoders reject the
// exact screen size (e.g. 1080x2400 or sizes not a multiple of 16) but accept
// a slightly smaller, 16-aligned one.
const SIZE_STEPS = [0, 1920, 1600, 1280, 960];
const VIDEO_BITRATE = 10_000_000;
const AUDIO_BITRATE = 128_000;
const KEYFRAME_SECONDS = 2;

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
const align16 = (n) => Math.max(16, Math.floor(n / 16) * 16);
const pickType = (list) => list.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';

export class Recorder {
  constructor(canvas) {
    this.canvas = canvas;
    this.mode = null; // 'webcodecs' | 'mediarecorder'
    this.fallbackReason = ''; // why WebCodecs MP4 wasn't used (shown if the result is WebM)
    this._configCache = new Map(); // canvas size -> working encoder config (or null)
    this.startedAt = 0;
    this._recording = false;
  }

  get isRecording() {
    return this._recording;
  }

  get elapsed() {
    return this._recording ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  /** File extension of the last/current recording. */
  get extension() {
    return this._type?.startsWith('video/mp4') ? 'mp4' : 'webm';
  }

  /** Find a working MP4 encoder setup ahead of time, so pressing record starts instantly. */
  prepare(fps = 30) {
    this.fps = fps;
    if ('VideoEncoder' in window && 'VideoFrame' in window) this._pickVideoConfig().catch(() => {});
  }

  /** Start recording. Uses the best available way to get an MP4. */
  async start(audioTrack = null, fps = 30) {
    if (this._recording) return;
    this.fps = fps;
    this.fallbackReason = '';
    if (!('VideoEncoder' in window) || !('VideoFrame' in window)) {
      this.fallbackReason = 'this browser has no WebCodecs video encoder';
    } else {
      try {
        await this._startWebCodecs(audioTrack, fps);
        return;
      } catch (err) {
        console.warn('WebCodecs MP4 recording failed to start, using MediaRecorder', err);
        this.fallbackReason = err.message || String(err);
        this._cleanupWebCodecs();
      }
    }
    this._startMediaRecorder(audioTrack, fps);
  }

  /**
   * Call right after each frame is drawn (same task, while the canvas still
   * holds the frame). Only used by the WebCodecs path.
   */
  captureFrame() {
    if (!this._recording || this.mode !== 'webcodecs' || this._failed) return;
    const now = performance.now();
    if (now - this._lastFrameAt < 1000 / this.fps - 4) return; // keep ~fps
    if (this.videoEncoder.encodeQueueSize > 3) return; // encoder busy: drop a frame
    this._lastFrameAt = now;
    this.frameCtx.drawImage(this.canvas, 0, 0, this.width, this.height);
    const frame = new VideoFrame(this.frameCanvas, { timestamp: Math.round((now - this.startedAt) * 1000) });
    const keyFrame = this._frameCount % Math.round(this.fps * KEYFRAME_SECONDS) === 0;
    this._frameCount++;
    try {
      this.videoEncoder.encode(frame, { keyFrame });
    } finally {
      frame.close();
    }
  }

  /** Stop and return the finished video Blob. */
  async stop() {
    if (!this._recording) return null;
    this._recording = false;
    return this.mode === 'webcodecs' ? this._stopWebCodecs() : this._stopMediaRecorder();
  }

  /* --------------------------- WebCodecs -> MP4 --------------------------- */

  /** Candidate output sizes: the canvas size, then 16-aligned and smaller ones (same aspect). */
  _candidateSizes() {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const out = [];
    const seen = new Set();
    const add = (w, h) => {
      const key = `${w}x${h}`;
      if (w >= 16 && h >= 16 && !seen.has(key)) {
        seen.add(key);
        out.push({ width: w, height: h });
      }
    };
    add(even(cw), even(ch));
    for (const edge of SIZE_STEPS) {
      const k = edge ? Math.min(1, edge / Math.max(cw, ch)) : 1;
      add(align16(cw * k), align16(ch * k));
    }
    return out;
  }

  /**
   * Find an H.264 encoder config that really works on this device:
   * isConfigSupported() first, then a test encode of one frame (some Android
   * encoders claim support and then fail on the first frame).
   */
  async _pickVideoConfig() {
    const cacheKey = `${this.canvas.width}x${this.canvas.height}@${this.fps}`;
    if (this._configCache.has(cacheKey)) return this._configCache.get(cacheKey);
    let found = null;
    search: for (const size of this._candidateSizes()) {
      for (const codec of AVC_CODECS) {
        for (const extra of [{ latencyMode: 'realtime' }, {}, { hardwareAcceleration: 'prefer-software' }]) {
          const config = { codec, ...size, bitrate: VIDEO_BITRATE, framerate: this.fps ?? 30, avc: { format: 'avc' }, ...extra };
          try {
            if (!(await VideoEncoder.isConfigSupported(config)).supported) continue;
          } catch {
            continue;
          }
          if (await this._probeEncoder(config)) {
            found = config;
            break search;
          }
        }
      }
    }
    this._configCache.set(cacheKey, found);
    return found;
  }

  /** Encode one blank frame with `config`; true if the encoder produced output without errors. */
  async _probeEncoder(config) {
    let ok = false;
    let failed = false;
    const enc = new VideoEncoder({ output: () => (ok = true), error: () => (failed = true) });
    try {
      enc.configure(config);
      const cv = document.createElement('canvas');
      cv.width = config.width;
      cv.height = config.height;
      cv.getContext('2d').fillRect(0, 0, cv.width, cv.height);
      const frame = new VideoFrame(cv, { timestamp: 0 });
      enc.encode(frame, { keyFrame: true });
      frame.close();
      await Promise.race([enc.flush(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500))]);
    } catch {
      failed = true;
    } finally {
      try {
        if (enc.state !== 'closed') enc.close();
      } catch {
        /* ignore */
      }
    }
    return ok && !failed;
  }

  async _pickAudioConfig(audioTrack) {
    if (!audioTrack || !('AudioEncoder' in window) || !('MediaStreamTrackProcessor' in window)) return null;
    const s = audioTrack.getSettings?.() ?? {};
    const sampleRate = s.sampleRate || 48000;
    const numberOfChannels = Math.min(2, s.channelCount || 1);
    // AAC first (plays everywhere); Opus-in-MP4 if AAC encoding isn't available.
    for (const [codec, muxCodec] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
      const config = { codec, sampleRate, numberOfChannels, bitrate: AUDIO_BITRATE };
      try {
        if ((await AudioEncoder.isConfigSupported(config)).supported) return { config, muxCodec };
      } catch {
        /* try next */
      }
    }
    return null;
  }

  async _startWebCodecs(audioTrack, fps) {
    const videoConfig = await this._pickVideoConfig();
    if (!videoConfig) throw new Error('the phone\'s H.264 encoder refused every size/profile tried');
    const audio = await this._pickAudioConfig(audioTrack);
    this.width = videoConfig.width;
    this.height = videoConfig.height;

    this.target = new ArrayBufferTarget();
    this.muxer = new Muxer({
      target: this.target,
      video: { codec: 'avc', width: this.width, height: this.height, frameRate: fps },
      audio: audio
        ? { codec: audio.muxCodec, sampleRate: audio.config.sampleRate, numberOfChannels: audio.config.numberOfChannels }
        : undefined,
      fastStart: 'in-memory', // moov atom first: plays/streams everywhere
      firstTimestampBehavior: 'offset',
    });

    this._failed = false;
    this.videoEncoder = new VideoEncoder({
      output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
      error: (err) => this._fail(err),
    });
    this.videoEncoder.configure(videoConfig);

    // Frames are copied to an even-sized 2D canvas (H.264 needs even sizes).
    this.frameCanvas = document.createElement('canvas');
    this.frameCanvas.width = this.width;
    this.frameCanvas.height = this.height;
    this.frameCtx = this.frameCanvas.getContext('2d', { alpha: false });

    if (audio) {
      this.audioEncoder = new AudioEncoder({
        output: (chunk, meta) => this.muxer.addAudioChunk(chunk, meta),
        error: (err) => console.warn('Audio encoder error (video continues)', err),
      });
      this.audioEncoder.configure(audio.config);
      // Clone so stopping the recorder never kills the live mic track.
      this._audioTrack = audioTrack.clone();
      const processor = new MediaStreamTrackProcessor({ track: this._audioTrack });
      this._audioReader = processor.readable.getReader();
      this._pumpAudio();
    }

    this.mode = 'webcodecs';
    this._type = 'video/mp4';
    this._frameCount = 0;
    this._lastFrameAt = -Infinity;
    this.startedAt = performance.now();
    this._recording = true;
  }

  async _pumpAudio() {
    const reader = this._audioReader;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this._recording && this.audioEncoder?.state === 'configured') this.audioEncoder.encode(value);
        value.close();
      }
    } catch {
      /* reader cancelled */
    }
  }

  _fail(err) {
    console.error('Video encoder error', err);
    this._failed = true;
  }

  async _stopWebCodecs() {
    try {
      await this._audioReader?.cancel();
    } catch {
      /* ignore */
    }
    this._audioTrack?.stop();
    try {
      if (this.videoEncoder?.state === 'configured') await this.videoEncoder.flush();
      if (this.audioEncoder?.state === 'configured') await this.audioEncoder.flush();
      this.muxer.finalize();
      const blob = new Blob([this.target.buffer], { type: 'video/mp4' });
      return this._frameCount > 0 && !this._failed ? blob : null;
    } finally {
      this._cleanupWebCodecs();
    }
  }

  _cleanupWebCodecs() {
    for (const enc of [this.videoEncoder, this.audioEncoder]) {
      try {
        if (enc && enc.state !== 'closed') enc.close();
      } catch {
        /* ignore */
      }
    }
    this.videoEncoder = this.audioEncoder = null;
    this._audioReader = null;
    this._audioTrack = null;
    this.muxer = this.target = null;
  }

  /* ----------------------------- MediaRecorder ----------------------------- */

  _startMediaRecorder(audioTrack, fps) {
    if (!window.MediaRecorder) throw new Error('Video recording is not supported in this browser.');
    const stream = this.canvas.captureStream(fps);
    if (audioTrack) stream.addTrack(audioTrack.clone());
    this.stream = stream;
    this.chunks = [];
    const mimeType = pickType(MEDIARECORDER_MP4) || pickType(MEDIARECORDER_WEBM);
    const opts = { videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE };
    if (mimeType) opts.mimeType = mimeType;
    this.mediaRecorder = new MediaRecorder(stream, opts);
    this.mediaRecorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.mediaRecorder.start(250);
    this.mode = 'mediarecorder';
    this._type = this.mediaRecorder.mimeType || mimeType || 'video/webm';
    this.startedAt = performance.now();
    this._recording = true;
  }

  _stopMediaRecorder() {
    return new Promise((resolve) => {
      const rec = this.mediaRecorder;
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: this._type });
        this.stream.getTracks().forEach((t) => t.stop());
        this.mediaRecorder = null;
        resolve(blob);
      };
      rec.stop();
    });
  }
}
