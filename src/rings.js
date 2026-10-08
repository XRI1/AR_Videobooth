// Orbiting ring content: curved 3D text bands, logo badges and glitter.
// All sizes are in "torso units" (1 = distance hip-center → shoulder-center),
// so the whole ring scales with the tracked person automatically.

import * as THREE from 'three';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { createGlassMaterial, GLASS_COLORS } from './stream.js';

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
    this.extraTextures?.forEach((t) => t.dispose());
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
 * Brand logo "gut SYNBIO" in 3D, with real 3D icons either side: glowing light
 * streams with glass capsules flowing along them (probiotic, left) and with
 * blue / lime glass cubes (prebiotic, right). Each sign's front face is
 * the real artwork (exact colours and shapes) and a solid body is extruded
 * behind it from the artwork's silhouette, so it reads as a thick 3D sign when
 * you walk around it. Everything sits on one gentle curve in front of the
 * body, like the regular front label (same `frontZ` / `width` contract).
 */
const LOGO_CROP = 466 / 518; // keep the lettering, drop the small tagline underneath
const SIGN_LAYERS = 14; // slices that make up each extruded body
const ICON_HEIGHT = 2.2; // side icon height relative to the logo's height (the icons are tall)
const ICON_GAP = 0.03; // gap between logo and icon, in `size` units
const ICON_TURN = 0.3; // icons sit on the curve but turn only this share of its angle, so they face the camera
const ICON_ASPECT = 0.9; // icon width / height (like the brand artwork)

export function createLogoText({ image, icons = true, size, radius, clippingPlanes }) {
  const ring = new OrbitRing();
  ring.direction = -1;
  ring.static = true;
  ring.extraTextures = [];

  // --- layout along the curve (x = arc length, 0 = centre) ---
  const logoW = size * 3.2;
  const logoH = (logoW * Math.round(image.naturalHeight * LOGO_CROP)) / image.naturalWidth;
  // logo body: solid navy like its outline
  const signs = [{ img: image, crop: LOGO_CROP, w: logoW, x: 0, y: 0, depth: logoW * 0.045, body: ['#1a3fd0', '#06106a'] }];
  const iconH = logoH * ICON_HEIGHT;
  let span = logoW;
  const iconW = iconH * ICON_ASPECT;
  if (icons) span = 2 * (logoW / 2 + size * ICON_GAP + iconW);
  const bendR = Math.max(radius, span / (FRONT_ARC * 0.75));

  for (const sign of signs) addExtrudedSign(ring, sign, { bendR, radius, clippingPlanes });
  if (icons) {
    const ticks = [];
    for (const [kind, side] of [['capsules', -1], ['cubes', 1]]) {
      const icon = createFlowIcon({ kind, mirror: side > 0, w: iconW, h: iconH, clippingPlanes });
      // flat at its spot on the curve, turned only slightly toward the side (faces the camera)
      const a = (side * (logoW / 2 + size * ICON_GAP + iconW / 2)) / bendR;
      icon.group.position.set(bendR * Math.sin(a), 0, bendR * Math.cos(a) + radius - bendR);
      icon.group.rotation.y = a * ICON_TURN;
      ring.inner.add(icon.group);
      ticks.push(icon.tick);
    }
    ring.tick = (dt) => ticks.forEach((t) => t(dt));
  }
  ring.signHalfArc = (span / (2 * bendR)) * 1.3; // glitter keeps clear of this front sector (with margin)

  ring.frontZ = radius;
  ring.width = 2 * bendR * Math.sin(span / (2 * bendR));
  return ring;
}

/**
 * A 3D "flow" icon like the brand artwork: glass objects (capsules, or blue /
 * lime cubes) and small bubbles stream out from a point by the bottom inner
 * corner (next to the logo), fanning out and growing as they sweep up to the
 * top outer corner, each with a short glowing tail. The paths themselves are
 * invisible. Built in a w x h box centred on the group origin; `mirror` flips
 * it left-right. Returns { group, tick(dt) }.
 */
