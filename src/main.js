import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { Camera } from './camera.js';
import { PersonTracker } from './tracker.js';
import { Gyro } from './gyro.js';
import { Recorder } from './recorder.js';
import { ARScene } from './arScene.js';
import { loadSettings, saveSettings, defaultSettings, getPath, setPath, isMobile } from './settings.js';

const BASE = import.meta.env.BASE_URL;
const MAX_RECORD_SECONDS = 60;
const $ = (id) => document.getElementById(id);

let settings = loadSettings();
const camera = new Camera();
const tracker = new PersonTracker();
const gyro = new Gyro();
let ar = null;
let recorder = null;
let logo = null; // { texture, aspect } from an uploaded image
let photoRequested = false;
let resultUrl = null;
const fonts = new Map();

/* ------------------------------ helpers ------------------------------ */

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

async function loadFont(name) {
  if (!fonts.has(name)) {
    fonts.set(name, new FontLoader().loadAsync(`${BASE}fonts/${name}.typeface.json`));
  }
  return fonts.get(name);
}

let rebuildTimer;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 120);
}
async function rebuild() {
  if (!ar) return;
  const font = await loadFont(settings.font);
  ar.buildContent(settings, font, logo);
}

const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/* ------------------------------ startup ------------------------------ */

$('btnStart').addEventListener('click', () => start());
$('fileSource').addEventListener('change', (e) => e.target.files?.[0] && start(e.target.files[0]));

async function start(file = null) {
  const status = $('introStatus');
  const btn = $('btnStart');
  if (!file && (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)) {
    status.textContent = 'Camera needs HTTPS. Open this page via https:// (see README).';
    return;
  }
  btn.disabled = true;
  try {
    status.textContent = file ? 'Loading video…' : 'Starting camera…';
    if (file) await camera.startFromFile(file);
    else await camera.start(isMobile ? 'environment' : 'user', settings.mic);

    ar = new ARScene($('stage'));
    ar.setVideo(camera.video);
    ar.setMirrored(camera.mirrored);
    recorder = new Recorder($('stage'));

    status.textContent = 'Loading 3D text & AI body tracking…';
    const [font] = await Promise.all([loadFont(settings.font), tracker.init(settings.model, settings.mask)]);
    ar.buildContent(settings, font, logo);
    if (import.meta.env.DEV) window.__app = { ar, tracker, camera, gyro, get settings() { return settings; } };

    $('intro').classList.add('hidden');
    $('hud-top').classList.remove('hidden');
    $('hud-bottom').classList.remove('hidden');
    window.addEventListener('resize', () => ar.resize());
    requestAnimationFrame(frame);
    toast(isMobile ? 'Point at a person, press record and walk around them' : 'Step back so your upper body is visible');
  } catch (err) {
    console.error(err);
    status.textContent = `Could not start: ${err.message || err}`;
    btn.disabled = false;
  }
}

/* ------------------------------ main loop ------------------------------ */

let last = performance.now();
let hudTick = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;

  tracker.detect(camera.video);
  ar.updateMask(tracker);
  ar.update(dt, {
    pose: tracker.pose,
    poseVersion: tracker.poseVersion,
    poseTime: tracker.poseTime,
    settings,
    gyro,
  });
  ar.render(settings.occlusion);

  if (photoRequested) {
    photoRequested = false;
    // Must read the canvas in the same task as the render.
    $('stage').toBlob((blob) => blob && showResult(blob, 'image'), 'image/jpeg', 0.92);
  }

  if (now - hudTick > 200) {
    hudTick = now;
    updateHud();
    updateLockButton();
  }
}

