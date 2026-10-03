// World-lock AR mode (WebXR immersive-ar + ARCore), used by the Lock button
// on supporting Android phones.
//
// ARCore tracks the phone's position and rotation in the room, so once the
// content is pinned it stays put like a real object while you walk around.
// We still draw everything (camera image from WebXR camera-access, person
// cut-out, text, fireworks) onto our own canvas, which Chrome shows via DOM
// overlay, so the existing recorder keeps working.

const PLACE_TIMEOUT_MS = 1500; // wait this long for a floor hit before estimating
const NO_CAMERA_FRAMES = 90; // give up if camera-access never delivers images

export class WorldLockXR {
  /**
   * Why world-lock AR can or can't run here, in plain words. Only call this
   * from a user tap: it starts Google's AR service, which crashes on some
   * phones ("Google Play services keeps stopping").
   */
  static async diagnose() {
    if (!window.isSecureContext) return { ok: false, reason: 'page is not opened over https://' };
    if (!navigator.xr) return { ok: false, reason: 'this browser has no WebXR (use Chrome on Android)' };
    try {
      if (!(await navigator.xr.isSessionSupported('immersive-ar'))) {
        return { ok: false, reason: 'AR not supported: install/update "Google Play Services for AR"' };
      }
    } catch (err) {
      return { ok: false, reason: `AR check failed (${err.message})` };
    }
    return { ok: true, reason: 'AR supported' };
  }

  /**
   * @param {object} o
   * @param {import('./arScene.js').ARScene} o.ar
   * @param {import('./tracker.js').PersonTracker} o.tracker
   * @param {() => object} o.getSettings
   * @param {(reason?: string) => void} o.onEnd  called once when the session ends
   * @param {() => void} [o.onAfterFrame]  called after each frame is drawn
   */
  constructor({ ar, tracker, getSettings, onEnd, onAfterFrame }) {
    this.ar = ar;
    this.tracker = tracker;
    this.getSettings = getSettings;
    this.onEnd = onEnd;
    this.onAfterFrame = onAfterFrame;
    this.session = null;
    this.active = false;
    this._onFrame = this._onFrame.bind(this);
  }

