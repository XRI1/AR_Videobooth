// CPU-simulated particle fireworks rendered as glowing additive points.
// Two pools: BACK (behind the person, layer 1) and FRONT (in front, layer 2).

import * as THREE from 'three';

const vert = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aAlpha;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uScale / -mv.z, 0.0, 96.0);
    gl_Position = projectionMatrix * mv;
    vColor = aColor;
    vAlpha = aAlpha;
  }
`;
const frag = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d2 = dot(c, c) * 4.0;
    if (d2 > 1.0) discard;
    float core = exp(-d2 * 12.0);
    float glow = exp(-d2 * 3.5) * 0.6;
    float a = (core + glow) * vAlpha;
    gl_FragColor = vec4(mix(vColor, vec3(1.0), core * 0.7), a);
  }
`;

class ParticlePool {
  constructor(max) {
    this.max = max;
    this.cursor = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.baseSize = new Float32Array(max);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max); // 0 = dead
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.flicker = new Float32Array(max);

    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aColor', this.aCol);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aAlpha', this.aAlpha);

    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { uScale: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  spawn(p, v, color, size, life, drag, grav, flicker = 0) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const j = i * 3;
    this.pos[j] = p.x; this.pos[j + 1] = p.y; this.pos[j + 2] = p.z;
    this.vel[j] = v.x; this.vel[j + 1] = v.y; this.vel[j + 2] = v.z;
    this.col[j] = color.r; this.col[j + 1] = color.g; this.col[j + 2] = color.b;
    this.baseSize[i] = size;
    this.age[i] = 0;
    this.life[i] = life;
    this.drag[i] = drag;
    this.grav[i] = grav;
    this.flicker[i] = flicker;
  }

  update(dt, time) {
    for (let i = 0; i < this.max; i++) {
      const life = this.life[i];
      if (life <= 0) continue;
      const age = (this.age[i] += dt);
      if (age >= life) {
        this.life[i] = 0;
        this.alpha[i] = 0;
        this.size[i] = 0;
        continue;
      }
      const j = i * 3;
      const damp = Math.exp(-this.drag[i] * dt);
      this.vel[j] *= damp;
      this.vel[j + 1] = this.vel[j + 1] * damp - this.grav[i] * dt;
      this.vel[j + 2] *= damp;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;

      const t = age / life;
      let a = Math.pow(1 - t, 1.3);
      if (this.flicker[i] > 0 && t > 0.35) {
        a *= 0.35 + 0.65 * (Math.sin(time * 55 + i * 12.9898) > 0 ? 1 : 0.25);
      }
      this.alpha[i] = a;
      this.size[i] = this.baseSize[i] * (1 - t * 0.5);
    }
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aAlpha.needsUpdate = true;
  }
}

const PALETTES = [
  ['#ffd36b', '#fff4d0', '#ffb347'], // gold
  ['#5aa9ff', '#d6ecff', '#ffffff'], // blue / white
  ['#ff5fa2', '#ffd1e6', '#ffd36b'], // pink / gold
  ['#7dffb0', '#e6fff0', '#ffd36b'], // green / gold
  ['#c38bff', '#f0e2ff', '#5aa9ff'], // violet
];
// Custom shaders output raw values, so keep colours in sRGB (not linear).
const srgb = (h) => new THREE.Color(h).convertLinearToSRGB();
const PAL = PALETTES.map((p) => p.map(srgb));
const GOLD = ['#ffd36b', '#ffae42', '#fff2c9'].map(srgb);

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const _p = new THREE.Vector3();
const _v = new THREE.Vector3();

function randomUnit(out) {
  const u = Math.random() * 2 - 1;
  const th = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - u * u);
  return out.set(r * Math.cos(th), u, r * Math.sin(th));
}

export class FireworksFX {
  constructor(scene) {
    this.back = new ParticlePool(6000);
    this.front = new ParticlePool(3000);
    this.back.points.layers.set(1);
    this.front.points.layers.set(2);
    scene.add(this.back.points, this.front.points);
    this.rockets = [];
    this.nextLaunch = 0.4;
    this.fountainAcc = 0;
    this.time = 0;
  }

  setPointScale(s) {
    this.back.material.uniforms.uScale.value = s;
    this.front.material.uniforms.uScale.value = s;
  }

  /** Camera frustum info so launches land inside the visible frame. */
  setView(tanHalfFov, aspect) {
    this.tanHalf = tanHalfFov;
    this.aspect = aspect;
  }

