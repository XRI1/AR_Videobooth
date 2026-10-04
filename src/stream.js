// "Light stream" effect: glowing ribbons rise out of a ring on the floor all
// around the person and revolve upward, carrying glossy glass capsules, cubes
// and spheres (blue / lime-green, like a probiotic / data-flow visual); it fades
// out between hip and chest height. The effect itself never spins.
//
// Everything is in torso units (scaled with the person by the scene) and uses
// the scene's clipping plane, so the stream passes behind the body and comes
// back in front, exactly like the 3D text.

import * as THREE from 'three';

const TAU = Math.PI * 2;
// Shaders output raw values, so keep colours in sRGB (not linear).
const srgb = (h) => new THREE.Color(h).convertLinearToSRGB();
const BLUE = srgb('#1557ff');
const CYAN = srgb('#36c8ff');
const LIME = srgb('#b6f01e');

/* ------------------------------ shaders ------------------------------ */

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

// Glowing ribbon: bright core facing the camera, soft edges, light pulses
// travelling along it, faded at both ends.
const ribbonVert = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_vertex>
  varying vec3 vN;
  varying vec3 vV;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }
`;
const ribbonFrag = /* glsl */ `
  #include <clipping_planes_pars_fragment>
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uPhase;
  uniform float uOpacity;
  uniform vec2 uFade; // fade-out window along the stream (start, end)
  varying vec3 vN;
  varying vec3 vV;
  varying vec2 vUv;
  void main() {
    #include <clipping_planes_fragment>
    if (vUv.x > uFade.y) discard;
    float ndv = abs(dot(normalize(vN), normalize(vV)));
    float core = pow(ndv, 1.6);
    float p = fract(vUv.x * 3.0 - uTime * uSpeed + uPhase);
    float pulse = smoothstep(0.0, 0.04, p) * (1.0 - smoothstep(0.04, 0.28, p));
    // emerges from the floor, then fades out gradually from halfway up
    float ends = smoothstep(0.0, 0.03, vUv.x) * (1.0 - smoothstep(uFade.x, uFade.y, vUv.x));
    vec3 col = uColor * (0.5 + 0.55 * core) + vec3(0.55, 0.9, 1.0) * pulse * core;
    float a = (0.14 + 0.5 * core) * uOpacity * ends;
    gl_FragColor = vec4(col, a); // additive blending applies the alpha
  }
`;

// Twinkling sparkles along the stream.
const sparkVert = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_vertex>
  attribute float aPhase;
  attribute float aS; // position along the stream (0 = floor)
  uniform float uTime;
  uniform float uScale;
  uniform vec2 uFade;
  varying float vAlpha;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float tw = 0.5 + 0.5 * sin(uTime * (2.5 + aPhase * 4.0) + aPhase * 50.0);
    vAlpha = tw * tw * (1.0 - smoothstep(uFade.x, uFade.y, aS));
    gl_PointSize = clamp(0.07 * uScale * (0.5 + tw) / -mvPosition.z, 0.0, 40.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }
`;
const sparkFrag = /* glsl */ `
  #include <clipping_planes_pars_fragment>
  varying float vAlpha;
  void main() {
    #include <clipping_planes_fragment>
    vec2 c = gl_PointCoord - 0.5;
    float star = max(0.0, 1.0 - abs(c.x * c.y) * 140.0) * max(0.0, 1.0 - length(c) * 2.0);
    float core = exp(-dot(c, c) * 70.0);
    float a = clamp(star + core, 0.0, 1.0) * vAlpha;
    gl_FragColor = vec4(mix(vec3(0.6, 0.9, 1.0), vec3(1.0), core), a);
  }
`;

