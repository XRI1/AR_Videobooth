// Orbiting ring content: curved 3D text bands, logo badges and glitter.
// All sizes are in "torso units" (1 = distance hip-center → shoulder-center),
// so the whole ring scales with the tracked person automatically.

import * as THREE from 'three';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

const TAU = Math.PI * 2;
const BADGE_FRONT_Z = 0.3; // still badges sit this far in front of the body axis
const FRONT_ARC =(80 * Math.PI) / 180; // max total bend (80°) of a static front label

/** A ring = outer group (placed/tilted on the body) + inner group (spins). */
export class OrbitRing {
  constructor() {
    this.outer = new THREE.Group();
    this.inner = new THREE.Group();
    this.outer.add(this.inner);
    this.spin = 0;
    this.speed = 0;
    this.direction = 1; // multiplies speed; text rings use -1 (reversed spin)
    this.height = 0;
    this.billboards = [];
  }

  dispose() {
    this.outer.removeFromParent();
    const mats = new Set();
    this.outer.traverse((o) => {
      o.geometry?.dispose();
      [].concat(o.material ?? []).forEach((m) => mats.add(m));
    });
    mats.forEach((m) => m.dispose());
    if (this.ownsTexture) this.texture?.dispose();
  }
}

/**
 * Wrap a flat geometry around a vertical cylinder of radius `radius`,
 * starting at angle `offset`. +X becomes the direction of travel around the
 * ring, +Z becomes the outward normal. Normals are rotated exactly.
 */
function bendAroundCylinder(src, radius, offset) {
  const geo = src.clone();
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const a = x / radius + offset;
    const r = radius + z;
    const s = Math.sin(a), c = Math.cos(a);
    pos.setXYZ(i, r * s, y, r * c);
    if (nor) {
      const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
      nor.setXYZ(i, nx * c + nz * s, ny, -nx * s + nz * c);
    }
  }
  pos.needsUpdate = true;
  if (nor) nor.needsUpdate = true;
  geo.computeBoundingSphere();
  return geo;
}

/**
 * 3D text on the body. mode 'front': one static label curved around the front
 * of the person, centred on the camera. mode 'orbit': copies bent into a ring that
 * spins around the person.
 */
export function createTextRing({ font, text, color, edge, size, radius, italic, mode = 'front', clippingPlanes }) {
  const ring = new OrbitRing();
  ring.direction = -1;
  ring.static = mode === 'front';
  const label = (text || ' ').trim() || ' ';

  const geo = new TextGeometry(label, {
    font,
    size,
    depth: size * 0.3,
    curveSegments: 10,
    bevelEnabled: true,
    bevelThickness: size * 0.06,
    bevelSize: size * 0.04,
    bevelSegments: 3,
  });
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -(bb.min.z + bb.max.z) / 2);

  if (italic) {
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) + p.getY(i) * 0.2);
  }

  const faceMat = new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.15,
    roughness: 0.28,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    emissive: color,
    emissiveIntensity: 0.06,
    side: THREE.DoubleSide,
    clippingPlanes,
  });
  const sideMat = new THREE.MeshStandardMaterial({
    color: edge,
    metalness: 0.25,
    roughness: 0.3,
    emissive: edge,
    emissiveIntensity: 0.1,
    side: THREE.DoubleSide,
    clippingPlanes,
  });

  if (ring.static) {
    // One copy with a gentle curve, centred on the camera. The bend radius
    // grows with the text length so the whole word spans at most FRONT_ARC
    // radians and every letter stays readable; its middle sits at `radius`
    // in front of the body.
    const w = bb.max.x - bb.min.x;
    const bendR = Math.max(radius, w / FRONT_ARC);
    const bent = bendAroundCylinder(geo, bendR, 0);
    bent.translate(0, 0, radius - bendR);
    const mesh = new THREE.Mesh(bent, [faceMat, sideMat]);
    ring.inner.add(mesh);
    geo.dispose();
    ring.frontZ = radius;
    // on-screen (chord) width, used to keep the label inside the frame
    ring.width = 2 * bendR * Math.sin(w / (2 * bendR));
    return ring;
  }

  // How many copies of the word fit around the ring.
  const circumference = TAU * radius;
  const gap = size * 1.4;
  let width = bb.max.x - bb.min.x;
  if (width + gap > circumference * 0.95) {
    const s = (circumference * 0.85) / (width + gap);
    geo.scale(s, s, s);
    width *= s;
  }
  const copies = Math.max(1, Math.floor(circumference / (width + gap)));
  const step = TAU / copies;

  for (let k = 0; k < copies; k++) {
    const mesh = new THREE.Mesh(bendAroundCylinder(geo, radius, k * step), [faceMat, sideMat]);
    ring.inner.add(mesh);
  }
  geo.dispose();
  return ring;
}

