// Signal smoothing helpers.

/**
 * One Euro filter (Casiez et al., 2012): an adaptive low-pass filter that is
 * heavily smoothed when the signal is still (kills tracking jitter) and
 * lightly smoothed when it moves fast (keeps latency low).
 *   minCutoff: Hz of smoothing at rest (lower = steadier)
 *   beta:      how quickly smoothing relaxes with speed (higher = snappier)
 */
export class OneEuroFilter {
  constructor(minCutoff = 1, beta = 0.5, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }

  static _alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** @param value sample  @param t timestamp in seconds */
  filter(value, t) {
    if (this.x === null || this.t === null || t <= this.t) {
      this.x = value;
      this.t = t;
      return value;
    }
    const dt = t - this.t;
    this.t = t;
    const rawDx = (value - this.x) / dt;
    this.dx += OneEuroFilter._alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuroFilter._alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/** Frame-rate independent exponential approach factor for `rate` per second. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

/** Ease-out with a small overshoot: a soft "pop". */
export function easeOutBack(t, s = 1.4) {
  const u = t - 1;
  return 1 + u * u * ((s + 1) * u + s);
}
