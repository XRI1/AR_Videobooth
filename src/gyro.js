// Device-orientation tracking.
//  - `enabled` (the 360° button): the orbit rings stay locked to the real
//    world as the phone orbits the person, and ring tilt follows camera pitch.
//  - `yaw`/`pitch` are also used by the Lock button to keep locked content
//    facing a fixed direction in the room while the phone orbits the person.

const DEG = Math.PI / 180;

export class Gyro {
  constructor() {
    this.enabled = false; // 360° feature on/off
    this.listening = false; // sensor subscribed (needed by 360° and Lock)
    this.available = false; // at least one real reading arrived
    this.yaw = 0; // unwrapped heading change since reset (rad, CCW positive)
    this.pitch = 0; // camera pitch (rad, up positive)
    this._lastHeading = null;
    this._onOrientation = this._onOrientation.bind(this);
  }

  /** Subscribe to the motion sensor (asks permission on iOS; call from a tap). */
  async listen() {
    if (this.listening) return;
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) throw new Error('Device orientation is not supported on this device.');
    // iOS 13+ needs an explicit permission prompt from a user gesture.
    if (typeof DOE.requestPermission === 'function') {
      const res = await DOE.requestPermission();
      if (res !== 'granted') throw new Error('Motion permission was denied.');
    }
    window.addEventListener('deviceorientation', this._onOrientation);
    this.listening = true;
  }

  async enable() {
    await this.listen();
    this.enabled = true;
    this.reset();
  }

  disable() {
    this.enabled = false;
    this.yaw = 0;
    this.pitch = 0;
  }

  reset() {
    this.yaw = 0;
    this._lastHeading = null;
  }

  _onOrientation(e) {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    this.available = true;
    const a = e.alpha * DEG, b = e.beta * DEG, g = e.gamma * DEG;

    const cA = Math.cos(a), sA = Math.sin(a);
    const cB = Math.cos(b), sB = Math.sin(b);
    const cG = Math.cos(g), sG = Math.sin(g);

    // Direction the back camera looks at (-Z of device) in the earth frame
    // (x east, y north, z up), from R = Rz(alpha)·Rx(beta)·Ry(gamma).
    // Using the full rotation avoids the gimbal-lock issues of raw alpha
    // when the phone is held upright.
    const fx = -cA * sG - sA * sB * cG;
    const fy = -sA * sG + cA * sB * cG;
    const fz = -cB * cG;

    this.pitch = Math.asin(Math.max(-1, Math.min(1, fz)));
    const horiz = Math.hypot(fx, fy);
    if (horiz < 0.2) return; // pointing straight up/down: heading unreliable

    const heading = Math.atan2(fy, fx);
    if (this._lastHeading !== null) {
      let d = heading - this._lastHeading;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      this.yaw += d;
    }
    this._lastHeading = heading;
  }
}