/**
 * Brand logo text "gut SYNBIO" in 3D, styled after the logo: big glossy blue
 * "gut" on top (its "g" tucks over the second line), "SYNBIO" below in a
 * white-to-cyan gradient with the final "O" turning lime, and dark navy sides
 * like the logo's outline. Static and gently curved in front of the body, like
 * the regular front label (same `frontZ` / `width` contract).
 */
export function createLogoText({ font, size, radius, clippingPlanes }) {
  const ring = new OrbitRing();
  ring.direction = -1;
  ring.static = true;

  const make = (text, s, depthK) => {
    const g = new TextGeometry(text, {
      font,
      size: s,
      depth: s * depthK,
      curveSegments: 12,
      bevelEnabled: true,
      bevelThickness: s * 0.07,
      bevelSize: s * 0.045,
      bevelSegments: 4,
    });
    g.computeBoundingBox();
    return g;
  };
  // horizontal advance of a string, the way TextGeometry lays glyphs out
  const advance = (str, s) =>
    [...str].reduce((w, ch) => w + (font.data.glyphs[ch]?.ha ?? 0), 0) * (s / font.data.resolution);

  const gutSize = size * 1.3;
  const synSize = size * 0.95;
  const gut = make('gut', gutSize, 0.34);
  const syn = make('SYNBIO', synSize, 0.3);

  // --- SYNBIO colours: white -> cyan top to bottom, the "O" cyan -> lime ---
  const sb = syn.boundingBox;
  const oStart = advance('SYNBI', synSize);
  const oEnd = sb.max.x;
  const top = new THREE.Color('#ffffff');
  const bottom = new THREE.Color('#38c6ff');
  const oFrom = new THREE.Color('#5fe0ff');
  const oTo = new THREE.Color('#b6f01e');
  const pos = syn.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const t = (pos.getY(i) - sb.min.y) / (sb.max.y - sb.min.y);
    if (x >= oStart - synSize * 0.02) c.copy(oFrom).lerp(oTo, THREE.MathUtils.clamp((x - oStart) / (oEnd - oStart), 0, 1));
    else c.copy(bottom).lerp(top, THREE.MathUtils.smoothstep(t, 0.15, 0.85));
    c.toArray(colors, i * 3);
  }
  syn.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // --- layout: SYNBIO below, "gut" above with its "g" overlapping slightly ---
  const gb = gut.boundingBox;
  syn.translate(-(sb.min.x + sb.max.x) / 2, -sb.max.y, 0); // top of SYNBIO at y = 0
  gut.translate(-(gb.min.x + gb.max.x) / 2, synSize * 0.12, synSize * 0.12); // a little in front
  const blockTop = synSize * 0.12 + gb.max.y;
  const blockBottom = -(sb.max.y - sb.min.y);
  const midY = (blockTop + blockBottom) / 2;
  gut.translate(0, -midY, 0);
  syn.translate(0, -midY, 0);

  // --- materials ---
  const outline = new THREE.MeshStandardMaterial({
    color: '#0a1d9a',
    emissive: '#0a1d9a',
    emissiveIntensity: 0.3,
    metalness: 0.2,
    roughness: 0.35,
    side: THREE.DoubleSide,
    clippingPlanes,
  });
  // Brand colours are shown as-is (no tone-mapping, which would wash the
  // electric blue toward lavender).
  const gutFace = new THREE.MeshPhysicalMaterial({
    toneMapped: false,
    color: '#0b55ff',
    emissive: '#0036ff',
    emissiveIntensity: 0.45,
    metalness: 0.05,
    roughness: 0.12,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    sheen: 0.35, // light cyan rim, kept low so the blue stays vivid (not lavender)
    sheenColor: '#4fdcff',
    sheenRoughness: 0.3,
    side: THREE.DoubleSide,
    clippingPlanes,
  });
  const synFace = new THREE.MeshPhysicalMaterial({
    toneMapped: false,
    color: '#ffffff',
    vertexColors: true,
    emissive: '#3fd4ff',
    emissiveIntensity: 0.1,
    metalness: 0.05,
    roughness: 0.15,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    side: THREE.DoubleSide,
    clippingPlanes,
  });

  // --- gentle curve in front of the body, like the regular front label ---
  const w = Math.max(gb.max.x - gb.min.x, sb.max.x - sb.min.x);
  const bendR = Math.max(radius, w / FRONT_ARC);
  for (const [geo, face] of [[syn, synFace], [gut, gutFace]]) {
    const bent = bendAroundCylinder(geo, bendR, 0);
    bent.translate(0, 0, radius - bendR);
    ring.inner.add(new THREE.Mesh(bent, [face, outline]));
    geo.dispose();
  }
  ring.frontZ = radius;
  ring.width = 2 * bendR * Math.sin(w / (2 * bendR));
  return ring;
}

