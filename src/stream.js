// 3D object effect: glossy glass capsules, cubes and spheres (blue /
// lime-green, like a probiotic / data-flow visual) rise straight up out of the
// floor at spots all around the person and fade out between hip and chest
// height. They never move around the body.
//
// Everything is in torso units (scaled with the person by the scene) and uses
// the scene's clipping plane, so objects pass behind the body and come back
// in front, exactly like the 3D text.

import * as THREE from 'three';

const TAU = Math.PI * 2;
// Shaders output raw values, so keep colours in sRGB (not linear).
const srgb = (h) => new THREE.Color(h).convertLinearToSRGB();
const BLUE = srgb('#1557ff');
const CYAN = srgb('#36c8ff');
const LIME = srgb('#b6f01e');

/* ------------------------------ shader ------------------------------ */

// Glossy glass look: deep centre, bright fresnel rim, sharp highlights,
// optional glowing edges (cubes). Supports instancing + instance colours.
const glassVert = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_vertex>
  varying vec3 vN;
  varying vec3 vV;
  varying vec2 vUv;
  varying vec3 vBase;
  varying float vFade;
  attribute float aFade; // 0..1: fades the object out high up the stream
  void main() {
    vUv = uv;
    vFade = aFade;
    vec4 p = vec4(position, 1.0);
    vec3 n = normal;
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
      n = mat3(instanceMatrix) * n;
    #endif
    vec4 mvPosition = modelViewMatrix * p;
    vN = normalize(normalMatrix * n);
    vV = -mvPosition.xyz;
    #ifdef USE_INSTANCING_COLOR
      vBase = instanceColor;
    #else
      vBase = vec3(0.12, 0.42, 1.0);
    #endif
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }
`;
const glassFrag = /* glsl */ `
  #include <clipping_planes_pars_fragment>
  uniform float uEdges;
  varying vec3 vN;
  varying vec3 vV;
  varying vec2 vUv;
  varying vec3 vBase;
  varying float vFade;
  void main() {
    #include <clipping_planes_fragment>
    if (vFade < 0.01) discard;
    vec3 n = normalize(vN);
    vec3 v = normalize(vV);
    if (!gl_FrontFacing) n = -n;
    float ndv = clamp(dot(n, v), 0.0, 1.0);
    float fres = pow(1.0 - ndv, 1.8);
    vec3 deep = vBase * 0.55;
    vec3 bright = mix(vBase, vec3(0.7, 0.95, 1.0), 0.55);
    vec3 col = mix(deep, bright * 1.25, fres);
    // lit from inside, with faint inner bands ("liquid inside glass")
    col += vBase * (0.3 + 0.25 * smoothstep(0.5, 0.95, ndv) * (0.6 + 0.4 * sin(vUv.y * 18.0)));
    // two highlights
    vec3 L1 = normalize(vec3(0.45, 0.8, 0.55));
    vec3 L2 = normalize(vec3(-0.6, 0.25, 0.6));
    float spec = pow(max(dot(reflect(-L1, n), v), 0.0), 60.0) + 0.35 * pow(max(dot(reflect(-L2, n), v), 0.0), 18.0);
    // glowing edges (cubes)
    vec2 e = abs(vUv - 0.5);
    float edge = smoothstep(0.38, 0.49, max(e.x, e.y)) * uEdges;
    col += bright * edge * 1.3 + vec3(1.0) * spec;
    float alpha = clamp(0.78 + 0.22 * fres + 0.4 * edge + spec, 0.0, 1.0) * vFade;
    gl_FragColor = vec4(col, alpha);
  }
