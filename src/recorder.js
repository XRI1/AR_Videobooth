// Records the composited AR canvas (plus optional mic audio) to a video file.
//
// MP4 is the goal, because every phone, gallery and messaging app plays it.
// Ways to get there, best first:
//   1. WebCodecs H.264 (hardware) + mp4-muxer -> standard MP4.
//   2. For phones whose hardware H.264 encoder is broken: record smoothly with
//      WebCodecs VP9, then after the take convert it to H.264 with a software
//      (WebAssembly) encoder in a worker (public/h264-worker.js), see
//      convertToH264(). Converting after the take, with nothing else running,
//      keeps every frame, so the video is smooth and still a standard H.264 MP4
//      that WhatsApp and every gallery accept.
//   3. Live software H.264 (same worker) if VP9 isn't available either.
//   4. MediaRecorder with native MP4 (Safari / iOS, Chrome 126+).
//   5. MediaRecorder WebM, as a last resort.
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
    convert: true, // converted to H.264 after the take (WhatsApp needs H.264)
  },
  {
    name: 'H.264 (software)',
    kind: 'wasm',
    sizes: [1280], // longest edge; a software encoder must keep up live on a phone
    kbps: 5000,
  },
];
const CONVERT_KBPS = 4000; // H.264 bitrate for the after-take conversion
// Converted video size (long edge). WhatsApp shrinks videos to ~850 px anyway,
// and a smaller size converts about twice as fast on a phone.
const CONVERT_LONG_EDGE = 960;
const AUDIO_BITRATE = 128_000;
const KEYFRAME_SECONDS = 2;
const STALL_MS = 1500; // encoder gave no output this long after it started -> switch
const STOP_TIMEOUT_MS = 5000; // never wait longer than this for an encoder/recorder to finish
const WASM_READY_MS = 10000; // software encoder: time allowed to load + compile
const WASM_FINISH_MS = 20000; // software encoder: time allowed to finish the file
const WASM_STALL_MS = 3000; // software encoder: no progress this long -> switch
const hasWasmEncoder = () => 'Worker' in window && 'OffscreenCanvas' in window && typeof WebAssembly === 'object';

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
      for (const p of PIPELINES) {
        if (p.kind === 'wasm') {
          this._warmWasm(); // hardware H.264 unusable: load the software encoder now
          return;
        }
        if (await this._pickVideoConfig(p)) return;
      }
    })().catch(() => {});
  }

  /** Start recording. Uses the best available way to get an MP4. */
  async start(audioTrack = null, fps = 30) {
    if (this._recording) return;
    this.fps = fps;
    this.fallbackReason = '';
    this._toConvert = null; // only the newest take is ever converted
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
    if (!this._recording) return;
    if (this.mode === 'wasm') return this._captureWasm();
    if (this.mode !== 'webcodecs') return;
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
    if (this.mode === 'wasm') return this._stopWasm();
    return this.mode === 'webcodecs' ? this._stopWebCodecs() : this._stopMediaRecorder();
  }

  /* --------------------------- WebCodecs -> MP4 --------------------------- */

  /** Start the first working pipeline from index `from` on. True if recording. */
  async _startNextPipeline(from) {
    for (let i = from; i < PIPELINES.length; i++) {
      const p = PIPELINES[i];
      if (this._broken.has(p.name)) continue;
      try {
        if (p.kind === 'wasm') await this._startWasm(p, i);
        else await this._startWebCodecs(p, i);
        return true;
      } catch (err) {
        console.warn(`${p.name} MP4 recording unavailable`, err);
        this.fallbackReason = err.message || String(err);
        this._cleanupWebCodecs();
        this._cleanupWasm();
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
        if (this._keptChunks) {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          this._keptChunks.push({ type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration ?? undefined, data });
        }
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

    // VP9 takes are converted to H.264 afterwards: keep the encoded frames
    this._keptChunks = p.convert ? [] : null;
    this._keptConfig = p.convert ? { codec: videoConfig.codec, codedWidth: this.width, codedHeight: this.height } : null;
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
    this._cleanupWasm();
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
      if (this._keptChunks?.length) this._toConvert = { chunks: this._keptChunks, config: this._keptConfig };
      return new Blob([this.target.buffer], { type: 'video/mp4' });
    } finally {
      this._keptChunks = null;
      this._cleanupWebCodecs();
    }
  }

  /* ------------------- after-take conversion to H.264 ------------------- */

  /** True if the last take should be converted to H.264 (made with VP9). */
  get canConvertToH264() {
    return !!this._toConvert && hasWasmEncoder() && 'VideoDecoder' in window;
  }

  /**
   * Re-encode the last (VP9) take as an H.264 MP4: decode its frames with
   * WebCodecs and encode them with the software H.264 encoder in a worker,
   * one by one (no frames dropped). `onProgress(0..1)`.
   */
  async convertToH264(onProgress) {
    const job = this._toConvert;
    this._toConvert = null;
    if (!job) throw new Error('nothing to convert');
    const { chunks, config } = job;
    if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error(`${config.codec} decoding not supported`);

    const worker = new Worker(`${import.meta.env.BASE_URL}h264-worker.js`);
    let ack = null; // resolves when the worker has encoded the frame in flight
    let done = null;
    let workerError = null;
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ack' || m.type === 'ready') ack?.();
      else if (m.type === 'done') done?.(m);
      else if (m.type === 'error') {
        workerError = new Error(m.message);
        ack?.();
        done?.(null);
      }
    };
    worker.onerror = (e) => {
      workerError = new Error(e.message || 'encoder worker failed');
      ack?.();
      done?.(null);
    };
    const waitAck = () => new Promise((r) => (ack = r));
    try {
      // load + set up the encoder
      const k = Math.min(1, CONVERT_LONG_EDGE / Math.max(config.codedWidth, config.codedHeight));
      const outW = align16(config.codedWidth * k);
      const outH = align16(config.codedHeight * k);
      const ready = waitAck();
      worker.postMessage({ type: 'init', width: outW, height: outH, fps: this.fps ?? 30, kbps: CONVERT_KBPS });
      await withTimeout(ready, WASM_READY_MS);
      if (workerError) throw workerError;

      const canvas = new OffscreenCanvas(outW, outH);
      const ctx = canvas.getContext('2d', { alpha: false });
      const frames = [];
      let decodeError = null;
      const decoder = new VideoDecoder({ output: (f) => frames.push(f), error: (err) => (decodeError = err) });
      decoder.configure(config);
      const t0 = chunks[0].timestamp;
      let sent = 0;
      // hand decoded frames to the encoder, waiting for each one (no drops)
      const drain = async () => {
        while (frames.length) {
          const f = frames.shift();
          ctx.drawImage(f, 0, 0, canvas.width, canvas.height);
          const t = (f.timestamp - t0) / 1000;
          f.close();
          const bitmap = canvas.transferToImageBitmap();
          const acked = waitAck();
          worker.postMessage({ type: 'frame', bitmap, t }, [bitmap]);
          await acked;
          if (workerError) throw workerError;
          sent++;
          onProgress?.(Math.min(0.99, sent / chunks.length));
        }
      };
      for (const c of chunks) {
        if (decodeError) throw decodeError;
        decoder.decode(new EncodedVideoChunk(c));
        // let the decoder catch up, then encode what it produced
        while (decoder.decodeQueueSize > 2) await new Promise((r) => setTimeout(r, 0));
        await drain();
      }
      await decoder.flush();
      await drain();
      decoder.close();
      if (!sent) throw new Error('no frames could be decoded');

      const result = await withTimeout(
        new Promise((r) => {
          done = r;
          worker.postMessage({ type: 'finish' });
        }),
        WASM_FINISH_MS,
      );
      if (workerError || !result?.buffer) throw workerError ?? new Error('the encoder did not finish');
      onProgress?.(1);
      this.via = 'VP9 → H.264';
      return new Blob([result.buffer], { type: 'video/mp4' });
    } finally {
      worker.terminate();
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

  /* ----------------------- H.264 in software (worker) ----------------------- */

  /** Start loading the software encoder in the background (no-op if already loaded). */
  _warmWasm() {
    if (this._wasmWorker || !hasWasmEncoder()) return;
    try {
      this._wasmWorker = new Worker(`${import.meta.env.BASE_URL}h264-worker.js`);
    } catch (err) {
      console.warn('Software H.264 encoder unavailable', err);
    }
  }

  async _startWasm(p, index) {
    if (!hasWasmEncoder()) throw new Error('no software encoder support (Worker/OffscreenCanvas)');
    this._warmWasm();
    const worker = this._wasmWorker;
    if (!worker) throw new Error('software H.264 encoder failed to load');
    const size = this._candidateSizes({ sizes: p.sizes })[0];
    this.width = size.width;
    this.height = size.height;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('software H.264 encoder took too long to load')), WASM_READY_MS);
      worker.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(e.message || 'software H.264 encoder failed to load'));
      };
      worker.onmessage = (e) => {
        if (e.data.type === 'ready') {
          clearTimeout(timer);
          resolve();
        } else if (e.data.type === 'error') {
          clearTimeout(timer);
          reject(new Error(e.data.message));
        }
      };
      worker.postMessage({ type: 'init', width: this.width, height: this.height, fps: this.fps, kbps: p.kbps });
    });
    this._failed = false;
    this._inFlight = 0;
    this._wasmAcks = 0;
    this._wasmSent = 0;
    worker.onerror = (e) => this._fail(e);
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ack') {
        this._inFlight--;
        this._wasmAcks++;
        this._lastAckAt = performance.now();
      } else if (m.type === 'error') this._fail(new Error(m.message));
      else if (m.type === 'done') this._wasmDone?.(m);
    };
    this.frameCanvas = new OffscreenCanvas(this.width, this.height);
    this.frameCtx = this.frameCanvas.getContext('2d', { alpha: false });
    this.mode = 'wasm';
    this.via = p.name;
    this._pipelineIndex = index;
    this._type = 'video/mp4';
    this._lastFrameAt = -Infinity;
    this._segmentStart = this._lastAckAt = performance.now();
    this._recording = true;
  }

  _captureWasm() {
    const now = performance.now();
    // broken before producing anything, or no progress for a while: next way
    const stuck = this._inFlight > 0 && now - this._lastAckAt > WASM_STALL_MS;
    if ((this._failed || stuck) && this._wasmAcks === 0) {
      this._switch(`the software H.264 encoder ${this._failed ? 'failed' : 'stalled'}`);
      return;
    }
    if (this._failed) return; // broke after producing video: keep what we have
    if (now - this._lastFrameAt < 1000 / this.fps - 4) return; // keep ~fps
    if (this._inFlight >= 2) return; // encoder busy: skip (the worker repeats frames to keep real speed)
    this._lastFrameAt = now;
    this.frameCtx.drawImage(this.canvas, 0, 0, this.width, this.height);
    const bitmap = this.frameCanvas.transferToImageBitmap();
    this._inFlight++;
    this._wasmSent++;
    this._wasmWorker.postMessage({ type: 'frame', bitmap, t: now - this._segmentStart }, [bitmap]);
  }

  async _stopWasm() {
    const worker = this._wasmWorker;
    try {
      if (!this._wasmAcks && !this._wasmSent) return null;
      const result = await withTimeout(
        new Promise((resolve) => {
          this._wasmDone = resolve;
          worker.postMessage({ type: 'finish' });
        }),
        WASM_FINISH_MS,
      );
      if (!result?.buffer || !result.frames) {
        this._broken.add(this.via);
        return null;
      }
      return new Blob([result.buffer], { type: 'video/mp4' });
    } finally {
      this._wasmDone = null;
      this._cleanupWasm(); // a fresh worker per take keeps memory low
    }
  }

  _cleanupWasm() {
    try {
      this._wasmWorker?.terminate();
    } catch {
      /* ignore */
    }
    this._wasmWorker = null;
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
