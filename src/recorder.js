// Records the composited AR canvas (plus optional mic audio) to a video file.

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export class Recorder {
  constructor(canvas) {
    this.canvas = canvas;
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
    this.mimeType = MIME_CANDIDATES.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
  }

  get isRecording() {
    return this.recorder?.state === 'recording';
  }

  get elapsed() {
    return this.isRecording ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  get extension() {
    return this.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  }

  start(audioTrack = null, fps = 30) {
    if (!window.MediaRecorder) throw new Error('Video recording is not supported in this browser.');
    const stream = this.canvas.captureStream(fps);
    // Clone so stopping the recorder never kills the live mic track.
    if (audioTrack) stream.addTrack(audioTrack.clone());
    this.stream = stream;
    this.chunks = [];
    const opts = { videoBitsPerSecond: 10_000_000, audioBitsPerSecond: 128_000 };
    if (this.mimeType) opts.mimeType = this.mimeType;
    this.recorder = new MediaRecorder(stream, opts);
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start(250);
    this.startedAt = performance.now();
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.recorder) return resolve(null);
      this.recorder.onstop = () => {
        const type = this.recorder.mimeType || this.mimeType || 'video/webm';
        const blob = new Blob(this.chunks, { type });
        this.stream.getTracks().forEach((t) => t.stop());
        this.recorder = null;
        resolve(blob);
      };
      this.recorder.stop();
    });
  }
}
