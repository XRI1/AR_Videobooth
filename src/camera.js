// Camera capture: wraps getUserMedia and exposes a playing <video> element.

export class Camera {
  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('muted', '');
    this.stream = null;
    this.facing = 'environment';
  }

  get mirrored() {
    return this.facing === 'user';
  }

  get audioTrack() {
    return this.stream?.getAudioTracks()[0] ?? null;
  }

  async start(facing = this.facing, withAudio = true) {
    this.stop();
    const video = {
      facingMode: { ideal: facing },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: withAudio });
    } catch (err) {
      if (!withAudio) throw err;
      // Mic denied or unavailable: keep going without audio.
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    }
    this.stream = stream;
    this.facing = facing;
    this.video.srcObject = stream;
    await new Promise((resolve) => {
      if (this.video.readyState >= 1) resolve();
      else this.video.onloadedmetadata = () => resolve();
    });
    await this.video.play();
  }

  /** Use a local video file as the "camera" (desktop testing / pre-shot footage). */
  async startFromFile(file) {
    this.stop();
    this.facing = 'file';
    this.video.srcObject = null;
    this.video.src = URL.createObjectURL(file);
    this.video.loop = true;
    await new Promise((resolve, reject) => {
      this.video.onloadedmetadata = () => resolve();
      this.video.onerror = () => reject(new Error('Unsupported video file'));
    });
    await this.video.play();
  }

  async flip(withAudio) {
    await this.start(this.facing === 'user' ? 'environment' : 'user', withAudio);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