function createFlowIcon({ kind, mirror, w, h, clippingPlanes }) {
  const group = new THREE.Group();
  const LINES = 8;
  const sx = mirror ? 1 : -1; // outer side: left icon's top-left, right icon's top-right
  // Paths like the artwork's streams: wide apart around the top outer corner,
  // converging at one point by the bottom inner corner (next to the logo).
  // Objects travel them from the point outward (t: 1 -> 0).
  // u: 0 = outer edge, 1 = inner edge; v: 0 = bottom, 1 = top. Stream k = 0 is the topmost.
  const curves = [];
  const end = new THREE.Vector2(1, 0.05);
  for (let k = 0; k < LINES; k++) {
    const f = k / (LINES - 1);
    // starts spread along the top edge and down the outer edge
    const start = new THREE.Vector2(0.55 * (1 - f) * (1 - f), 1 - 0.55 * f * f);
    const ctrl = new THREE.Vector2(start.x + 0.12, end.y + 0.04); // steep first, then flat into the end
    const pts = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
      const u = a * start.x + b * ctrl.x + c * end.x;
      const v = a * start.y + b * ctrl.y + c * end.y;
      pts.push(
        new THREE.Vector3(
          sx * (0.5 - u) * w,
          (v - 0.5) * h,
          (f - 0.5) * 0.3 * w * (1 - t) + Math.sin(Math.PI * t) * 0.05 * w, // fanned out in depth at the wide end, converging
        ),
      );
    }
    curves.push(new THREE.CatmullRomCurve3(pts));
  }
  // --- glass objects flowing along the streams ---
  const { BLUE, CYAN, LIME } = GLASS_COLORS;
  const items = [];
  const addKind = (geo, edges, count, colorFn, sizeRange, tumble, radius) => {
    const fade = new THREE.InstancedBufferAttribute(new Float32Array(count).fill(1), 1);
    fade.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aFade', fade);
    const mesh = new THREE.InstancedMesh(geo, createGlassMaterial(edges, clippingPlanes), count);
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < count; i++) {
      const color = colorFn(i);
      mesh.setColorAt(i, color);
      items.push({
        mesh,
        slot: items.length, // index of this object's tail dots
        color: color.clone().lerp(new THREE.Color(1, 1, 1), 0.25), // tail glow
        radius,
        fade,
        index: i,
        curve: curves[(i * 3 + 1) % LINES],
        t: (i + Math.random() * 0.5) / count, // spread along the streams
        speed: 0.05 + Math.random() * 0.04,
        size: sizeRange[0] + Math.random() * (sizeRange[1] - sizeRange[0]),
        tumble,
        spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.6),
        phase: Math.random() * TAU,
      });
    }
    mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
  };
  const blue = () => (Math.random() < 0.5 ? BLUE : CYAN).clone().lerp(BLUE, 0.3);
  if (kind === 'capsules') {
    addKind(new THREE.CapsuleGeometry(0.055 * w, 0.15 * w, 6, 16), 0, 10, blue, [0.75, 1.35], false, 0.055 * w);
  } else {
    addKind(new THREE.BoxGeometry(0.12 * w, 0.12 * w, 0.12 * w), 1, 13, (i) => (i % 2 ? LIME.clone() : blue()), [0.6, 1.3], true, 0.055 * w);
  }
  addKind(new THREE.SphereGeometry(0.022 * w, 12, 8), 0, 16, (i) => (kind === 'cubes' && i % 4 === 0 ? LIME.clone() : blue()), [0.6, 1.5], false, 0.022 * w);

  // --- short tails: a row of fading, shrinking glass beads behind each object
  // (glass, not additive glow, so they read on bright and dark backgrounds) ---
  const TAIL = 9;
  const TAIL_LEN = 0.09; // along the path (0..1)
  const tailGeo = new THREE.SphereGeometry(1, 10, 8);
  const tailFade = new THREE.InstancedBufferAttribute(new Float32Array(items.length * TAIL), 1);
  tailFade.setUsage(THREE.DynamicDrawUsage);
  tailGeo.setAttribute('aFade', tailFade);
  const tail = new THREE.InstancedMesh(tailGeo, createGlassMaterial(0, clippingPlanes), items.length * TAIL);
  tail.frustumCulled = false;
  tail.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  items.forEach((it) => {
    for (let j = 0; j < TAIL; j++) tail.setColorAt(it.slot * TAIL + j, it.color);
  });
  group.add(tail);
  const tp = new THREE.Vector3();
  const noRot = new THREE.Quaternion();

  const p = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const up = new THREE.Vector3(0, 1, 0);
  let time = 0;
  const tick = (dt) => {
    time += dt;
    for (const it of items) {
      it.t = (((it.t - it.speed * dt) % 1) + 1) % 1; // flow out from the logo toward the top outer corner
      it.curve.getPointAt(it.t, p);
      // grow in where the streams start, fade out at the far end
      const k = Math.min(1, it.t / 0.12, (1 - it.t) / 0.15);
      if (it.tumble) {
        q.setFromEuler(e.set(it.phase + time * it.spin.x, it.phase * 2 + time * it.spin.y, time * it.spin.z));
      } else {
        it.curve.getTangentAt(it.t, tan);
        q.setFromUnitVectors(up, tan); // capsules lie along the stream
      }
      // small where the streams meet, growing as they fan out (like the artwork)
      const sc = it.size * (0.4 + 0.6 * k) * (1.35 - 0.9 * it.t);
      m.compose(p, q, s.set(sc, sc, sc));
      it.mesh.setMatrixAt(it.index, m);
      it.fade.setX(it.index, k);
      // tail: trails back along the path toward where the object came from
      const base = it.slot * TAIL;
      for (let j = 0; j < TAIL; j++) {
        const g = (j + 1) / (TAIL + 1); // 0 = at the object, 1 = tail tip
        const tt = it.t + g * TAIL_LEN;
        let r = 0;
        let a = 0;
        if (tt < 1) {
          it.curve.getPointAt(tt, tp);
          r = it.radius * sc * 0.6 * (1 - g * 0.85);
          a = 0.75 * (1 - g) * k;
        }
        m.compose(tp, noRot, s.set(r, r, r));
        tail.setMatrixAt(base + j, m);
        tailFade.setX(base + j, a);
      }
    }
    group.traverse((o) => {
      if (o.isInstancedMesh) {
        o.instanceMatrix.needsUpdate = true;
        if (o.geometry.attributes.aFade) o.geometry.attributes.aFade.needsUpdate = true;
      }
    });
    tailFade.needsUpdate = true;
  };
  tick(0);
  return { group, tick };
}