`;

/**
 * Glossy glass material (instanced meshes with per-instance colour and an
 * `aFade` instance attribute). `edges` = 1 adds glowing cube edges.
 */
export function createGlassMaterial(edges, clippingPlanes) {
  return new THREE.ShaderMaterial({
    vertexShader: glassVert,
    fragmentShader: glassFrag,
    uniforms: { uEdges: { value: edges } },
    transparent: true,
    side: THREE.DoubleSide,
    clipping: true,
    clippingPlanes,
  });
}
export const GLASS_COLORS = { BLUE, CYAN, LIME };

/* ------------------------------ motion ------------------------------ */

const rand = (a, b) => a + Math.random() * (b - a);
/** Rise height from the floor (torso units: hips ~1.8 up, chest ~2.4). */
export const STREAM_HEIGHT = 3.2;
const RADIUS_RANGE = [0.9, 1.08]; // spread of distances from the body axis (x radius)

/** Repeatable pseudo-random 0..1 from a number (new spot for every rise). */
function hash01(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);

/* ------------------------------ the effect ------------------------------ */

export class LightStream {
  /**
   * @param {object} o
   * @param {'capsules'|'cubes'|'both'} o.style
   * @param {number} o.radius  distance from the body axis (same as the 3D text)
   * @param {THREE.Plane[]} o.clippingPlanes
   */
  constructor({ style = 'both', radius = 1.3, clippingPlanes }) {
    // outer: placed on the floor under the person by the scene (never moves
    // around the body). Object positions are computed in outer space, so
    // fitting the circle to the frame never squashes their shape.
    this.outer = new THREE.Group();
    this.time = 0;
    this.fadeStart = 0.55;
    this.fadeEnd = 0.75;
    this.radius = radius;
    this.maxRadius = radius * RADIUS_RANGE[1];
    this.minRadius = radius * RADIUS_RANGE[0];
    this._materials = [];
    this._geometries = [];

    const glass = (edges) => {
      const m = createGlassMaterial(edges, clippingPlanes);
      this._materials.push(m);
      return m;
    };
    this.items = [];
    let seed = 0;
    const add = (geo, mat, count, kind, colorFn, sizeRange) => {
      if (!count) return;
      this._geometries.push(geo);
      // per-object fade (glass shader `aFade`)
      const fadeAttr = new THREE.InstancedBufferAttribute(new Float32Array(count).fill(1), 1);
      fadeAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aFade', fadeAttr);
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.userData.fade = fadeAttr;
      for (let i = 0; i < count; i++) {
        mesh.setColorAt(i, colorFn(i));
        this.items.push({
          mesh,
          index: i,
          kind,
          seed: ++seed * 7.31,
          s0: Math.random(),
          speed: rand(0.12, 0.2), // floor -> fade-out in ~4-7 s
          size: rand(sizeRange[0], sizeRange[1]),
          spin: new THREE.Vector3(rand(-0.8, 0.8), rand(-0.8, 0.8), rand(-0.8, 0.8)),
          phase: Math.random() * TAU,
        });
      }
      mesh.instanceColor.needsUpdate = true;
      this.outer.add(mesh);
    };

    const caps = style === 'cubes' ? 0 : style === 'capsules' ? 16 : 10;
    const cubes = style === 'capsules' ? 0 : style === 'cubes' ? 20 : 12;
    const blueish = () => (Math.random() < 0.5 ? BLUE : CYAN).clone().lerp(BLUE, 0.3);
    add(new THREE.CapsuleGeometry(0.075, 0.2, 6, 16), glass(0), caps, 'capsule', blueish, [0.52, 0.85]);
    add(
      new THREE.BoxGeometry(0.15, 0.15, 0.15),
      glass(1),
      cubes,
      'cube',
      (i) => (i % 2 ? LIME.clone() : blueish()),
      [0.45, 0.8],
    );
    add(
      new THREE.SphereGeometry(0.03, 14, 10),
      glass(0),
      36,
      'sphere',
      () => (Math.random() < 0.15 ? LIME.clone() : blueish()),
      [0.5, 1.2],
    );

    this.update(0);
  }

  /**
   * Fade window along the rise (0 = floor, 1 = STREAM_HEIGHT): fully visible
   * below `start`, gone above `end`.
   */
  setFade(start, end) {
    this.fadeStart = start;
    this.fadeEnd = Math.max(start + 0.02, end);
  }

  /**
   * Advance the animation. Objects rise straight up from the floor at a spot
   * around the person (a new random spot each time they rise again); they do
   * not move around the body.
   * @param {number} dt
   * @param {number} sx  side-to-side scale of the circle (fits the frame)
   * @param {number} sz  front/back scale of the circle (matches the text's distance)
   * @param {number} yaw  facing in the room (Lock)
   */
  update(dt, sx = 1, sz = 1, yaw = 0) {
    this.time += dt;
    const t = this.time;
    _qYaw.setFromAxisAngle(_up, yaw);
    const span = this.fadeEnd + 0.02; // objects only travel the visible part
    const sizeK = 0.7 + 0.3 * Math.min(1, sx, sz); // a bit smaller in a narrowed circle
    const dirty = new Set();
    for (const it of this.items) {
      const progress = it.s0 + t * it.speed;
      const rise = Math.floor(progress); // which rise this is (new spot each time)
      const s = (progress - rise) * span;
      // spot around the person for this rise: angle + distance from the body axis
      const angle = hash01(it.seed + rise * 1.37) * TAU;
      const r = this.radius * THREE.MathUtils.lerp(RADIUS_RANGE[0], RADIUS_RANGE[1], hash01(it.seed * 3.1 + rise));
      _p.set(Math.sin(angle) * r, s * STREAM_HEIGHT, Math.cos(angle) * r).applyQuaternion(_qYaw);
      _p.x *= sx;
      _p.z *= sz;
      // emerge from the floor (grow in), then fade out between hip and chest
      const emerge = THREE.MathUtils.smoothstep(s, 0, 0.06);
      const fadeOut = 1 - THREE.MathUtils.smoothstep(s, this.fadeStart, this.fadeEnd);
      it.mesh.userData.fade.setX(it.index, fadeOut);
      const k = it.size * emerge * (0.7 + 0.3 * fadeOut) * sizeK;
      // gentle tumble in place (capsules mostly upright, as they rise)
      if (it.kind === 'capsule') {
        _e.set(0.35 * Math.sin(t * 0.7 + it.phase), it.phase + t * 0.6, 0.35 * Math.cos(t * 0.5 + it.phase));
      } else {
        _e.set(it.phase + t * it.spin.x, it.phase * 2 + t * it.spin.y, t * it.spin.z);
      }
      _q.setFromEuler(_e);
      _m.compose(_p, _q, _s.set(k, k, k));
      it.mesh.setMatrixAt(it.index, _m);
      dirty.add(it.mesh);
    }
    dirty.forEach((m) => {
      m.instanceMatrix.needsUpdate = true;
      m.userData.fade.needsUpdate = true;
    });
  }

  dispose() {
    this.outer.removeFromParent();
    this._geometries.forEach((g) => g.dispose());
    this._materials.forEach((m) => m.dispose());
  }
}