function updateHud() {
  const pill = $('trackPill');
  if (recorder?.isRecording) {
    const t = recorder.elapsed;
    pill.className = 'pill rec';
    pill.textContent = `● REC ${fmtTime(t)}`;
    $('recTime').textContent = fmtTime(t);
    if (t >= MAX_RECORD_SECONDS) stopRecording();
    return;
  }
  if (ar.locked) {
    // Live orbit angle, so it's obvious whether the motion sensor is working.
    const deg = ((Math.round(THREE.MathUtils.radToDeg(gyro.yaw - ar.lockYaw)) % 360) + 360) % 360;
    pill.className = `pill ${gyro.available ? 'ok' : 'warn'}`;
    pill.textContent = gyro.available ? `Locked · ${deg}°` : 'Locked · no sensor';
    return;
  }
  const found = tracker.hasPerson;
  pill.className = `pill ${found ? 'ok' : 'warn'}`;
  pill.textContent = found
    ? gyro.enabled
      ? 'Person locked · 360° on'
      : 'Person locked'
    : 'Looking for a person…';
}

function updateLockButton() {
  // Offer the lock once a person has been found (or while already locked).
  const btn = $('btnLock');
  btn.classList.toggle('hidden', !(ar?.anchor.found || ar?.locked));
  btn.classList.toggle('active', !!ar?.locked);
  btn.setAttribute('aria-pressed', String(!!ar?.locked));
  btn.title = ar?.locked ? 'Unlock: text follows the body again' : 'Lock text in place';
}

/* ------------------------------ lock ------------------------------ */

$('btnLock').addEventListener('click', async () => {
  if (!ar) return;
  if (ar.locked) {
    ar.setLocked(false);
    toast('Unlocked: text follows the body again');
  } else {
    // Pin to the room using the motion sensor (permission prompt on iOS must
    // come from this tap). Without a sensor it stays pinned to the screen.
    let sensor = true;
    try {
      await gyro.listen();
    } catch {
      sensor = false;
    }
    ar.setLocked(true, gyro);
    toast(
      sensor
        ? 'Locked: walk around the person, the text stays facing the same way in the room'
        : 'Locked, but motion sensor is blocked: the text will keep facing the camera',
      4000,
    );
    if (sensor) {
      setTimeout(() => {
        if (ar.locked && !gyro.available) toast('No motion sensor readings: the text will keep facing the camera', 4000);
      }, 1500);
    }
  }
  updateLockButton();
  updateHud();
});

/* ------------------------------ recording ------------------------------ */

$('btnRecord').addEventListener('click', () => {
  if (recorder.isRecording) stopRecording();
  else startRecording();
});

function startRecording() {
  try {
    recorder.start(settings.mic ? camera.audioTrack : null);
  } catch (err) {
    toast(err.message);
    return;
  }
  // (don't reset the heading while locked: it would snap the text to the front)
  if (gyro.enabled && !ar.locked) gyro.reset();
  $('btnRecord').classList.add('recording');
  document.body.classList.add('is-recording');
  $('settings').classList.remove('open');
}

async function stopRecording() {
  $('btnRecord').classList.remove('recording');
  document.body.classList.remove('is-recording');
  const blob = await recorder.stop();
  if (blob?.size) showResult(blob, 'video');
  else toast('Recording failed — nothing was captured.');
}

$('btnPhoto').addEventListener('click', () => (photoRequested = true));
$('btnFx').addEventListener('click', () => ar?.salvo());

function showResult(blob, kind) {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = URL.createObjectURL(blob);
  const ext = kind === 'image' ? 'jpg' : recorder.extension;
  const name = `ar360-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`;
  const vid = $('resultVideo');
  const img = $('resultImage');
  vid.classList.toggle('hidden', kind !== 'video');
  img.classList.toggle('hidden', kind !== 'image');
  if (kind === 'video') {
    vid.src = resultUrl;
    vid.play().catch(() => {});
  } else {
    img.src = resultUrl;
  }
  const dl = $('btnDownload');
  dl.href = resultUrl;
  dl.download = name;
  $('resultInfo').textContent = `${(blob.size / 1048576).toFixed(1)} MB · ${blob.type || ext}`;

  const file = new File([blob], name, { type: blob.type });
  const canShare = navigator.canShare?.({ files: [file] });
  $('btnShare').classList.toggle('hidden', !canShare);
  $('btnShare').onclick = () => navigator.share({ files: [file], title: 'My AR video' }).catch(() => {});
  $('result').classList.remove('hidden');
}