/**
 * One image sign: artwork face + stacked slices behind it, bent onto the curve.
 * `body` = [front, back] colours for a solid body, or null to darken the artwork itself.
 */
function addExtrudedSign(ring, { img, crop, w, x, y, depth, body, flat }, { bendR, radius, clippingPlanes }) {
  // textures: the artwork, and its silhouette in white (tinted per slice)
  const W = img.naturalWidth;
  const H = Math.round(img.naturalHeight * crop);
  const art = document.createElement('canvas');
  art.width = W;
  art.height = H;
  art.getContext('2d').drawImage(img, 0, 0);
  const sil = document.createElement('canvas');
  sil.width = W;
  sil.height = H;
  const sg = sil.getContext('2d');
  sg.drawImage(img, 0, 0);
  sg.globalCompositeOperation = 'source-in';
  sg.fillStyle = '#ffffff';
  sg.fillRect(0, 0, W, H);
  const tex = (cv) => {
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 16; // clamped to the GPU's max; keeps the curved artwork sharp at an angle
    ring.extraTextures.push(t);
    return t;
  };
  const artTex = tex(art);
  const silTex = tex(sil);

  const h = (w * H) / W;
  const plane = new THREE.PlaneGeometry(w, h, 48, 1);
  plane.translate(0, y, 0);
  const a = x / bendR; // angle of the sign's centre on the curve
  const place = (z) => {
    if (flat) {
      // flat panel at its spot on the curve, turned only slightly toward the side
      const g = plane.clone().translate(0, 0, z).rotateY(a * ICON_TURN);
      g.translate(bendR * Math.sin(a), 0, bendR * Math.cos(a) + radius - bendR);
      return g;
    }
    const g = bendAroundCylinder(plane, bendR, a);
    g.translate(0, 0, radius - bendR + z);
    return g;
  };

  // body: stacked slices, darker toward the back
  const front = new THREE.Color(body ? body[0] : '#8a8a8a');
  const back = new THREE.Color(body ? body[1] : '#262626');
  for (let i = 0; i < SIGN_LAYERS; i++) {
    const t = i / (SIGN_LAYERS - 1);
    const mat = new THREE.MeshBasicMaterial({
      map: body ? silTex : artTex,
      color: front.clone().lerp(back, t),
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      toneMapped: false,
      clippingPlanes,
    });
    ring.inner.add(new THREE.Mesh(place(-depth * (0.05 + 0.95 * t)), mat));
  }
  // face: the artwork itself (soft glow edges kept via transparency)
  const face = new THREE.Mesh(
    place(0),
    new THREE.MeshBasicMaterial({
      map: artTex,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      toneMapped: false,
      clippingPlanes,
    }),
  );
  face.renderOrder = 1;
  ring.inner.add(face);
  plane.dispose();
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

export function createGlitter({ radius, spread, count = 260, clearArc = 0, clippingPlanes }) {
  const pos = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // around the ring, but not over the front sign (|a| < clearArc), so it stays readable
    const a = clearArc + Math.random() * (TAU - 2 * clearArc);
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