  launch(anchor, delay = 0) {
    const { hip, S } = anchor;
    const z = hip.z - rand(1.2, 3.5) * S;
    // visible half-extents at that depth (camera at origin looking down -Z)
    const halfH = -z * (this.tanHalf ?? 0.41);
    const halfW = halfH * (this.aspect ?? 0.5);
    const start = new THREE.Vector3(rand(-0.85, 0.85) * halfW, Math.min(hip.y - 1.6 * S, -halfH), z);
    const apex = rand(0.1, 0.75) * halfH;
    const g = 3.2 * S;
    const vy = Math.sqrt(2 * g * (apex - start.y));
    this.rockets.push({
      pos: start,
      vel: new THREE.Vector3(rand(-0.25, 0.25) * S, vy, 0),
      g,
      fuse: vy / g,
      t: -delay,
      S: S * (z / hip.z), // farther shells are bigger so they read on screen
    });
  }

  burst(pool, pos, S, palette = pick(PAL)) {
    const type = Math.random();
    const count = (rand(120, 180)) | 0;
    const speed = rand(1.3, 1.9) * S;
    // random plane for ring-shaped bursts
    const axis = randomUnit(new THREE.Vector3());
    const t1 = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 1, 0.3)).normalize();
    const t2 = new THREE.Vector3().crossVectors(axis, t1).normalize();
    for (let i = 0; i < count; i++) {
      if (type < 0.2) {
        // ring
        const a = (i / count) * Math.PI * 2;
        _v.copy(t1).multiplyScalar(Math.cos(a)).addScaledVector(t2, Math.sin(a)).multiplyScalar(speed);
      } else if (type < 0.4) {
        // willow: slow, long, golden, droopy
        randomUnit(_v).multiplyScalar(speed * rand(0.55, 0.8));
      } else {
        // peony / chrysanthemum shell
        randomUnit(_v).multiplyScalar(speed * rand(0.85, 1.0));
      }
      const willow = type >= 0.2 && type < 0.4;
      const color = willow ? pick(GOLD) : pick(palette);
      pool.spawn(
        pos,
        _v,
        color,
        S * (willow ? 0.05 : 0.065),
        willow ? rand(2.2, 3.0) : rand(1.2, 1.9),
        willow ? 1.6 : 1.3,
        willow ? 1.2 * S : 0.8 * S,
        Math.random() < 0.6 ? 1 : 0,
      );
    }
    // bright flash at the centre
    pool.spawn(pos, _v.set(0, 0, 0), srgb('#ffffff'), S * 0.6, 0.18, 0, 0, 0);
  }

  /** Big celebratory salvo (button press). */
  salvo(anchor) {
    for (let i = 0; i < 5; i++) this.launch(anchor, i * 0.18);
  }

  update(dt, anchor, opts) {
    this.time += dt;
    const { hip, S, feetY } = anchor;

    if (opts.fireworks) {
      this.nextLaunch -= dt;
      if (this.nextLaunch <= 0) {
        this.launch(anchor);
        if (Math.random() < 0.3) this.launch(anchor, 0.15);
        this.nextLaunch = rand(0.6, 1.6);
      }
    }

    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.t += dt;
      if (r.t < 0) continue;
      r.vel.y -= r.g * dt;
      r.pos.addScaledVector(r.vel, dt);
      // sparkly trail
      for (let k = 0; k < 2; k++) {
        _v.set(rand(-0.15, 0.15) * r.S, rand(-0.4, -0.1) * r.S, rand(-0.15, 0.15) * r.S);
        this.back.spawn(r.pos, _v, pick(GOLD), r.S * 0.035, rand(0.35, 0.6), 2, 0.5 * r.S, 1);
      }
      if (r.t >= r.fuse) {
        this.burst(this.back, r.pos, r.S);
        this.rockets.splice(i, 1);
      }
    }

    if (opts.fountains) {
      this.fountainAcc += dt * 260;
      const n = this.fountainAcc | 0;
      this.fountainAcc -= n;
      for (let i = 0; i < n; i++) {
        const side = i % 2 ? 1 : -1;
        _p.set(hip.x + side * 1.3 * S, feetY, hip.z + 0.9 * S);
        _v.set(rand(-0.45, 0.45) * S, rand(2.4, 3.6) * S, rand(-0.45, 0.45) * S);
        this.front.spawn(_p, _v, pick(GOLD), S * rand(0.025, 0.045), rand(0.6, 1.1), 0.5, 4.2 * S, 1);
      }
    }

    this.back.update(dt, this.time);
    this.front.update(dt, this.time);
  }
}