// Glowing ring on the floor where the stream comes out of the surface:
// soft halo + bright ring + ripples spreading outwards.
const portalVert = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_vertex>
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }
`;
const portalFrag = /* glsl */ `
  #include <clipping_planes_pars_fragment>
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    #include <clipping_planes_fragment>
    float r = length(vUv * 2.0 - 1.0);
    if (r > 1.0) discard;
    float ring = exp(-pow((r - 0.78) / 0.05, 2.0));
    float halo = (1.0 - smoothstep(0.0, 0.95, r)) * 0.22;
    float wave = fract(r * 1.4 - uTime * 0.45);
    float ripple = smoothstep(0.0, 0.05, wave) * (1.0 - smoothstep(0.05, 0.3, wave)) * (1.0 - r) * 0.8;
    float edge = 1.0 - smoothstep(0.85, 1.0, r);
    float a = clamp((ring + halo + ripple) * edge, 0.0, 1.0);
    vec3 col = mix(vec3(0.1, 0.45, 1.0), vec3(0.55, 0.95, 1.0), ring);
    gl_FragColor = vec4(col, a);
  }
`;

/* ------------------------------ geometry ------------------------------ */

const rand = (a, b) => a + Math.random() * (b - a);
const LUT_SIZE = 256;
const STRAND_COUNT = 9;
const TURNS = 1.25; // revolutions around the body over the stream's full height
/** Stream height from the floor (torso units: hips ~1.8 up, chest ~2.4). */
export const STREAM_HEIGHT = 3.2;

/**
 * One strand of the stream: a curve rising out of the floor and revolving
 * upward around the body axis. Torso units, y = 0 on the floor.
 */
function makeStrandCurve({ phase, radius, wobble, lift }) {
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const s = i / 48;
    const a = phase + s * TURNS * TAU;
    const r = radius * (1 + wobble * Math.sin(s * TAU * 1.5 + phase * 3));
    const y = s * STREAM_HEIGHT + lift * s * Math.sin(s * TAU + phase); // starts exactly on the floor
    pts.push(new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r));
  }
  return new THREE.CatmullRomCurve3(pts, false, 'centripetal');
}

/** Evenly spaced samples of a curve, for cheap per-frame lookups. */
function makeLut(curve) {
  const pts = curve.getSpacedPoints(LUT_SIZE - 1);
  const arr = new Float32Array(LUT_SIZE * 3);
  pts.forEach((p, i) => p.toArray(arr, i * 3));
  return arr;
}

function sampleLut(lut, s, out) {
  const f = THREE.MathUtils.clamp(s, 0, 1) * (LUT_SIZE - 1);
  const i = Math.min(LUT_SIZE - 2, Math.floor(f));
  const t = f - i;
  const j = i * 3;
  return out.set(
    lut[j] + (lut[j + 3] - lut[j]) * t,
    lut[j + 1] + (lut[j + 4] - lut[j + 1]) * t,
    lut[j + 2] + (lut[j + 5] - lut[j + 2]) * t,
  );
}

const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
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
    // outer: placed on the floor under the person by the scene (does not spin)
    //  └ fit: narrows the circle side-to-side only, to fit a portrait frame,
    //    so the front/back distance from the body stays like the 3D text
    //     └ inner: turned only by Lock (keeps its facing in the room)
    //        └ ribbons, sparkles, floor ring
    //  └ objects: glass capsules/cubes/spheres, positioned in outer space so
    //    the side-to-side fit never squashes their shape
    this.outer = new THREE.Group();
    this.fit = new THREE.Group();
    this.inner = new THREE.Group();
    this.ribbons = new THREE.Group();
    this.objects = new THREE.Group();
    this.outer.add(this.fit, this.objects);
    this.fit.add(this.inner);
    this.inner.add(this.ribbons);
    this.time = 0;
    this.fadeStart = 0.55;
    this.fadeEnd = 0.75;
    this._materials = [];
    this._geometries = [];

    const clip = { clipping: true, clippingPlanes };
    const fadeUniform = { value: new THREE.Vector2(this.fadeStart, this.fadeEnd) };
    this._fadeUniform = fadeUniform;

    // --- strands, spread evenly all the way around the body ---
    const strandDefs = [];
    for (let i = 0; i < STRAND_COUNT; i++) {
      const thick = i === 0 || i === Math.round(STRAND_COUNT / 2);
      strandDefs.push({
        phase: (i / STRAND_COUNT) * TAU + rand(-0.15, 0.15),
        radius: radius * rand(0.9, 1.08),
        wobble: rand(0.03, 0.08),
        lift: rand(0.03, 0.1),
        thick: thick ? rand(0.045, 0.06) : rand(0.006, 0.016),
        color: i % 2 ? CYAN : BLUE,
        opacity: thick ? 0.9 : rand(0.6, 0.95),
      });
    }
    this.strands = strandDefs.map((d) => {
      const curve = makeStrandCurve(d);
      const geo = new THREE.TubeGeometry(curve, 200, d.thick, 8, false);
      const mat = new THREE.ShaderMaterial({
        vertexShader: ribbonVert,
        fragmentShader: ribbonFrag,
        uniforms: {
          uColor: { value: d.color },
          uTime: { value: 0 },
          uSpeed: { value: rand(0.25, 0.45) },
          uPhase: { value: Math.random() },
          uOpacity: { value: d.opacity },
          uFade: fadeUniform,
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        ...clip,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      this.ribbons.add(mesh);
      this._materials.push(mat);
      this._geometries.push(geo);
      return { lut: makeLut(curve), mat };
    });
    // widest / closest horizontal reach of the stream (frame fit, body clearance)
    this.maxRadius = 0;
    this.minRadius = Infinity;
    for (const s of this.strands) {
      for (let i = 0; i < LUT_SIZE; i++) {
        const r = Math.hypot(s.lut[i * 3], s.lut[i * 3 + 2]);
        this.maxRadius = Math.max(this.maxRadius, r);
        this.minRadius = Math.min(this.minRadius, r);
      }
    }

    // --- flowing glass objects ---
    const glass = (edges) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: glassVert,
        fragmentShader: glassFrag,
        uniforms: { uEdges: { value: edges } },
        transparent: true,
        side: THREE.DoubleSide,
        ...clip,
      });
      this._materials.push(m);
      return m;
    };
    this.items = [];
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
          strand: i % this.strands.length, // spread around the whole circle
          s0: Math.random(),
          speed: rand(0.12, 0.2), // floor -> fade-out in ~4-7 s
          size: rand(sizeRange[0], sizeRange[1]),
          offset: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(0.05),
          spin: new THREE.Vector3(rand(-1.2, 1.2), rand(-1.2, 1.2), rand(-1.2, 1.2)),
          phase: Math.random() * TAU,
        });
      }
      mesh.instanceColor.needsUpdate = true;
      this.objects.add(mesh);
    };

    const caps = style === 'cubes' ? 0 : style === 'capsules' ? 16 : 10;
    const cubes = style === 'capsules' ? 0 : style === 'cubes' ? 20 : 12;
    const blueish = () => (Math.random() < 0.5 ? BLUE : CYAN).clone().lerp(BLUE, 0.3);
    add(new THREE.CapsuleGeometry(0.075, 0.2, 6, 16), glass(0), caps, 'capsule', blueish, [0.8, 1.3]);
    add(
      new THREE.BoxGeometry(0.15, 0.15, 0.15),
      glass(1),
      cubes,
      'cube',
      (i) => (i % 2 ? LIME.clone() : blueish()),
      [0.6, 1.3],
    );
    add(
      new THREE.SphereGeometry(0.03, 14, 10),
      glass(0),
      36,
      'sphere',
      () => (Math.random() < 0.15 ? LIME.clone() : blueish()),
      [0.6, 1.5],
    );

    // --- sparkles along the stream (faded with it) ---
    const n = 110;
    const pos = new Float32Array(n * 3);
    const phase = new Float32Array(n);
    const along = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const st = this.strands[i % this.strands.length];
      along[i] = Math.random() * 0.95;
      sampleLut(st.lut, along[i], _p).toArray(pos, i * 3);
      pos[i * 3] += rand(-0.06, 0.06);
      pos[i * 3 + 1] += rand(0, 0.06);
      pos[i * 3 + 2] += rand(-0.06, 0.06);
      phase[i] = Math.random();
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    sg.setAttribute('aS', new THREE.BufferAttribute(along, 1));
    this.sparkMat = new THREE.ShaderMaterial({
      vertexShader: sparkVert,
      fragmentShader: sparkFrag,
      uniforms: { uTime: { value: 0 }, uScale: { value: 1 }, uFade: fadeUniform },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      ...clip,
    });
    const sparks = new THREE.Points(sg, this.sparkMat);
    sparks.frustumCulled = false;
    this.ribbons.add(sparks);
    this._materials.push(this.sparkMat);
    this._geometries.push(sg);

    // --- glowing ring on the floor the stream rises out of ---
    const pg = new THREE.PlaneGeometry(2, 2);
    pg.rotateX(-Math.PI / 2); // lie flat on the floor (y = 0)
    this.portalMat = new THREE.ShaderMaterial({
      vertexShader: portalVert,
      fragmentShader: portalFrag,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      ...clip,
    });
    const portal = new THREE.Mesh(pg, this.portalMat);
    portal.scale.setScalar(this.maxRadius * 1.12);
    portal.position.y = 0.01;
    portal.frustumCulled = false;
    this.ribbons.add(portal);
    this._materials.push(this.portalMat);
    this._geometries.push(pg);

    this.update(0, 1);
  }

  /**
   * Fade window along the stream (0 = floor, 1 = top of the stream): fully
   * visible below `start`, gone above `end`.
   */
  setFade(start, end) {
    this.fadeStart = start;
    this.fadeEnd = Math.max(start + 0.02, end);
    this._fadeUniform.value.set(this.fadeStart, this.fadeEnd);
  }

  /**
   * Advance the animation.
   * @param {number} dt
   * @param {number} pointScale  screen size factor for sparkles
   * @param {number} sx  side-to-side scale of the circle (fits the frame)
   * @param {number} sz  front/back scale of the circle (matches the text's distance)
   * @param {number} yaw  facing in the room (Lock); the stream never spins
   */
  update(dt, pointScale, sx = 1, sz = 1, yaw = 0) {
    this.time += dt;
    const t = this.time;
    this.fit.scale.set(sx, 1, sz);
    this.inner.rotation.y = yaw;
    for (const s of this.strands) s.mat.uniforms.uTime.value = t;
    this.sparkMat.uniforms.uTime.value = t;
    this.sparkMat.uniforms.uScale.value = pointScale;
    this.portalMat.uniforms.uTime.value = t;

    _qYaw.setFromAxisAngle(_up, yaw);
    const span = this.fadeEnd + 0.02; // objects only travel the visible part
    const sizeK = 0.7 + 0.3 * Math.min(1, sx, sz); // a bit smaller in a narrowed stream
    const dirty = new Set();
    for (const it of this.items) {
      // rise from the floor, revolving upward along the strand
      const s = ((it.s0 + t * it.speed) % 1) * span;
      const lut = this.strands[it.strand].lut;
      sampleLut(lut, s, _p).applyQuaternion(_qYaw);
      sampleLut(lut, Math.min(1, s + 0.01), _p2).applyQuaternion(_qYaw);
      _p.x *= sx;
      _p.z *= sz;
      _p2.x *= sx;
      _p2.z *= sz;
      _tan.copy(_p2).sub(_p).normalize();
      // emerge from the floor (grow in), then fade out between hip and chest
      const emerge = THREE.MathUtils.smoothstep(s, 0, 0.06);
      const fadeOut = 1 - THREE.MathUtils.smoothstep(s, this.fadeStart, this.fadeEnd);
      it.mesh.userData.fade.setX(it.index, fadeOut);
      _p.addScaledVector(it.offset, emerge); // offsets open up as it leaves the floor
      const k = it.size * emerge * (0.7 + 0.3 * fadeOut) * sizeK;
      if (it.kind === 'capsule') {
        // lie along the stream, rolling slowly
        _q.setFromUnitVectors(_up, _tan);
        _q2.setFromAxisAngle(_up, t * 0.8 + it.phase);
        _q.multiply(_q2);
      } else {
        _e.set(it.phase + t * it.spin.x, it.phase * 2 + t * it.spin.y, t * it.spin.z);
        _q.setFromEuler(_e);
      }
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