/** Draws a round medallion badge ("20 YEARS" style) to a canvas texture. */
export function makeBadgeTexture(text, color = '#f5b301', accent = '#1a73e8') {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const c = S / 2;

  const glow = g.createRadialGradient(c, c, S * 0.3, c, c, S * 0.5);
  glow.addColorStop(0, 'rgba(255,220,120,0.55)');
  glow.addColorStop(1, 'rgba(255,220,120,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, S, S);

  const disc = g.createLinearGradient(0, S * 0.1, 0, S * 0.9);
  disc.addColorStop(0, '#fff3c4');
  disc.addColorStop(0.45, color);
  disc.addColorStop(1, '#a86b00');
  g.beginPath();
  g.arc(c, c, S * 0.4, 0, TAU);
  g.fillStyle = disc;
  g.fill();
  g.lineWidth = S * 0.025;
  g.strokeStyle = '#fff8dc';
  g.stroke();
  g.beginPath();
  g.arc(c, c, S * 0.34, 0, TAU);
  g.lineWidth = S * 0.01;
  g.strokeStyle = 'rgba(255,255,255,0.7)';
  g.stroke();

  // A leading number (e.g. "20 YEARS", "2.0") is drawn big, the rest as a caption.
  const m = /^\s*(\d+(?:\.\d+)?)\s*(.*)$/.exec(text || '');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = 12;
  g.shadowOffsetY = 4;
  if (m) {
    g.fillStyle = accent;
    const numSize = fitFont(g, m[1], S * 0.58, m[2] ? S * 0.3 : S * 0.34);
    g.font = `900 ${numSize}px system-ui, sans-serif`;
    g.fillText(m[1], c, m[2] ? c - S * 0.04 : c);
    if (m[2]) {
      g.fillStyle = '#ffffff';
      g.font = `800 ${fitFont(g, m[2].toUpperCase(), S * 0.5, S * 0.09)}px system-ui, sans-serif`;
      g.fillText(m[2].toUpperCase(), c, c + S * 0.17);
    }
  } else {
    const t = (text || '★').toUpperCase();
    g.fillStyle = accent;
    g.font = `900 ${fitFont(g, t, S * 0.58, S * 0.2)}px system-ui, sans-serif`;
    g.fillText(t, c, c);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { texture: tex, aspect: 1 };
}

function fitFont(g, text, maxWidth, start) {
  let size = start;
  g.font = `800 ${size}px system-ui, sans-serif`;
  while (size > 10 && g.measureText(text).width > maxWidth) {
    size -= 2;
    g.font = `800 ${size}px system-ui, sans-serif`;
  }
  return size;
}

/**
 * Logo badges. mode 'front': still, in a row beside the person's head and
 * slightly in front (never behind them). mode 'orbit': evenly spaced on a
 * ring that spins.
 */
export function createBadgeRing({ texture, aspect, count, size, radius, mode = 'front', clippingPlanes }) {
  const ring = new OrbitRing();
  ring.static = mode === 'front';
  const geo = new THREE.PlaneGeometry(size * aspect, size);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.02,
    side: THREE.DoubleSide,
    depthWrite: false,
    clippingPlanes,
  });
  // Still badges: spread across ±half the radius, just in front of the body.
  const halfSpread = radius * 0.5;
  for (let k = 0; k < count; k++) {
    const pivot = new THREE.Group();
    const mesh = new THREE.Mesh(geo, mat);
    if (ring.static) {
      const x = count === 1 ? 0 : THREE.MathUtils.lerp(-halfSpread, halfSpread, k / (count - 1));
      mesh.position.set(x, 0, BADGE_FRONT_Z);
    } else {
      pivot.rotation.y = (k / count) * TAU;
      mesh.position.z = radius;
    }
    mesh.renderOrder = 2;
    pivot.add(mesh);
    ring.inner.add(pivot);
    ring.billboards.push(mesh);
  }
  ring.texture = texture;
  if (ring.static) {
    // used by the scene to shrink the row if it would leave the frame
    ring.width = (count === 1 ? 0 : 2 * halfSpread) + size * aspect;
    ring.frontZ = BADGE_FRONT_Z;
  }
  return ring;
}