  async start() {
    const gl = this.ar.renderer.getContext();
    await gl.makeXRCompatible();
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local', 'camera-access'],
      optionalFeatures: ['dom-overlay', 'hit-test', 'anchors'],
      domOverlay: { root: document.body },
    });
    this.session = session;
    this.active = true;
    this.binding = new XRWebGLBinding(session, gl);
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
    this.refSpace = await session.requestReferenceSpace('local');
    this.viewerSpace = await session.requestReferenceSpace('viewer').catch(() => null);
    this.hitTest = session.enabledFeatures ? session.enabledFeatures.includes('hit-test') : !!this.viewerSpace;
    session.addEventListener('end', () => this._ended());
    this._lastT = null;
    this._ending = false;
    this._noCamera = 0;
    this._placeStart = null;
    this._hitSource = null;
    session.requestAnimationFrame(this._onFrame);
  }

  end(reason) {
    this._endReason = reason;
    // Release AR resources while the session is still alive. Touching an
    // anchor or hit-test source after the session has ended can crash
    // Chrome's page process ("Aw, Snap").
    this._releaseXrResources();
    this._ending = true; // stop drawing with session objects from now on
    this.session?.end().catch(() => this._ended());
  }

  _releaseXrResources() {
    try {
      this._hitSource?.cancel?.();
    } catch {
      /* already gone */
    }
    try {
      this._worldAnchor?.delete?.();
    } catch {
      /* already gone */
    }
    this._hitSource = null;
    this._worldAnchor = null;
  }

  _ended() {
    if (!this.active) return;
    this.active = false;
    // The session is gone: only drop references, never call into its objects.
    this._hitSource = null;
    this._worldAnchor = null;
    this.binding = null;
    this.session = null;
    this.onEnd?.(this._endReason);
  }

  _onFrame(t, frame) {
    if (!this.active || this._ending) return; // session is closing: no more frames
    const session = frame.session;
    session.requestAnimationFrame(this._onFrame);
    const pose = frame.getViewerPose(this.refSpace);
    if (!pose) return; // tracking not ready yet
    const view = pose.views[0];
    if (!view.camera) {
      if (++this._noCamera > NO_CAMERA_FRAMES) this.end('Camera access is not available in AR mode on this phone.');
      return;
    }
    const cameraTexture = this.binding.getCameraImage(view.camera);
    if (!cameraTexture) return;

    const ar = this.ar;
    const settings = this.getSettings();
    const dt = this._lastT === null ? 1 / 60 : Math.min(0.05, (t - this._lastT) / 1000);
    this._lastT = t;

    // 1. camera image onto our canvas
    ar.setXRView(view, cameraTexture);
    ar.renderBackground();

    // 2. detect on that image (the canvas currently holds only the camera)
    const placed = ar.xr.placed;
    this.tracker.detectSource(ar.renderer.domElement, { pose: !placed });
    ar.updateMask(this.tracker);

    // 3. pin the content once we know where the person is; afterwards follow
    // the ARCore anchor, which ARCore keeps correcting as it maps the room
    if (!placed) this._tryPlace(frame, view, t);
    else {
      ar.updateXRAppear(dt);
      if (this._worldAnchor) {
        const ap = frame.getPose(this._worldAnchor.anchorSpace, this.refSpace);
        if (ap) ar.followAnchor(ap.transform.matrix, dt);
      }
    }

    // 4. draw the content (cut-out only once placed)
    ar.update(dt, { settings, gyro: null });
    ar.renderContent(settings.occlusion && ar.xr.placed);
    this.onAfterFrame?.();
  }

  _tryPlace(frame, view, t) {
    const ar = this.ar;
    const measure = ar.measurePersonForXR(this.tracker.pose, view);
    if (!measure) {
      this._placeStart = null; // wait until the person is in view
      return;
    }
    if (this._placeStart === null) {
      this._placeStart = t;
      // Ray from the phone through the person's feet: where it hits the floor
      // tells us exactly how far away they are.
      if (this.hitTest && this.viewerSpace && !this._hitRequested) {
        this._hitRequested = true;
        const d = measure.feetDir;
        this.session
          .requestHitTestSource({
            space: this.viewerSpace,
            offsetRay: new XRRay(new DOMPointReadOnly(0, 0, 0, 1), new DOMPointReadOnly(d.x, d.y, d.z, 0)),
          })
          .then((src) => (this._hitSource = src))
          .catch(() => (this.hitTest = false));
      }
    }

    let floor = null;
    let hit = null;
    if (this._hitSource) {
      hit = frame.getHitTestResults(this._hitSource)[0] ?? null;
      const p = hit?.getPose(this.refSpace)?.transform.position;
      if (p) floor = { x: p.x, y: p.y, z: p.z };
    }
    if (floor || t - this._placeStart > PLACE_TIMEOUT_MS) {
      ar.placeInWorld(measure, floor ? new (ar.anchor.hip.constructor)(floor.x, floor.y, floor.z) : null);
      this._createAnchor(frame, floor ? hit : null);
      this._hitSource?.cancel?.();
      this._hitSource = null;
    }
  }

  /**
   * Attach the content to an ARCore anchor: on the floor surface under the
   * person when we have a floor hit, otherwise at the content's spot. ARCore
   * refines anchors as it learns the room, which removes slow tracking drift.
   * Optional: without the 'anchors' feature the content just stays where it
   * was placed.
   */
  _createAnchor(frame, hit) {
    const r = this.ar.root;
    let pending = null;
    try {
      if (hit?.createAnchor) pending = hit.createAnchor();
      else if (frame.createAnchor) {
        const pose = new XRRigidTransform(
          { x: r.position.x, y: r.position.y, z: r.position.z },
          { x: r.quaternion.x, y: r.quaternion.y, z: r.quaternion.z, w: r.quaternion.w },
        );
        pending = frame.createAnchor(pose, this.refSpace);
      }
    } catch (err) {
      console.warn('Could not create an AR anchor', err);
    }
    pending
      ?.then((anchor) => {
        if (!this.active) return; // session already gone: never touch its objects
        if (this._ending) {
          try {
            anchor.delete?.(); // session still alive but closing: release now
          } catch {
            /* ignore */
          }
          return;
        }
        this._worldAnchor = anchor;
        this.ar.xr.anchored = true;
      })
      .catch((err) => console.warn('AR anchor failed', err));
  }
}
