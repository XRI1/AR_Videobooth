// AR compositor.
//
// Every frame is composited in 4 layers so 3D content can wrap AROUND the
// person instead of just floating on top:
//
//   1. camera video (full screen)
//   2. back half of the rings + background fireworks
//   3. the person, cut out of the video with the segmentation mask
//   4. front half of the rings + foreground sparklers
//
// The front/back split is a clipping plane through the person's body axis,
// facing the camera, so the text visibly passes behind their back.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createTextRing, createBadgeRing, createGlitter, makeBadgeTexture, faceCamera } from './rings.js';
import { FireworksFX } from './fireworks.js';

// Virtual camera FOV. Narrower than a real phone lens (~63°) on purpose: it
// pushes the virtual person further away, which softens perspective so the
// ring reads as a clean ellipse even when the person fills the frame.
const FOV = 45;
const DEPTH = 4; // virtual distance of the person from the camera
const MAX_RENDER_EDGE = 1920;

const quadVert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const videoUvChunk = /* glsl */ `
  uniform vec4 uvXform;   // xy = scale, zw = offset (object-fit: cover)
  uniform float mirror;
  vec2 videoUv(vec2 s) {
    if (mirror > 0.5) s.x = 1.0 - s.x;
    return s * uvXform.xy + uvXform.zw;
  }
`;
const bgFrag = /* glsl */ `
  uniform sampler2D map;
  ${videoUvChunk}
  varying vec2 vUv;
  void main() { gl_FragColor = vec4(texture2D(map, videoUv(vUv)).rgb, 1.0); }
`;
const personFrag = /* glsl */ `
  uniform sampler2D map;
  uniform sampler2D mask;
  uniform vec2 maskTexel;
  uniform vec2 edge;
  uniform float maskFlipY;
  ${videoUvChunk}
  varying vec2 vUv;
  void main() {
    vec2 uv = videoUv(vUv);
    vec2 muv = vec2(uv.x, maskFlipY > 0.5 ? 1.0 - uv.y : uv.y);
    float m = 0.0;
    // 3x3 blur -> soft, less jittery matte edge
    for (int x = -1; x <= 1; x++)
      for (int y = -1; y <= 1; y++)
        m += texture2D(mask, muv + vec2(float(x), float(y)) * maskTexel * 1.5).r;
    m /= 9.0;
    float a = smoothstep(edge.x, edge.y, m);
    if (a < 0.003) discard;
    gl_FragColor = vec4(texture2D(map, uv).rgb, a);
  }
`;

// MediaPipe pose landmark indices
const L_SH = 11, R_SH = 12, L_HIP = 23, R_HIP = 24, L_ANK = 27, R_ANK = 28;

