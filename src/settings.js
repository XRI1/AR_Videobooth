// Scene settings with localStorage persistence (per device).

export const isMobile =
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));

const STORAGE_KEY = 'ar360.settings.v1';
// Bump when a one-time change must reach saved settings (see loadSettings).
const SETTINGS_REV = 6;

export function defaultSettings() {
  return {
    rev: SETTINGS_REV,
    show3d: true, // false hides every 3D element (only the camera image is shown and recorded)
    ring1: {
      enabled: true,
      text: 'GUT GUARDIAN',
      logoText: true, // show the 3D brand lettering "gut SYNBIO" instead of the text above
      mode: 'front', // 'front' = static label in front of the body, 'orbit' = spins around
      color: '#1a73e8',
      edge: '#ffffff',
      italic: true,
      height: 0.35, // in torso units: 0 = hips, 1 = shoulders
      radius: 1.3, // distance in front of the body (torso units)
      size: 0.3,
      speed: -0.8, // rad/s
    },
    ring2: {
      enabled: false, // second (orange) text ring: off by default
      text: 'GUT GUARDIAN',
      mode: 'front', // 'front' = static label in front of the body, 'orbit' = spins around
      color: '#f5b301',
      edge: '#fff4c2',
      italic: false,
      height: -1.3,
      radius: 1.15,
      size: 0.17,
      speed: 0.55,
    },
    badge: {
      enabled: false, // "2.0" bubbles: off by default
      text: '2.0',
      mode: 'front', // 'front' = still, fanned out in front; 'orbit' = circles the body
      count: 2,
      height: 1.05,
      radius: 1.35,
      size: 0.55,
      speed: 0.9,
    },
    fx: {
      fireworks: false, // rockets that shoot up and burst: removed from the booth
      fountains: true,
      glitter: true,
      stream: true, // 3D light stream with flowing glass capsules / cubes
      streamStyle: 'both', // 'capsules' | 'cubes' | 'both'
    },
    occlusion: true,
    tilt: 0.12,
    invertGyro: false,
    arLock: true, // Lock uses WebXR/ARCore world lock when available (Android)
    mic: false, // record video without sound (no microphone permission needed)
    model: isMobile ? 'lite' : 'full',
    mask: 'fast',
    font: 'helvetiker_bold',
  };
}

function merge(base, over) {
  for (const k of Object.keys(base)) {
    if (over?.[k] === undefined) continue;
    if (typeof base[k] === 'object' && base[k] !== null) merge(base[k], over[k]);
    else if (typeof over[k] === typeof base[k]) base[k] = over[k];
  }
  return base;
}

// Values that were defaults in earlier versions: if a device still has one of
// these saved (i.e. it was never customised), move it to the current default.
const OLD_DEFAULTS = {
  'ring1.text': ['Therap', 'GUT GURDIAN'],
  'ring2.text': ['CELEBRATING 20 YEARS', 'GUT GURDIAN'],
  'badge.text': ['20 YEARS'],
  'ring1.radius': [1.05],
  'ring2.radius': [0.95],
};
function migrateDefaults(s) {
  const d = defaultSettings();
  for (const [path, olds] of Object.entries(OLD_DEFAULTS)) {
    if (olds.includes(getPath(s, path))) setPath(s, path, getPath(d, path));
  }
}

export function loadSettings() {
  const s = defaultSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    if (saved) merge(s, saved);
    migrateDefaults(s);
    // One-time changes for settings saved by older versions (applied once;
    // the user can change them back afterwards).
    if (saved && (saved.rev ?? 1) < 2) {
      s.ring2.enabled = false; // rev 2: orange second text ring removed
    }
    if (saved && (saved.rev ?? 1) < 3) {
      s.badge.enabled = false; // rev 3: "2.0" bubbles removed
    }
    if (saved && (saved.rev ?? 1) < 4) {
      s.mic = false; // rev 4: videos are recorded without audio
    }
    if (saved && (saved.rev ?? 1) < 5) {
      s.ring1.logoText = true; // rev 5: 3D text is now the "gut SYNBIO" brand lettering
    }
    if (saved && (saved.rev ?? 1) < 6) {
      s.fx.fireworks = false; // rev 6: firework bursts removed
    }
    if (saved && saved.rev !== SETTINGS_REV) {
      s.rev = SETTINGS_REV;
      saveSettings(s);
    }
  } catch {
    /* storage unavailable: use defaults */
  }
  return s;
}

export function saveSettings(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}
