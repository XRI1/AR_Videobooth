// Scene settings with localStorage persistence (per device).

export const isMobile =
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));

const STORAGE_KEY = 'ar360.settings.v1';

export function defaultSettings() {
  return {
    ring1: {
      enabled: true,
      text: 'GUT GUARDIAN',
      mode: 'front', // 'front' = static label in front of the body, 'orbit' = spins around
      color: '#1a73e8',
      edge: '#ffffff',
      italic: true,
      height: 0.35, // in torso units: 0 = hips, 1 = shoulders
      radius: 1.05,
      size: 0.3,
      speed: -0.8, // rad/s
    },
    ring2: {
      enabled: true,
      text: 'GUT GUARDIAN',
      mode: 'front', // 'front' = static label in front of the body, 'orbit' = spins around
      color: '#f5b301',
      edge: '#fff4c2',
      italic: false,
      height: -1.3,
      radius: 0.95,
      size: 0.17,
      speed: 0.55,
    },
    badge: {
      enabled: true,
      text: '2.0',
      mode: 'front', // 'front' = still, fanned out in front; 'orbit' = circles the body
      count: 2,
      height: 1.05,
      radius: 1.35,
      size: 0.55,
      speed: 0.9,
    },
    fx: { fireworks: true, fountains: true, glitter: true },
    occlusion: true,
    tilt: 0.12,
    invertGyro: false,
    mic: true,
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

// Texts that were defaults in earlier versions: if a device still has one of
// these saved (i.e. it was never customised), move it to the current default.
const OLD_DEFAULT_TEXTS = {
  ring1: ['Therap', 'GUT GURDIAN'],
  ring2: ['CELEBRATING 20 YEARS', 'GUT GURDIAN'],
  badge: ['20 YEARS'],
};
function migrateTexts(s) {
  const d = defaultSettings();
  for (const [key, olds] of Object.entries(OLD_DEFAULT_TEXTS)) {
    if (olds.includes(s[key].text)) s[key].text = d[key].text;
  }
}

export function loadSettings() {
  const s = defaultSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) merge(s, JSON.parse(raw));
    migrateTexts(s);
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