export class ARScene {
  constructor(canvas) {
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.autoClear = false;
    renderer.localClippingEnabled = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Neutral keeps brand colours (e.g. logo blue) saturated, unlike ACES.
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.setClearColor(0x000000, 1);
    this.renderer = renderer;

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 200);
    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.7;
    pmrem.dispose();
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2, 4, 3);
    this.scene.add(key, new THREE.HemisphereLight(0xffffff, 0x334466, 0.6));

    // Full-screen video layers
    this.quadCam = new THREE.Camera();
    this.uvXform = new THREE.Vector4(1, 1, 0, 0);
    this.mirror = { value: 0 };
    this.videoTexture = null;
    this.maskTexture = new THREE.Texture();
    this.hasMask = false;
    const quad = new THREE.PlaneGeometry(2, 2);

    this.bgMat = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: bgFrag,
      uniforms: { map: { value: null }, uvXform: { value: this.uvXform }, mirror: this.mirror },
      depthTest: false,
      depthWrite: false,
    });
    this.personMat = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: personFrag,
      uniforms: {
        map: { value: null },
        mask: { value: this.maskTexture },
        maskTexel: { value: new THREE.Vector2(1, 1) },
        edge: { value: new THREE.Vector2(0.35, 0.75) },
        maskFlipY: { value: 0 },
        uvXform: { value: this.uvXform },
        mirror: this.mirror,
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.bgScene = new THREE.Scene();
    this.personScene = new THREE.Scene();
    const bgMesh = new THREE.Mesh(quad, this.bgMat);
    const personMesh = new THREE.Mesh(quad, this.personMat);
    bgMesh.frustumCulled = personMesh.frustumCulled = false;
    this.bgScene.add(bgMesh);
    this.personScene.add(personMesh);

    // Front/back split
    this.clipPlane = new THREE.Plane();
    this.clippingPlanes = [this.clipPlane];
    this.clipNormal = new THREE.Vector3();

    // Content
    this.rings = {}; // ring1, ring2, badge
    this.glitter = null;
    this.fx = new FireworksFX(this.scene);
    this.time = 0;

    // Person anchor (world space, smoothed)
    this.anchor = {
      hip: new THREE.Vector3(0, -0.3, -DEPTH),
      up: new THREE.Vector3(0, 1, 0),
      S: 1,
      feetY: -2,
      roll: 0,
      found: false,
    };
    this._target = { hip: new THREE.Vector3(), up: new THREE.Vector3(), S: 1, feetY: 0 };
    this._hasTarget = false;
    this.locked = false; // freeze the anchor in place (Lock button)
    this.lockYaw = 0; // compass heading at lock time
    this.lockPitch = 0;

    this.resize();
  }

  setVideo(video) {
    this.video = video;
    this.videoTexture?.dispose();
    this.videoTexture = new THREE.VideoTexture(video);
    this.videoTexture.minFilter = this.videoTexture.magFilter = THREE.LinearFilter;
    this.videoTexture.generateMipmaps = false;
    this.bgMat.uniforms.map.value = this.videoTexture;
    this.personMat.uniforms.map.value = this.videoTexture;
  }

  setMirrored(m) {
    this.mirror.value = m ? 1 : 0;
  }

  /** Upload the tracker's RGBA mask canvas when a new mask was drawn. */
  updateMask(tracker) {
    this.hasMask = tracker.hasMask;
    const canvas = tracker.maskCanvas;
    if (!canvas) return;
    if (this.maskTexture.image !== canvas) {
      this.maskTexture.dispose();
      this.maskTexture = new THREE.CanvasTexture(canvas);
      this.maskTexture.minFilter = this.maskTexture.magFilter = THREE.LinearFilter;
      this.maskTexture.generateMipmaps = false;
      this.personMat.uniforms.mask.value = this.maskTexture;
    }
    if (tracker.maskVersion !== this._maskVersion) {
      this._maskVersion = tracker.maskVersion;
      this.maskTexture.needsUpdate = true;
      this.personMat.uniforms.maskTexel.value.set(1 / canvas.width, 1 / canvas.height);
    }
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, MAX_RENDER_EDGE / Math.max(w, h));
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // world-size -> pixel-size factor for point sprites
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.pointScale = buf.y / (2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2));
    this.fx.setPointScale(this.pointScale);
    this.fx.setView(Math.tan(THREE.MathUtils.degToRad(FOV) / 2), this.camera.aspect);
  }

  _updateUvTransform() {
    const v = this.video;
    if (!v || !v.videoWidth) return;
    const ca = this.camera.aspect;
    const va = v.videoWidth / v.videoHeight;
    if (va > ca) this.uvXform.set(ca / va, 1, (1 - ca / va) / 2, 0);
    else this.uvXform.set(1, va / ca, 0, (1 - va / ca) / 2);
  }

  /** Normalized video coords (x right, y down) -> NDC of the canvas. */
  videoToNdc(x, y, out) {
    const [sx, sy, ox, oy] = this.uvXform.toArray();
    let u = (x - ox) / sx;
    const v = (1 - y - oy) / sy;
    if (this.mirror.value > 0.5) u = 1 - u;
    return out.set(u * 2 - 1, v * 2 - 1);
  }

  /** NDC -> point on the virtual plane at the person's depth. */
  ndcToWorld(ndc, out) {
    const halfH = DEPTH * Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    return out.set(ndc.x * halfH * this.camera.aspect, ndc.y * halfH, -DEPTH);
  }

  _landmarkWorld(pose, i, out) {
    const n = this.videoToNdc(pose[i].x, pose[i].y, new THREE.Vector2());
    return this.ndcToWorld(n, out);
  }

  _computeTarget(pose) {
    const vis = (i) => pose[i] && pose[i].v > 0.5;
    if (!vis(L_SH) || !vis(R_SH)) return false;
    const ls = this._landmarkWorld(pose, L_SH, new THREE.Vector3());
    const rs = this._landmarkWorld(pose, R_SH, new THREE.Vector3());
    const sh = ls.clone().add(rs).multiplyScalar(0.5);
    const t = this._target;

    if (vis(L_HIP) || vis(R_HIP)) {
      const lh = this._landmarkWorld(pose, L_HIP, new THREE.Vector3());
      const rh = this._landmarkWorld(pose, R_HIP, new THREE.Vector3());
      t.hip.copy(lh).add(rh).multiplyScalar(0.5);
      t.S = sh.distanceTo(t.hip);
    } else {
      // Close-up: estimate the torso from shoulder width.
      const d = rs.clone().sub(ls);
      t.S = d.length() * 1.3;
      const down = new THREE.Vector3(-d.y, d.x, 0).normalize();
      if (down.y > 0) down.negate();
      t.hip.copy(sh).addScaledVector(down, t.S);
    }
    if (!(t.S > 0.05)) return false;
    t.up.copy(sh).sub(t.hip).setZ(0).normalize();

    if (vis(L_ANK) || vis(R_ANK)) {
      const la = this._landmarkWorld(pose, vis(L_ANK) ? L_ANK : R_ANK, new THREE.Vector3());
      const ra = this._landmarkWorld(pose, vis(R_ANK) ? R_ANK : L_ANK, new THREE.Vector3());
      t.feetY = Math.min(la.y, ra.y);
    } else {
      t.feetY = t.hip.y - 1.8 * t.S;
    }
    return true;
  }

  /**
   * Lock/unlock (Lock button). Locked content keeps the person as its centre
   * but its facing is pinned to the room: as the phone orbits the person,
   * the compass heading change turns the content the opposite way, so you see
   * it from the side, then from behind (hidden by the body), and so on.
   */
  setLocked(locked, gyro) {
    this.locked = locked;
    this.lockYaw = gyro?.yaw ?? 0;
    this.lockPitch = gyro?.pitch ?? 0;
    this._lockBaseline = !!gyro?.available;
  }

  /** Rotation (rad) to apply to locked content about the person's axis. */
  _lockedYaw(gyro, settings) {
    if (!this.locked || !gyro?.available) return 0;
    if (!this._lockBaseline) {
      // first sensor reading arrived after locking: use it as the baseline
      this.lockYaw = gyro.yaw;
      this.lockPitch = gyro.pitch;
      this._lockBaseline = true;
    }
    return (settings.invertGyro ? 1 : -1) * (gyro.yaw - this.lockYaw);
  }

  _updateAnchor(dt, pose) {
    const a = this.anchor;
    const got = pose && this._computeTarget(pose);
    if (got) {
      const t = this._target;
      const k = a.found ? 1 - Math.exp(-dt * 12) : 1; // snap on first lock
      a.hip.lerp(t.hip, k);
      a.up.lerp(t.up, k).normalize();
      a.S += (t.S - a.S) * k;
      a.feetY += (t.feetY - a.feetY) * k;
      a.found = true;
      this._lostFor = 0;
    } else {
      this._lostFor = (this._lostFor ?? 0) + dt;
      if (!a.found) {
        // Default placement before anyone is detected: centre of the screen.
        const halfH = DEPTH * Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
        a.hip.set(0, -0.15 * halfH, -DEPTH);
        a.S = halfH * 0.35;
        a.feetY = a.hip.y - 1.8 * a.S;
        a.up.set(0, 1, 0);
      }
    }
    // body lean / phone roll -> ring roll, kept modest (frozen while locked
    // so the content no longer sways with the body)
    if (!this.locked) a.roll = THREE.MathUtils.clamp(Math.atan2(-a.up.x, a.up.y), -0.6, 0.6);
  }

  /* ----------------------------- content ----------------------------- */

  buildContent(settings, font, logo) {
    const prevSpin = {};
    for (const [k, r] of Object.entries(this.rings)) prevSpin[k] = r.spin;
    Object.values(this.rings).forEach((r) => r.dispose());
    this.rings = {};
    if (this.glitter) {
      this.glitter.removeFromParent();
      this.glitter.geometry.dispose();
      this.glitter.material.dispose();
      this.glitter = null;
    }
    const cp = this.clippingPlanes;

    for (const key of ['ring1', 'ring2']) {
      const c = settings[key];
      if (!c.enabled || !c.text.trim()) continue;
      const ring = createTextRing({
        font,
        text: c.text,
        color: c.color,
        edge: c.edge,
        size: c.size,
        radius: c.radius,
        italic: c.italic,
        mode: c.mode,
        clippingPlanes: cp,
      });
      ring.speed = c.speed;
      ring.height = c.height;
      this.rings[key] = ring;
      this.scene.add(ring.outer);
    }

    if (settings.badge.enabled) {
      const tex = logo ?? makeBadgeTexture(settings.badge.text, settings.ring2.color, settings.ring1.color);
      const b = createBadgeRing({
        texture: tex.texture,
        aspect: tex.aspect,
        count: settings.badge.count,
        size: settings.badge.size,
        radius: settings.badge.radius,
        mode: settings.badge.mode,
        clippingPlanes: cp,
      });
      b.speed = settings.badge.speed;
      b.height = settings.badge.height;
      b.ownsTexture = !logo;
      this.rings.badge = b;
      this.scene.add(b.outer);
    }

    for (const [k, r] of Object.entries(this.rings)) r.spin = prevSpin[k] ?? 0;

    if (settings.fx.glitter && this.rings.ring1) {
      this.glitter = createGlitter({
        radius: settings.ring1.radius,
        spread: settings.ring1.size * 1.3,
        clippingPlanes: cp,
      });
      this.rings.ring1.inner.add(this.glitter);
    }
  }

  /* ------------------------------ frame ------------------------------ */

  update(dt, { pose, settings, gyro }) {
    this.time += dt;
    this._updateUvTransform();
    this._updateAnchor(dt, pose);
    const a = this.anchor;

    const lockedYaw = this._lockedYaw(gyro, settings);
    const worldYaw = this.locked ? lockedYaw : gyro?.enabled ? (settings.invertGyro ? 1 : -1) * gyro.yaw : 0;
    const pitchTilt = gyro?.enabled ? -gyro.pitch : 0;
    const tilt = THREE.MathUtils.clamp(settings.tilt + pitchTilt, -0.9, 1.2);
    // while locked, looking down on the person shows the content from above
    const staticTilt =
      this.locked && gyro?.available
        ? THREE.MathUtils.clamp(settings.tilt - (gyro.pitch - this.lockPitch), -0.9, 1.2)
        : settings.tilt;

    const tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    for (const ring of Object.values(this.rings)) {
      ring.outer.position.copy(a.hip).addScaledVector(a.up, ring.height * a.S);
      if (ring.static) {
        // Still content in front of the body: no spin; follows the person.
        // Text labels shrink if they'd leave the frame. When locked, it turns
        // around the person as the phone orbits them.
        let scale = a.S;
        if (ring.width) {
          const depth = -a.hip.z - ring.frontZ * a.S;
          const maxWidth = 2 * depth * tanHalf * this.camera.aspect * 0.92;
          scale = Math.min(a.S, maxWidth / ring.width);
        }
        ring.outer.scale.setScalar(scale);
        // Tilt makes the curve read as an arc.
        ring.outer.rotation.set(staticTilt, 0, a.roll, 'ZXY');
        ring.inner.rotation.y = lockedYaw;
        continue;
      }
      ring.spin += ring.speed * ring.direction * dt;
      ring.outer.scale.setScalar(a.S);
      ring.outer.rotation.set(tilt, 0, a.roll, 'ZXY');
      ring.inner.rotation.y = ring.spin + worldYaw;
    }
    this.scene.updateMatrixWorld();
    if (this.rings.badge) faceCamera(this.rings.badge, this.camera);

    if (this.glitter) {
      this.glitter.material.uniforms.uTime.value = this.time;
      this.glitter.material.uniforms.uScale.value = this.pointScale * this.rings.ring1.outer.scale.x;
    }

    this.fx.update(dt, a, settings.fx);

    // Clip plane through the body axis, facing the camera.
    const n = this.clipNormal.copy(a.hip).normalize(); // camera is at the origin
    n.addScaledVector(a.up, -n.dot(a.up)).normalize();
    this.clipPlane.setFromNormalAndCoplanarPoint(n, a.hip);
  }

  render(occlusion = true) {
    const r = this.renderer;
    const cam = this.camera;
    r.clear();
    r.render(this.bgScene, this.quadCam);

    // back half (far side of the plane) + background fireworks
    cam.layers.set(0);
    cam.layers.enable(1);
    r.render(this.scene, cam);

    if (occlusion && this.hasMask) r.render(this.personScene, this.quadCam);

    // front half + foreground sparklers
    r.clearDepth();
    this.clipPlane.negate();
    cam.layers.set(0);
    cam.layers.enable(2);
    r.render(this.scene, cam);
    this.clipPlane.negate();
  }

  salvo() {
    this.fx.salvo(this.anchor);
  }
}
