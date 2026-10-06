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
import { createTextRing, createLogoText, createBadgeRing, createGlitter, makeBadgeTexture, faceCamera } from './rings.js';
import { FireworksFX } from './fireworks.js';
import { LightStream, STREAM_HEIGHT } from './stream.js';
import { OneEuroFilter, damp, wrapAngle, easeOutBack } from './filters.js';

// Virtual camera FOV. Narrower than a real phone lens (~63°) on purpose: it
// pushes the virtual person further away, which softens perspective so the
// ring reads as a clean ellipse even when the person fills the frame.
const FOV = 45;
const DEPTH = 4; // virtual distance of the person from the camera
const MAX_RENDER_EDGE = 1920;
const GLIDE_RATE = 14; // per-frame follow speed toward the filtered pose (1/s)
// One Euro [minCutoff Hz, beta] for the person's screen position: normal, and
// heavier while locked (orbiting the person makes side-on tracking noisy).
const POS_FILTER = [0.45, 0.8];
const LOCKED_POS_FILTER = [0.25, 0.5];
const LOST_AFTER = 1.2; // seconds without a person before content hides
const APPEAR_TIME = 0.55; // seconds for the pop-in / shrink-out animation
const TURN_RATE = 12; // smoothing of lock / gyro rotations (1/s)
const STREAM_FILL = 0.92; // share of the frame half-width the light stream may use
// closest the stream may come to the body axis (torso units): body + arms half-width
// (~0.55) + room for the biggest capsule (~0.25), so nothing passes through the body
const STREAM_BODY_CLEARANCE = 0.82;
const STREAM_CHEST = 0.6; // light stream is gone this far above the hips (torso units)

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
    // All AR content lives under this root. Normally it is identity (content
    // is in camera space). In world-lock AR mode it pins the content to a
    // real spot in the room.
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.fx = new FireworksFX(this.root);
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
    // Two-stage smoothing: One Euro filters on each new detection (removes
    // landmark jitter), then a fast per-frame glide toward the filtered goal
    // (smooth 60 fps motion between 30 fps detections).
    this._filters = {
      x: new OneEuroFilter(...POS_FILTER),
      y: new OneEuroFilter(...POS_FILTER),
      S: new OneEuroFilter(0.25, 0.3), // size: very steady (no "breathing")
      feetY: new OneEuroFilter(0.5, 0.8),
      ang: new OneEuroFilter(0.3, 0.4), // lean: very steady
    };
    this._goal = { x: 0, y: 0, S: 1, feetY: 0, ang: 0 };
    this._ang = 0; // smoothed body-axis angle
    this._lostFor = 0;
    // Appear/disappear animation (0 = hidden, 1 = shown)
    this._appearT = 0;
    this.appearScale = 0;
    // Smoothed rotations. The phone sensor shakes with the hand while walking,
    // so locked rotation/tilt go through One Euro filters too.
    this._yawFilter = new OneEuroFilter(0.5, 0.8);
    this._tiltFilter = new OneEuroFilter(0.4, 0.5);
    this._staticYaw = 0;
    this._orbitYaw = 0;
    this._staticTilt = 0.12;
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
    if (this.xr) return; // AR mode: ARCore supplies projection; scales set at placement
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
    // Freeze size and lean at lock time. Seen from the side or behind, body
    // tracking is noisier and reads the person smaller, which would make the
    // text shrink, shake and change its distance from the body.
    this._lockS = this.anchor.S;
    this._lockAng = this._ang;
    this._lockFeetOffset = this.anchor.feetY - this.anchor.hip.y;
    const f = this._filters;
    for (const k of ['x', 'y']) {
      f[k].minCutoff = locked ? LOCKED_POS_FILTER[0] : POS_FILTER[0];
      f[k].beta = locked ? LOCKED_POS_FILTER[1] : POS_FILTER[1];
    }
    if (!locked) {
      // resume measuring from the current values (no jump)
      f.S.reset();
      f.ang.reset();
      this._goal.S = this.anchor.S;
      this._goal.ang = this._ang;
    }
    if (!locked) this._streamLayout = null; // light stream re-fits to the live person
    // Unlocking glides the content back to the front by the shortest way.
    if (!locked) this._staticYaw = wrapAngle(this._staticYaw);
    this._yawFilter.reset();
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

  _updateAnchor(dt, pose, poseVersion, poseTime) {
    const a = this.anchor;
    const g = this._goal;
    const fresh = poseVersion !== this._poseVersion; // a new detection arrived
    this._poseVersion = poseVersion;

    if (fresh && pose && this._computeTarget(pose)) {
      const t = this._target;
      const f = this._filters;
      const reacquired = !a.found || this._lostFor > LOST_AFTER;
      if (reacquired) Object.values(f).forEach((x) => x.reset());
      g.x = f.x.filter(t.hip.x, poseTime);
      g.y = f.y.filter(t.hip.y, poseTime);
      if (this.locked && a.found) {
        // locked: only the position follows; size, lean and floor stay frozen
        g.S = this._lockS;
        g.ang = this._lockAng;
        g.feetY = g.y + this._lockFeetOffset;
      } else {
        g.S = f.S.filter(t.S, poseTime);
        g.feetY = f.feetY.filter(t.feetY, poseTime);
        g.ang = f.ang.filter(Math.atan2(t.up.x, t.up.y), poseTime);
      }
      if (reacquired) {
        // jump straight to the person (the appear animation hides the jump)
        a.hip.set(g.x, g.y, -DEPTH);
        a.S = g.S;
        a.feetY = g.feetY;
        this._ang = g.ang;
      }
      a.found = true;
      this._lostFor = 0;
    } else if (fresh || !pose) {
      this._lostFor += dt;
    }

    if (a.found) {
      // glide toward the filtered goal every frame (60 fps between detections)
      const k = damp(GLIDE_RATE, dt);
      a.hip.x += (g.x - a.hip.x) * k;
      a.hip.y += (g.y - a.hip.y) * k;
      a.S += (g.S - a.S) * k;
      a.feetY += (g.feetY - a.feetY) * k;
      this._ang += (g.ang - this._ang) * k;
      a.up.set(Math.sin(this._ang), Math.cos(this._ang), 0);
    } else {
      // Default placement before anyone is detected: centre of the screen.
      const halfH = DEPTH * Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
      a.hip.set(0, -0.15 * halfH, -DEPTH);
      a.S = halfH * 0.35;
      a.feetY = a.hip.y - 1.8 * a.S;
      a.up.set(0, 1, 0);
    }
    // body lean / phone roll -> ring roll, kept modest (frozen while locked
    // so the content no longer sways with the body)
    if (!this.locked) a.roll = THREE.MathUtils.clamp(-this._ang, -0.6, 0.6);

    // Pop in when a person is found; shrink away if they leave the frame
    // (locked content stays).
    const show = a.found && (this.locked || this._lostFor < LOST_AFTER);
    this._appearT = THREE.MathUtils.clamp(this._appearT + (show ? dt : -dt) / APPEAR_TIME, 0, 1);
    this.appearScale = show ? easeOutBack(this._appearT) : this._appearT * this._appearT;
  }

  /* ----------------------------- content ----------------------------- */

  buildContent(settings, font, logo, brandLogo) {
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
      const brand = key === 'ring1' && c.logoText && brandLogo;
      if (!c.enabled || (!brand && !c.text.trim())) continue;
      const ring = brand
        ? // "gut SYNBIO" brand lettering (static, in front of the body)
          createLogoText({ image: brandLogo.logo, badges: brandLogo.badges, size: c.size, radius: c.radius, clippingPlanes: cp })
        : createTextRing({
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
      this.root.add(ring.outer);
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
      this.root.add(b.outer);
    }

    for (const [k, r] of Object.entries(this.rings)) r.spin = prevSpin[k] ?? 0;

    this.stream?.dispose();
    this.stream = null;
    if (settings.fx.stream) {
      this.stream = new LightStream({
        style: settings.fx.streamStyle,
        radius: settings.ring1.radius, // same distance from the body as the 3D text
        clippingPlanes: cp,
      });
      this.root.add(this.stream.outer);
    }

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

  update(dt, { pose, poseVersion, poseTime, settings, gyro }) {
    this.time += dt;
    const inXR = !!this.xr;
    if (!inXR) {
      this._updateUvTransform();
      this._updateAnchor(dt, pose, poseVersion, poseTime);
    }
    // (in world-lock AR mode the anchor is fixed in the room: no re-tracking)
    const a = this.anchor;
    const appear = this.appearScale;
    const visible = this._appearT > 0;

    // Rotations are eased toward their targets (no sensor jitter, no snaps;
    // shortest way round so unlocking glides back to the front).
    const turn = damp(TURN_RATE, dt);
    // (in world-lock AR mode ARCore moves the camera, so no sensor rotation)
    const lockedYaw = inXR ? 0 : this._yawFilter.filter(this._lockedYaw(gyro, settings), this.time);
    this._staticYaw += wrapAngle(lockedYaw - this._staticYaw) * turn;
    const orbitTarget = inXR ? 0 : this.locked ? lockedYaw : gyro?.enabled ? (settings.invertGyro ? 1 : -1) * gyro.yaw : 0;
    this._orbitYaw += wrapAngle(orbitTarget - this._orbitYaw) * turn;
    const pitchTilt = gyro?.enabled ? -gyro.pitch : 0;
    // AR mode: tilt corrected for how far the phone pointed down at lock time
    const xrTilt = inXR ? (this.xr.tiltOffset ?? 0) : 0;
    const tilt = THREE.MathUtils.clamp(settings.tilt + pitchTilt + xrTilt, -0.9, 1.2);
    // while locked, looking down on the person shows the content from above
    const staticTiltTarget =
      this.locked && !inXR && gyro?.available
        ? THREE.MathUtils.clamp(settings.tilt - (gyro.pitch - this.lockPitch), -0.9, 1.2)
        : settings.tilt + xrTilt;
    this._staticTilt += (this._tiltFilter.filter(staticTiltTarget, this.time) - this._staticTilt) * turn;
    this._lastSettingsTilt = settings.tilt;

    const tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV) / 2); // layout always uses the virtual lens
    for (const ring of Object.values(this.rings)) {
      ring.outer.visible = visible;
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
        ring.outer.scale.setScalar(scale * appear);
        // Tilt makes the curve read as an arc.
        ring.outer.rotation.set(this._staticTilt, 0, a.roll, 'ZXY');
        ring.inner.rotation.y = this._staticYaw;
        continue;
      }
      ring.spin += ring.speed * ring.direction * dt;
      ring.outer.scale.setScalar(a.S * appear);
      ring.outer.rotation.set(tilt, 0, a.roll, 'ZXY');
      ring.inner.rotation.y = ring.spin + this._orbitYaw;
    }
    if (this.stream) {
      // Light stream: rises from the floor all around the person, at the
      // same distance from the body as the 3D text. The effect itself does
      // not spin (only Lock turns it, like the text).
      // Layout (circle size, frame fit, floor offset, fade heights). While
      // locked it is frozen as it was at the moment of locking, so pressing
      // Lock (or entering AR mode, which re-measures the floor) changes nothing.
      let L = this._streamLayout;
      if (!this.locked || !L) {
        L = this._computeStreamLayout(a, appear, tanHalf);
        this._streamLayout = this.locked ? L : null;
      }
      const o = this.stream.outer;
      o.visible = visible;
      o.position.copy(a.hip).addScaledVector(a.up, L.floorOffset * a.S); // base on the floor
      o.rotation.set(0, 0, a.roll);
      o.scale.setScalar(a.S * appear);
      this.stream.setFade(L.fadeStart, L.fadeEnd);
      this.stream.update(dt, L.sx, L.sz, this._staticYaw);
    }

    this.scene.updateMatrixWorld();
    if (this.rings.badge) faceCamera(this.rings.badge, this.camera);

    if (this.glitter) {
      this.glitter.material.uniforms.uTime.value = this.time;
      this.glitter.material.uniforms.uScale.value =
        this.pointScale * this.root.scale.z * this.rings.ring1.outer.scale.x; // sprites scale with depth
    }

    // Effects only run once content is showing (bursts already in the air
    // finish naturally).
    const live = this._appearT > 0.6;
    this.fx.update(dt, a, {
      fireworks: settings.fx.fireworks && live,
      fountains: settings.fx.fountains && live,
    });

    // Clip plane through the body axis, facing the camera.
    if (inXR) {
      // world space: vertical plane through the pinned person spot
      const hipW = this.root.localToWorld(_v1.copy(a.hip));
      const n = this.clipNormal.copy(hipW).sub(this.camera.position).setY(0).normalize();
      this.clipPlane.setFromNormalAndCoplanarPoint(n, hipW);
    } else {
      const n = this.clipNormal.copy(a.hip).normalize(); // camera is at the origin
      n.addScaledVector(a.up, -n.dot(a.up)).normalize();
      this.clipPlane.setFromNormalAndCoplanarPoint(n, a.hip);
    }
  }

  render(occlusion = true) {
    if (!this.bgMat.uniforms.map.value) {
      // no camera image yet (e.g. restarting after AR mode): just clear
      this.renderer.clear();
      return;
    }
    this.renderBackground();
    this.renderContent(occlusion);
  }

  renderBackground() {
    this.renderer.clear();
    this.renderer.render(this.bgScene, this.quadCam);
  }

  renderContent(occlusion = true) {
    const r = this.renderer;
    const cam = this.camera;

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

  /**
   * Light-stream layout for the current person and frame:
   *  - sz: front/back scale, so the stream keeps the 3D text's distance
   *  - sx: side-to-side scale, narrowed to fit the portrait frame
   *  - both never below the body clearance (objects must not enter the body)
   *  - floorOffset / fade window measured on this person (torso units)
   */
  _computeStreamLayout(a, appear, tanHalf) {
    const st = this.stream;
    // never closer to the body axis than this (body half-width + biggest object)
    const minScale = STREAM_BODY_CLEARANCE / st.minRadius;
    // match the 3D text's actual front distance (it may be scaled to fit the frame)
    const text = this.rings.ring1;
    const textFront = text?.static ? text.frontZ * text.outer.scale.x : null;
    let sz = textFront ? textFront / (st.maxRadius * a.S * Math.max(appear, 0.05)) : 1;
    sz = THREE.MathUtils.clamp(Math.max(sz, minScale), 0.3, 1.6);
    // narrow side-to-side to fit the frame, checking every angle around the
    // circle (points toward the camera are closer and look wider)
    const D = -a.hip.z;
    const t = tanHalf * this.camera.aspect;
    const offCentre = Math.abs(a.hip.x) / D; // person not centred: less room on one side
    const f = Math.max(0.2, STREAM_FILL - offCentre / t);
    const R = st.maxRadius * a.S * sz;
    let squeeze = 1;
    for (let i = 1; i <= 12; i++) {
      const th = (i / 12) * (Math.PI / 2);
      const depth = Math.max(0.2 * D, D - R * Math.cos(th));
      squeeze = Math.min(squeeze, (f * t * depth) / (R * Math.sin(th)));
    }
    // clearance wins over the frame fit: in a tight close-up the sides may
    // run past the frame edge rather than pass through the body
    const sx = Math.max(Math.min(1, squeeze) * sz, minScale);
    const hipUp = (a.hip.y - a.feetY) / a.S; // floor -> hips, in torso units
    return {
      sx,
      sz,
      floorOffset: -hipUp,
      fadeStart: hipUp / STREAM_HEIGHT,
      fadeEnd: (hipUp + STREAM_CHEST) / STREAM_HEIGHT,
    };
  }

  /* ----------------------- world-lock AR (WebXR) ----------------------- */
  //
  // In this mode ARCore tracks the phone in the room. The content keeps its
  // usual layout (built in "camera space" around the person) but sits under
  // `root`, which pins that layout to the real spot where the person stood at
  // lock time. The camera image comes from WebXR camera-access and everything
  // is still composited on our canvas, so recording works unchanged.

  enterXR() {
    this.xr = { placed: false };
    this.locked = true;
    this.root.visible = false; // until placed in the room
    this.camTex ??= new THREE.ExternalTexture(null);
    this.bgMat.uniforms.map.value = this.camTex;
    this.personMat.uniforms.map.value = this.camTex;
    this.uvXform.set(1, 1, 0, 0); // camera image is aligned with the view
    this.mirror.value = 0;
    this.camera.matrixAutoUpdate = true;
  }

  exitXR() {
    this.xr = null;
    this.locked = false;
    this._streamLayout = null;
    // The ARCore camera texture dies with the session: drawing with it again
    // can crash Chrome's GPU process ("Aw, Snap"). Draw nothing until the
    // normal camera is back (setVideo).
    if (this.camTex) this.camTex.sourceTexture = null;
    this.bgMat.uniforms.map.value = null;
    this.personMat.uniforms.map.value = null;
    this.hasMask = false;
    this.root.position.set(0, 0, 0);
    this.root.quaternion.identity();
    this.root.scale.setScalar(1);
    this.root.visible = true;
    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.identity();
    this.anchor.found = false; // re-acquire the person from scratch
    this._appearT = 0;
    this._tiltFilter.reset();
    this._staticTilt = this._lastSettingsTilt ?? 0.12; // undo the AR tilt correction
    this.resize(); // restores the virtual projection, point scales, frustum
  }

  /** Per XR frame: camera pose/projection from ARCore + the camera image. */
  setXRView(view, cameraTexture) {
    const cam = this.camera;
    const { position: p, orientation: q } = view.transform;
    cam.position.set(p.x, p.y, p.z);
    cam.quaternion.set(q.x, q.y, q.z, q.w);
    cam.projectionMatrix.fromArray(view.projectionMatrix);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.updateMatrixWorld(true);
    this.camTex.sourceTexture = cameraTexture;
  }

  /**
   * From a pose detected in the AR camera image: where the person is, as a
   * ray direction for the feet (for a floor hit test) and the placement data.
   * Returns null if the body isn't visible enough.
   */
  measurePersonForXR(pose, view) {
    this.uvXform.set(1, 1, 0, 0);
    this.mirror.value = 0;
    if (!pose || !this._computeTarget(pose)) return null;
    const t = this._target;
    const m = view.projectionMatrix;
    const P0 = m[0], P5 = m[5], P8 = m[8], P9 = m[9];
    const tanVirtual = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    const halfH = DEPTH * tanVirtual;
    const halfW = halfH * this.camera.aspect;
    const ndcX = t.hip.x / halfW;
    const ndcFeet = t.feetY / halfH;
    return {
      // the same virtual layout as before locking (so nothing changes size
      // or shape at the moment of locking)
      hip: t.hip.clone(),
      S: t.S,
      feetY: t.feetY,
      // the real lens is wider than the virtual one by this factor
      lens: 1 / P5 / tanVirtual,
      feetDir: { x: (ndcX + P8) / P0, y: (ndcFeet + P9) / P5, z: -1 }, // viewer space
    };
  }

  /**
   * Pin the layout in the room. `floorPoint` (world, from a hit test at the
   * person's feet) gives the exact distance; otherwise it's estimated from
   * the person's torso size.
   */
  placeInWorld(measure, floorPoint) {
    const cam = this.camera;
    const camQ = cam.quaternion.clone();
    // gravity-aligned frame: camera position + heading only (no pitch/roll)
    const fwd = _v1.set(0, 0, -1).applyQuaternion(camQ);
    const yawQ = new THREE.Quaternion().setFromAxisAngle(_yAxis, Math.atan2(-fwd.x, -fwd.z));
    const rel = yawQ.clone().invert().multiply(camQ);
    const c = measure.lens;

    // The layout keeps its pre-lock (virtual lens) coordinates. Scaling it by
    // `c` across the view and 1 along depth makes the wider real lens project
    // it onto exactly the same pixels, so locking changes nothing on screen.
    const a = this.anchor;
    // Positions: apply the lens scale in camera axes, then express them in the
    // level (yaw-only) frame where the root scale applies (D⁻¹·tilt·D).
    const D = _lensScale.set(c, c, 1);
    const toLevel = (v) => v.multiply(D).applyQuaternion(rel).divide(D);
    toLevel(a.hip.copy(measure.hip));
    const depthUnits = Math.max(0.5, -a.hip.z);

    let metresPerUnit = TORSO_METRES / (measure.S * c); // estimate from torso size
    if (floorPoint) {
      // The feet ray passes through the ankles (~8 cm up), so it meets the
      // floor slightly behind the person: step back along it to ankle height.
      const C = cam.position;
      const d = _v2.copy(floorPoint).sub(C);
      const back = d.y < -1e-3 ? (floorPoint.y + ANKLE_HEIGHT - C.y) / d.y : 1;
      const ankle = _v3.copy(C).addScaledVector(d, THREE.MathUtils.clamp(back, 0, 1));
      // person's distance straight ahead (horizontal; immune to phone tilt)
      const fwdH = _v1.set(fwd.x, 0, fwd.z).normalize();
      const ahead = (ankle.x - C.x) * fwdH.x + (ankle.z - C.z) * fwdH.z;
      if (ahead > 0.3) metresPerUnit = ahead / depthUnits;
    }

    a.feetY = floorPoint
      ? _v2.copy(floorPoint).sub(cam.position).applyQuaternion(yawQ.clone().invert()).y / (metresPerUnit * c)
      : toLevel(_v3.set(0, measure.feetY, -DEPTH)).y;
    a.up.set(0, 1, 0);
    a.found = true;
    // Keep the current look: same lean, turn and pop-in state as before
    // locking. The tilt is re-expressed in the level frame: it absorbs how far
    // the phone points down and the lens scale (which would otherwise flatten
    // the curve's depth), so the text keeps its exact on-screen shape.
    const T = this._staticTilt;
    const w = toLevel(_v3.set(0, -Math.sin(T), Math.cos(T)));
    const levelTilt = Math.atan2(-w.y, w.z);
    this.xr.tiltOffset = levelTilt - T;
    this._staticTilt = levelTilt;
    this._tiltFilter.reset(); // start from the corrected tilt (no drift)

    this.root.position.copy(cam.position);
    this.root.quaternion.copy(yawQ);
    this.root.scale.set(metresPerUnit * c, metresPerUnit * c, metresPerUnit);
    this.root.visible = true;

    // point sprites: their size scales with depth (root z scale)
    this.fx.setPointScale(this.pointScale * metresPerUnit);
    this.xr.placed = true;
    this.xr.usedFloor = !!floorPoint;
    this.xr.distance = metresPerUnit * depthUnits;
  }

  /**
   * Keep `root` attached to an ARCore anchor (column-major 4x4 pose). The
   * offset between anchor and root is captured on the first call; later
   * anchor corrections are eased in so they never jump.
   */
  followAnchor(anchorMatrix, dt) {
    const anchorM = _m1.fromArray(anchorMatrix);
    if (!this.xr.anchorOffset) {
      this.root.updateMatrix();
      this.xr.anchorOffset = anchorM.clone().invert().multiply(this.root.matrix);
      return;
    }
    _m2.multiplyMatrices(anchorM, this.xr.anchorOffset).decompose(_v1, _q1, _v2);
    const k = damp(ANCHOR_EASE_RATE, dt);
    this.root.position.lerp(_v1, k);
    this.root.quaternion.slerp(_q1, k);
  }

  /** Pop-in animation while in AR mode (normal mode does it in _updateAnchor). */
  updateXRAppear(dt) {
    this._appearT = Math.min(1, this._appearT + dt / APPEAR_TIME);
    this.appearScale = easeOutBack(this._appearT);
  }
}

const TORSO_METRES = 0.5; // typical hip-to-shoulder length, for distance estimates
const ANKLE_HEIGHT = 0.08; // ankle landmark height above the floor (m)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v2d = new THREE.Vector2();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _lensScale = new THREE.Vector3();
const ANCHOR_EASE_RATE = 8; // how quickly ARCore anchor corrections are applied (1/s)
const _yAxis = new THREE.Vector3(0, 1, 0);