$('btnCloseResult').addEventListener('click', () => {
  const vid = $('resultVideo');
  vid.pause();
  vid.removeAttribute('src');
  vid.load();
  $('result').classList.add('hidden');
});

/* ------------------------------ camera / gyro ------------------------------ */

$('btnFlip').addEventListener('click', async () => {
  if (recorder?.isRecording) return;
  try {
    await camera.flip(settings.mic);
    ar.setVideo(camera.video);
    ar.setMirrored(camera.mirrored);
  } catch (err) {
    toast(`Camera switch failed: ${err.message}`);
  }
});

$('btnGyro').addEventListener('click', async () => {
  const btn = $('btnGyro');
  if (gyro.enabled) {
    gyro.disable();
    btn.classList.remove('active');
    toast('360° lock off');
    return;
  }
  try {
    await gyro.enable();
    if (ar?.locked) ar.setLocked(true, gyro); // heading was reset: re-baseline the lock
    btn.classList.add('active');
    toast('360° lock on — the ring stays fixed in the room as you walk around');
    setTimeout(() => {
      if (gyro.enabled && !gyro.available) {
        gyro.disable();
        btn.classList.remove('active');
        toast('No motion sensor found on this device.');
      }
    }, 1500);
  } catch (err) {
    toast(err.message);
  }
});

/* ------------------------------ settings UI ------------------------------ */

const drawer = $('settings');
$('btnSettings').addEventListener('click', () => drawer.classList.toggle('open'));
$('btnCloseSettings').addEventListener('click', () => drawer.classList.remove('open'));

const inputs = [...document.querySelectorAll('[data-key]')];

function syncInputs() {
  for (const el of inputs) {
    const v = getPath(settings, el.dataset.key);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
}
syncInputs();

for (const el of inputs) {
  const evt = el.type === 'checkbox' || el.tagName === 'SELECT' || el.type === 'color' ? 'change' : 'input';
  el.addEventListener(evt, () => onSettingChange(el));
}

async function onSettingChange(el) {
  const key = el.dataset.key;
  let value;
  if (el.type === 'checkbox') value = el.checked;
  else if (el.type === 'range') value = parseFloat(el.value);
  else value = el.value;
  setPath(settings, key, value);
  saveSettings(settings);
  if (!ar) return;

  // Live-tweakable without rebuilding geometry
  const [group, prop] = key.split('.');
  const ring = ar.rings[group];
  if (ring && prop === 'speed') return void (ring.speed = value);
  if (ring && prop === 'height') return void (ring.height = value);
  if (['tilt', 'occlusion', 'invertGyro', 'fx.fireworks', 'fx.fountains'].includes(key)) return;

  if (key === 'model' || key === 'mask') {
    toast('Loading model…');
    try {
      await (key === 'model' ? tracker.initPose(value) : tracker.initMask(value));
      toast('Model ready');
    } catch (err) {
      toast(`Model failed to load: ${err.message}`);
    }
    return;
  }
  if (key === 'mic') {
    if (recorder?.isRecording) return;
    await camera.start(camera.facing, value);
    ar.setVideo(camera.video);
    return;
  }
  scheduleRebuild();
}

$('logoInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    const tex = new THREE.Texture(bmp);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.flipY = false; // ImageBitmap uploads ignore flipY; geometry UVs handle orientation below
    tex.repeat.set(1, -1);
    tex.offset.set(0, 1);
    tex.needsUpdate = true;
    logo?.texture.dispose();
    logo = { texture: tex, aspect: bmp.width / bmp.height };
    settings.badge.enabled = true;
    syncInputs();
    scheduleRebuild();
    toast('Logo added to the orbit');
  } catch (err) {
    toast(`Could not load image: ${err.message}`);
  }
});

$('btnClearLogo').addEventListener('click', () => {
  logo?.texture.dispose();
  logo = null;
  $('logoInput').value = '';
  scheduleRebuild();
});

$('btnReset').addEventListener('click', () => {
  settings = defaultSettings();
  saveSettings(settings);
  syncInputs();
  scheduleRebuild();
  toast('Settings reset');
});
