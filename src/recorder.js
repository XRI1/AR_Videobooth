// Records the composited AR canvas (plus optional mic audio) to a video file.
//
// MP4 is the goal, because every phone, gallery and messaging app plays it.
// Ways to get there, best first:
//   1. WebCodecs H.264 (hardware) + mp4-muxer -> standard MP4.
//   2. WebCodecs VP9 (software, no hardware needed) + mp4-muxer -> MP4 file
//      with VP9 video. For phones whose H.264 encoder is missing or broken.
//   3. MediaRecorder with native MP4 (Safari / iOS, Chrome 126+).
//   4. MediaRecorder WebM, as a last resort.
// Each WebCodecs setup is test-encoded before use, and if an encoder stalls
// or fails during a take the recording switches to the next way on the fly,
// so a take is never lost and saving never hangs.

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

// Encoder setups, tried in order. H.264: High, Main, Baseline (level 4.0 covers
// 1080x1920, 5.1 larger, 3.1 is the most widely supported for 720p).
// VP9 profile 0: software encoded, so kept to a smaller size to stay real-time.
const PIPELINES = [
  {
    name: 'H.264',
    muxCodec: 'avc',
    codecs: ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.640033', 'avc1.42e033', 'avc1.42001f', 'avc1.4d001f'],
    // Longest edge to try. Many Android hardware encoders reject the exact
    // screen size (e.g. 1080x2400 or sizes not a multiple of 16) but accept a
    // slightly smaller, 16-aligned one. 0 = the canvas size itself.
    sizes: [0, 1920, 1600, 1280, 960],
    extras: [{ hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime' }, { latencyMode: 'realtime' }, {}],
    bitrate: 10_000_000,
    avc: true,
  },
  {
    name: 'VP9',
    muxCodec: 'vp9',
    codecs: ['vp09.00.31.08', 'vp09.00.21.08', 'vp09.00.10.08'],
    sizes: [1280, 960, 720],
    extras: [{ latencyMode: 'realtime' }, {}],
    bitrate: 6_000_000,
    avc: false,
  },
];
const AUDIO_BITRATE = 128_000;
const KEYFRAME_SECONDS = 2;
const STALL_MS = 1500; // encoder gave no output this long after it started -> switch
const STOP_TIMEOUT_MS = 5000; // never wait longer than this for an encoder/recorder to finish

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
const align16 = (n) => Math.max(16, Math.floor(n / 16) * 16);
const pickType = (list) => list.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
/** Resolve with `p`, or with undefined after `ms` (so a stuck encoder can't hang saving). */
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
const hasWebCodecs = () => 'VideoEncoder' in window && 'VideoFrame' in window;

export class Recorder {
  constructor(canvas) {
    this.canvas = canvas;
    this.mode = null; // 'webcodecs' | 'mediarecorder'
    this.startedAt = 0;
    this._recording = false;
    this.fallbackReason = ''; // why the preferred way wasn't used (shown if the result is WebM)
    this.via = ''; // what made the current/last take: 'H.264', 'VP9' or 'MediaRecorder'
    this._configCache = new Map(); // pipeline + canvas size -> working encoder config (or null)
    this._broken = new Set(); // pipelines that stalled/failed this session: skipped from now on
    this.onFallback = null; // (reason) => void, called if a take switches recorder mid-way
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

  /** Find a working encoder setup ahead of time, so pressing record starts instantly. */
  prepare(fps = 30) {
    this.fps = fps;
    if (!hasWebCodecs()) return;
    (async () => {
      for (const p of PIPELINES) if (await this._pickVideoConfig(p)) return;
    })().catch(() => {});
  }

  /** Start recording. Uses the best available way to get an MP4. */
  async start(audioTrack = null, fps = 30) {
    if (this._recording) return;
    this.fps = fps;
    this.fallbackReason = '';
    this._audioSrc = audioTrack;
    this.startedAt = performance.now();
    if (!hasWebCodecs()) this.fallbackReason = 'this browser has no WebCodecs video encoder';
    else if (await this._startNextPipeline(0)) return;
    this._startMediaRecorderSafe(audioTrack, fps);
  }

  /**
   * Call right after each frame is drawn (same task, while the canvas still
   * holds the frame). Only used by the WebCodecs path.
   */
  captureFrame() {
    if (!this._recording || this.mode !== 'webcodecs') return;
    const now = performance.now();
    // Encoder failed, or stalled (no output at all) since it started: switch
    // to the next way now instead of producing an empty / never-finishing file.
    const stalled = this._outputCount === 0 && this._frameCount > 0 && now - this._segmentStart > STALL_MS;
    if (stalled || (this._failed && this._outputCount === 0)) {
      this._switch(`the ${this.via} encoder ${this._failed ? 'failed' : 'stalled'}`);
      return;
    }
    if (this._failed) return; // broke after producing video: keep what we have
    if (now - this._lastFrameAt < 1000 / this.fps - 4) return; // keep ~fps
    if (this.videoEncoder.encodeQueueSize > 3) return; // encoder busy: drop a frame
    this._lastFrameAt = now;
    this.frameCtx.drawImage(this.canvas, 0, 0, this.width, this.height);
    const frame = new VideoFrame(this.frameCanvas, { timestamp: Math.round((now - this._segmentStart) * 1000) });
    const keyFrame = this._frameCount % Math.round(this.fps * KEYFRAME_SECONDS) === 0;
    this._frameCount++;
    try {
      this.videoEncoder.encode(frame, { keyFrame });
    } catch (err) {
      this._fail(err);
    } finally {
      frame.close();
    }
  }

  /** Stop and return the finished video Blob (or null if nothing was captured). */
  async stop() {
    if (!this._recording) return null;
    this._recording = false;
    return this.mode === 'webcodecs' ? this._stopWebCodecs() : this._stopMediaRecorder();
  }

  /* --------------------------- WebCodecs -> MP4 --------------------------- */

  /** Start the first working pipeline from index `from` on. True if recording. */
  async _startNextPipeline(from) {
    for (let i = from; i < PIPELINES.length; i++) {
      const p = PIPELINES[i];
      if (this._broken.has(p.name)) continue;
      try {
        await this._startWebCodecs(p, i);
        return true;
      } catch (err) {
        console.warn(`${p.name} MP4 recording unavailable`, err);
        this.fallbackReason = err.message || String(err);
        this._cleanupWebCodecs();
      }
    }
    return false;
  }

  /** Candidate output sizes for a pipeline: same aspect as the canvas, 16-aligned. */
  _candidateSizes(p) {
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
    for (const edge of p.sizes) {
      if (!edge) add(even(cw), even(ch));
      const k = edge ? Math.min(1, edge / Math.max(cw, ch)) : 1;
      add(align16(cw * k), align16(ch * k));
    }
    return out;
  }

  /**
   * Find an encoder config for pipeline `p` that really works on this device:
   * isConfigSupported() first, then a test encode of one frame (some Android
   * encoders claim support and then fail on the first frame).
   */
  async _pickVideoConfig(p) {
    const cacheKey = `${p.name}:${this.canvas.width}x${this.canvas.height}@${this.fps}`;
    if (this._configCache.has(cacheKey)) return this._configCache.get(cacheKey);
    let found = null;
    search: for (const size of this._candidateSizes(p)) {
      for (const codec of p.codecs) {
        for (const extra of p.extras) {
          const config = { codec, ...size, bitrate: p.bitrate, framerate: this.fps ?? 30, ...extra };
          if (p.avc) config.avc = { format: 'avc' };
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

  async _startWebCodecs(p, index) {
    const videoConfig = await this._pickVideoConfig(p);
    if (!videoConfig) throw new Error(`the phone's ${p.name} encoder refused every size/profile tried`);
    const audio = await this._pickAudioConfig(this._audioSrc);
    this.width = videoConfig.width;
    this.height = videoConfig.height;

    this.target = new ArrayBufferTarget();
    this.muxer = new Muxer({
      target: this.target,
      video: { codec: p.muxCodec, width: this.width, height: this.height, frameRate: this.fps },
      audio: audio
        ? { codec: audio.muxCodec, sampleRate: audio.config.sampleRate, numberOfChannels: audio.config.numberOfChannels }
        : undefined,
      fastStart: 'in-memory', // moov atom first: plays/streams everywhere
      firstTimestampBehavior: 'offset',
    });

    this._failed = false;
    this._outputCount = 0;
    this.videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        this._outputCount++;
        this.muxer.addVideoChunk(chunk, meta);
      },
      error: (err) => this._fail(err),
    });
    this.videoEncoder.configure(videoConfig);

    // Frames are copied to an even-sized 2D canvas (encoders need even sizes).
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
      this._audioTrack = this._audioSrc.clone();
      const processor = new MediaStreamTrackProcessor({ track: this._audioTrack });
      this._audioReader = processor.readable.getReader();
      this._pumpAudio();
    }

    this.mode = 'webcodecs';
    this.via = p.name;
    this._pipelineIndex = index;
    this._type = 'video/mp4';
    this._frameCount = 0;
    this._lastFrameAt = -Infinity;
    this._segmentStart = performance.now();
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

  /**
   * Mid-take switch: the current encoder is broken, so mark it and continue
   * the take (from now on) with the next pipeline, or MediaRecorder.
   */
  _switch(reason) {
    if (this._switching) return;
    this._switching = true;
    console.warn(`Switching recorder: ${reason}`);
    this._broken.add(this.via);
    this.fallbackReason = `${reason} on this phone`;
    this._stopAudioPump();
    this._cleanupWebCodecs();
    this._recording = false;
    (async () => {
      try {
        if (!(await this._startNextPipeline(this._pipelineIndex + 1))) this._startMediaRecorderSafe(this._audioSrc, this.fps);
        this.onFallback?.(`${reason}, now using ${this.via}`);
      } catch (err) {
        console.error(err);
      } finally {
        this._switching = false;
      }
    })();
  }

  _stopAudioPump() {
    try {
      this._audioReader?.cancel();
    } catch {
      /* ignore */
    }
    this._audioTrack?.stop();
  }

  async _stopWebCodecs() {
    await withTimeout(this._audioReader?.cancel().catch(() => {}), 1000);
    this._audioTrack?.stop();
    try {
      // time-limited: a stuck encoder must never hang "Saving video..."
      if (this.videoEncoder?.state === 'configured') await withTimeout(this.videoEncoder.flush().catch(() => {}), STOP_TIMEOUT_MS);
      if (this.audioEncoder?.state === 'configured') await withTimeout(this.audioEncoder.flush().catch(() => {}), STOP_TIMEOUT_MS);
      if (!this._outputCount) {
        this._broken.add(this.via); // produced nothing: use the next way next time
        return null;
      }
      this.muxer.finalize(); // keeps everything encoded so far, even after an encoder error
      return new Blob([this.target.buffer], { type: 'video/mp4' });
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

  /** MediaRecorder MP4 if possible, else WebM; if MP4 fails to start, WebM. */
  _startMediaRecorderSafe(audioTrack, fps) {
    // MediaRecorder MP4 uses the same H.264 encoder underneath: skip it if that broke
    const mp4 = this._broken.has('H.264') ? '' : pickType(MEDIARECORDER_MP4);
    const tries = [mp4, pickType(MEDIARECORDER_WEBM), ''].filter((t, i, a) => (t || i === a.length - 1) && a.indexOf(t) === i);
    let lastErr;
    for (const type of tries) {
      try {
        this._startMediaRecorder(audioTrack, fps, type);
        return;
      } catch (err) {
        lastErr = err;
        console.warn(`MediaRecorder ${type || '(default)'} failed`, err);
      }
    }
    throw lastErr ?? new Error('Video recording is not supported in this browser.');
  }

  _startMediaRecorder(audioTrack, fps, mimeType) {
    if (!window.MediaRecorder) throw new Error('Video recording is not supported in this browser.');
    const stream = this.canvas.captureStream(fps);
    if (audioTrack) stream.addTrack(audioTrack.clone());
    const opts = { videoBitsPerSecond: 10_000_000, audioBitsPerSecond: AUDIO_BITRATE };
    if (mimeType) opts.mimeType = mimeType;
    let rec;
    try {
      rec = new MediaRecorder(stream, opts);
      this.chunks = [];
      rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
      rec.start(250);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      throw err;
    }
    this.stream = stream;
    this.mediaRecorder = rec;
    this.mode = 'mediarecorder';
    this.via = 'MediaRecorder';
    this._type = rec.mimeType || mimeType || 'video/webm';
    this._recording = true;
  }

  _stopMediaRecorder() {
    return new Promise((resolve) => {
      const rec = this.mediaRecorder;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const blob = new Blob(this.chunks, { type: this._type });
        this.stream?.getTracks().forEach((t) => t.stop());
        this.mediaRecorder = null;
        resolve(blob);
      };
      rec.onstop = finish;
      setTimeout(finish, STOP_TIMEOUT_MS); // never hang if 'stop' doesn't fire
      try {
        rec.stop();
      } catch {
        finish();
      }
    });
  }
}