const _q = new THREE.Quaternion();
/** Keep badge planes facing the camera (camera sits at origin, unrotated). */
export function faceCamera(ring, camera) {
  for (const m of ring.billboards) {
    m.parent.getWorldQuaternion(_q);
    m.quaternion.copy(_q.invert().multiply(camera.quaternion));
  }
}

/* ------------------------------ glitter ------------------------------ */

const glitterVert = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_vertex>
  attribute float aPhase;
  attribute float aSize;
  uniform float uTime;
  uniform float uScale;
  varying float vAlpha;
  varying float vHue;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float tw = 0.5 + 0.5 * sin(uTime * (3.0 + aPhase * 5.0) + aPhase * 40.0);
    vAlpha = pow(tw, 3.0);
    vHue = aPhase;
    gl_PointSize = clamp(aSize * uScale * (0.4 + tw) / -mvPosition.z, 0.0, 48.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }
`;
const glitterFrag = /* glsl */ `
  #include <clipping_planes_pars_fragment>
  varying float vAlpha;
  varying float vHue;
  void main() {
    #include <clipping_planes_fragment>
    vec2 c = gl_PointCoord - 0.5;
    // four-point star sparkle
    float star = max(0.0, 1.0 - abs(c.x * c.y) * 120.0) * max(0.0, 1.0 - length(c) * 2.0);
    float core = exp(-dot(c, c) * 60.0);
    float a = clamp(star + core, 0.0, 1.0) * vAlpha;
    vec3 col = mix(vec3(1.0, 0.85, 0.45), vec3(0.8, 0.92, 1.0), step(0.7, vHue));
    gl_FragColor = vec4(mix(col, vec3(1.0), core), a);
  }
`;

export function createGlitter({ radius, spread, count = 260, clippingPlanes }) {
  const pos = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * TAU;
    const r = radius * (0.92 + Math.random() * 0.3);
    pos[i * 3] = Math.sin(a) * r;
    pos[i * 3 + 1] = (Math.random() * 2 - 1) * spread;
    pos[i * 3 + 2] = Math.cos(a) * r;
    phase[i] = Math.random();
    sizes[i] = 0.05 + Math.random() * 0.09;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: glitterVert,
    fragmentShader: glitterFrag,
    uniforms: { uTime: { value: 0 }, uScale: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    clipping: true,
    clippingPlanes,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return points;
}
