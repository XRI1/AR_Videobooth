// "Light stream" effect: a bundle of glowing ribbons spiralling diagonally
// around the person, with glossy glass capsules, cubes and spheres flowing
// along them (blue / lime-green, like a probiotic / data-flow visual).
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
  void main() {
    vUv = uv;
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
  void main() {
    #include <clipping_planes_fragment>
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
    float alpha = clamp(0.78 + 0.22 * fres + 0.4 * edge + spec, 0.0, 1.0);
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
  varying vec3 vN;
  varying vec3 vV;
  varying vec2 vUv;
  void main() {
    #include <clipping_planes_fragment>
    float ndv = abs(dot(normalize(vN), normalize(vV)));
    float core = pow(ndv, 1.6);
    float p = fract(vUv.x * 3.0 - uTime * uSpeed + uPhase);
    float pulse = smoothstep(0.0, 0.04, p) * (1.0 - smoothstep(0.04, 0.28, p));
    float ends = smoothstep(0.0, 0.1, vUv.x) * (1.0 - smoothstep(0.86, 1.0, vUv.x));
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
  uniform float uTime;
  uniform float uScale;
  varying float vAlpha;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float tw = 0.5 + 0.5 * sin(uTime * (2.5 + aPhase * 4.0) + aPhase * 50.0);
    vAlpha = tw * tw;
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

/* ------------------------------ geometry ------------------------------ */

const rand = (a, b) => a + Math.random() * (b - a);
const LUT_SIZE = 256;

/**
 * One strand of the stream: a curve spiralling up and around the body axis.
 * Torso units: y = 0 at the hips, ~1 at the shoulders.
 */
function makeStrandCurve({ phase, radius, wobble, lift }) {
  const pts = [];
  const turns = 1.15;
  for (let i = 0; i <= 48; i++) {
    const s = i / 48;
    const a = phase + s * turns * TAU;
    const r = radius * (1 + wobble * Math.sin(s * TAU * 1.5 + phase * 3));
    const y = -1.9 + s * 3.9 + lift * Math.sin(s * TAU + phase);
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
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);

/* ------------------------------ the effect ------------------------------ */

export class LightStream {
  /**
   * @param {object} o
   * @param {'capsules'|'cubes'|'both'} o.style
   * @param {THREE.Plane[]} o.clippingPlanes
   */
  constructor({ style = 'both', clippingPlanes }) {
    this.outer = new THREE.Group(); // placed on the body by the scene
    this.inner = new THREE.Group(); // slow drift around the body axis
    this.outer.add(this.inner);
    this.spin = 0;
    this.time = 0;
    this._materials = [];
    this._geometries = [];

    const clip = { clipping: true, clippingPlanes };

    // --- strands: 2 thick glowing ribbons + thin filaments ---
    const strandDefs = [
      { phase: 0.0, radius: 1.05, wobble: 0.1, lift: 0.12, thick: 0.075, color: BLUE, opacity: 0.9 },
      { phase: 0.35, radius: 1.2, wobble: 0.14, lift: 0.1, thick: 0.05, color: CYAN, opacity: 0.8 },
    ];
    for (let i = 0; i < 7; i++) {
      strandDefs.push({
        phase: rand(-0.5, 0.8),
        radius: rand(0.95, 1.45),
        wobble: rand(0.05, 0.2),
        lift: rand(0.05, 0.25),
        thick: rand(0.006, 0.016),
        color: i % 2 ? CYAN : BLUE,
        opacity: rand(0.6, 0.95),
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
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        ...clip,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      this.inner.add(mesh);
      this._materials.push(mat);
      this._geometries.push(geo);
      return { lut: makeLut(curve), mat, thick: d.thick };
    });

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
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < count; i++) {
        mesh.setColorAt(i, colorFn(i));
        this.items.push({
          mesh,
          index: i,
          kind,
          strand: Math.floor(Math.random() * this.strands.length),
          s0: Math.random(),
          speed: rand(0.035, 0.07),
          size: rand(sizeRange[0], sizeRange[1]),
          offset: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(0.06),
          spin: new THREE.Vector3(rand(-1.2, 1.2), rand(-1.2, 1.2), rand(-1.2, 1.2)),
          phase: Math.random() * TAU,
        });
      }
      mesh.instanceColor.needsUpdate = true;
      this.inner.add(mesh);
    };

    const caps = style === 'cubes' ? 0 : style === 'capsules' ? 14 : 9;
    const cubes = style === 'capsules' ? 0 : style === 'cubes' ? 20 : 12;
    const blueish = () => (Math.random() < 0.5 ? BLUE : CYAN).clone().lerp(BLUE, 0.3);
    add(new THREE.CapsuleGeometry(0.075, 0.2, 6, 16), glass(0), caps, 'capsule', blueish, [0.8, 1.35]);
    add(
      new THREE.BoxGeometry(0.15, 0.15, 0.15),
      glass(1),
      cubes,
      'cube',
      (i) => (i % 2 ? LIME.clone() : blueish()),
      [0.6, 1.4],
    );
    add(
      new THREE.SphereGeometry(0.03, 14, 10),
      glass(0),
      36,
      'sphere',
      () => (Math.random() < 0.15 ? LIME.clone() : blueish()),
      [0.6, 1.5],
    );

    // --- sparkles along the stream ---
    const n = 140;
    const pos = new Float32Array(n * 3);
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const st = this.strands[Math.floor(Math.random() * this.strands.length)];
      sampleLut(st.lut, Math.random(), _p).toArray(pos, i * 3);
      pos[i * 3] += rand(-0.06, 0.06);
      pos[i * 3 + 1] += rand(-0.06, 0.06);
      pos[i * 3 + 2] += rand(-0.06, 0.06);
      phase[i] = Math.random();
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.sparkMat = new THREE.ShaderMaterial({
      vertexShader: sparkVert,
      fragmentShader: sparkFrag,
      uniforms: { uTime: { value: 0 }, uScale: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      ...clip,
    });
    const sparks = new THREE.Points(sg, this.sparkMat);
    sparks.frustumCulled = false;
    this.inner.add(sparks);
    this._materials.push(this.sparkMat);
    this._geometries.push(sg);

    this.update(0, 1);
  }

  /** Advance the animation. `pointScale` = screen size factor for sparkles. */
  update(dt, pointScale) {
    this.time += dt;
    const t = this.time;
    for (const s of this.strands) s.mat.uniforms.uTime.value = t;
    this.sparkMat.uniforms.uTime.value = t;
    this.sparkMat.uniforms.uScale.value = pointScale;

    const dirty = new Set();
    for (const it of this.items) {
      const s = (it.s0 + t * it.speed) % 1;
      const lut = this.strands[it.strand].lut;
      sampleLut(lut, s, _p);
      sampleLut(lut, Math.min(1, s + 0.01), _p2);
      _tan.copy(_p2).sub(_p).normalize();
      // grow in at the start of the stream, fade out at the end
      const fade = THREE.MathUtils.smoothstep(s, 0, 0.08) * (1 - THREE.MathUtils.smoothstep(s, 0.88, 1));
      _p.addScaledVector(it.offset, 1);
      const k = it.size * fade;
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
    dirty.forEach((m) => (m.instanceMatrix.needsUpdate = true));
  }

  dispose() {
    this.outer.removeFromParent();
    this._geometries.forEach((g) => g.dispose());
    this._materials.forEach((m) => m.dispose());
  }
}
