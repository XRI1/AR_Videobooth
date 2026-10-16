// 2D photo-booth frame drawn over the video (and saved in recordings), in the
// Gut Synbio style: a glowing cyan -> royal -> lime border with a navy band
// outside it, glass capsules (probiotic) in the left corners and blue / lime
// glass cubes (prebiotic) in the right corners, light streams and bubbles,
// the 2D logo at the top and a tagline plaque at the bottom.
//
// Drawn with the 2D canvas at the exact output size, so it fits any screen.

const ROYAL = '#1631d8';
const ROYAL_DEEP = '#0a1aa6';
const NAVY = '#050d63';
const CYAN = '#3fd4ff';
const LIME = '#b6f01e';
const LOGO_LETTERING = 0.899; // top share of the logo image that holds the lettering (the rest is the tagline)

/**
 * Draw the frame into a canvas of size W x H.
 * @param {CanvasRenderingContext2D} g
 * @param {object} o
 * @param {HTMLImageElement|null} o.logo  2D logo (transparent background)
 * @param {number} o.logoTop  y of the logo's top edge, in canvas px
 * @param {string} o.font  display font family (e.g. 'Fredoka')
 * @returns {{ plaqueTop: number }}  y of the bottom plaque's top edge (to keep buttons clear of it)
 */
export function drawBoothFrame(g, W, H, { logo = null, logoTop = 0, font = 'Fredoka' } = {}) {
  const u = W / 100; // 1 unit = 1% of the width
  const m = 2.4 * u; // border inset
  const lw = 1.3 * u; // border thickness
  const r = 6 * u; // corner radius
  g.clearRect(0, 0, W, H);
  g.save();

  // --- navy band outside the border (makes it read as a frame) ---
  g.beginPath();
  g.rect(0, 0, W, H);
  roundRect(g, m + lw / 2, m + lw / 2, W - 2 * m - lw, H - 2 * m - lw, r);
  const band = g.createLinearGradient(0, 0, 0, H);
  band.addColorStop(0, 'rgba(10,26,166,0.78)');
  band.addColorStop(1, 'rgba(5,13,99,0.82)');
  g.fillStyle = band;
  g.fill('evenodd');

  // --- light streams sweeping in from the bottom corners ---
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const k = i / 5;
      const x0 = side < 0 ? m : W - m; // border edge on this side
      // from up the side border, bending round the bottom corner, into the bottom border
      g.beginPath();
      g.moveTo(x0 - side * (0.6 + 2.2 * k) * u, H * (0.66 + 0.12 * k));
      g.quadraticCurveTo(x0 - side * (1 + 5 * k) * u, H - m - (1 + 4 * k) * u, x0 - side * (30 - 14 * k) * u, H - m - (0.4 + 1.6 * k) * u);
      g.strokeStyle = i % 3 === 2 ? 'rgba(182,240,30,0.55)' : 'rgba(63,212,255,0.6)';
      g.lineWidth = (0.25 + 0.25 * (1 - k)) * u;
      g.shadowColor = CYAN;
      g.shadowBlur = 2 * u;
      g.stroke();
    }
  }
  g.shadowBlur = 0;

  // --- the glowing border: thick gradient line + thin white inner line ---
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, CYAN);
  grad.addColorStop(0.45, ROYAL);
  grad.addColorStop(0.75, '#2a8cff');
  grad.addColorStop(1, LIME);
  g.beginPath();
  roundRect(g, m + lw / 2, m + lw / 2, W - 2 * m - lw, H - 2 * m - lw, r);
  g.strokeStyle = grad;
  g.lineWidth = lw;
  g.shadowColor = CYAN;
  g.shadowBlur = 3.5 * u;
  g.stroke();
  g.shadowBlur = 0;
  g.beginPath();
  roundRect(g, m + lw * 1.35, m + lw * 1.35, W - 2 * (m + lw * 1.35), H - 2 * (m + lw * 1.35), r * 0.8);
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = 0.3 * u;
  g.stroke();

  // --- molecule networks (like the icons' plaques), faint, in the band corners ---
  molecule(g, m + 9 * u, H * 0.42, 3.2 * u, u);
  molecule(g, W - m - 9 * u, H * 0.56, 3.2 * u, u);
  molecule(g, W - m - 26 * u, m + 4 * u, 2.2 * u, u);
  molecule(g, m + 28 * u, H - m - 10 * u, 2.2 * u, u);

  // --- tech corner brackets just inside the border ---
  const ci = m + lw * 2.6; // inset of the brackets
  const cl = 9 * u; // bracket arm length
  g.lineWidth = 0.7 * u;
  g.lineCap = 'round';
  g.shadowColor = CYAN;
  g.shadowBlur = 1.6 * u;
  for (const [x, y, sx, sy, col] of [
    [ci, ci, 1, 1, CYAN],
    [W - ci, ci, -1, 1, LIME],
    [ci, H - ci, 1, -1, LIME],
    [W - ci, H - ci, -1, -1, CYAN],
  ]) {
    g.beginPath();
    g.moveTo(x, y + sy * cl);
    g.lineTo(x, y + sy * 2 * u);
    g.quadraticCurveTo(x, y, x + sx * 2 * u, y);
    g.lineTo(x + sx * cl, y);
    g.strokeStyle = col;
    g.stroke();
  }

  // --- glowing energy dashes along the middle of the side borders ---
  for (const side of [-1, 1]) {
    const x = side < 0 ? m + lw / 2 : W - m - lw / 2;
    for (let i = 0; i < 7; i++) {
      const y = H * (0.3 + i * 0.045);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y + H * 0.022);
      g.strokeStyle = i % 2 ? LIME : '#e9fbff';
      g.lineWidth = 0.55 * u;
      g.stroke();
    }
  }
  g.shadowBlur = 0;
  g.lineCap = 'butt';

  // --- corner decorations: capsules left, cubes right, bubbles everywhere ---
  // extra pieces part-way down the sides
  capsule(g, m + 2.5 * u, H * 0.27, 7 * u, 1.7 * u, -1.4, CYAN, u);
  capsule(g, m + 3 * u, H * 0.7, 6.5 * u, 1.6 * u, 1.2, '#2a8cff', u);
  cube(g, W - m - 3 * u, H * 0.25, 2.8 * u, LIME, u);
  cube(g, W - m - 3.2 * u, H * 0.72, 3 * u, '#2a8cff', u);
  const rand = seeded(7);
  capsule(g, m + 7 * u, m + 9 * u, 15 * u, 3.2 * u, -0.75, ROYAL, u);
  capsule(g, m + 15 * u, m + 3.5 * u, 9 * u, 2.2 * u, -0.25, CYAN, u);
  capsule(g, m + 3 * u, m + 19 * u, 8 * u, 1.9 * u, -1.25, '#2a8cff', u);
  capsule(g, m + 8 * u, H - m - 16 * u, 13 * u, 2.8 * u, 0.6, ROYAL, u);
  capsule(g, m + 16 * u, H - m - 7 * u, 8 * u, 2 * u, 0.15, CYAN, u);
  cube(g, W - m - 9 * u, m + 8 * u, 6.5 * u, LIME, u);
  cube(g, W - m - 19 * u, m + 4 * u, 4 * u, '#2a8cff', u);
  cube(g, W - m - 4 * u, m + 18 * u, 3.6 * u, '#2a8cff', u);
  cube(g, W - m - 9 * u, H - m - 15 * u, 5.5 * u, '#2a8cff', u);
  cube(g, W - m - 18 * u, H - m - 7 * u, 3.8 * u, LIME, u);
  for (let i = 0; i < 26; i++) {
    // bubbles along the border, denser near the corners
    const t = rand();
    const corner = Math.floor(rand() * 4);
    const along = Math.pow(t, 1.6) * 0.35;
    let x;
    let y;
    if (corner < 2) {
      x = corner === 0 ? m + along * W : W - m - along * W;
      y = m + (rand() - 0.5) * 3 * u;
    } else {
      x = corner === 2 ? m + (rand() - 0.5) * 3 * u : W - m + (rand() - 0.5) * 3 * u;
      y = m + along * H * 0.6;
    }
    if (rand() < 0.5) y = H - y; // mirror half of them to the bottom corners
    bubble(g, x, y, (0.5 + rand() * 1.3) * u, rand() < 0.2 ? LIME : CYAN);
  }
  // sparkle glints on the border
  for (const [x, y, s] of [
    [m + 26 * u, m + lw / 2, 2.6],
    [W - m - 30 * u, m + lw / 2, 2.2],
    [m + lw / 2, H * 0.52, 2],
    [W - m - lw / 2, H * 0.4, 2.4],
    [m + 34 * u, H - m - lw / 2, 1.8],
    [W - m - 24 * u, H - m - lw / 2, 2.6],
    [W - m - 12 * u, m + 16 * u, 1.6],
    [m + 14 * u, H - m - 24 * u, 1.5],
  ]) sparkle(g, x, y, s * u);

  // --- 2D logo at the top ---
  if (logo) {
    // lettering only: the tagline is on the bottom plaque instead
    const sh = Math.round(logo.naturalHeight * LOGO_LETTERING);
    const lwid = W * 0.6;
    const lh = (lwid * sh) / logo.naturalWidth;
    // soft cyan halo so the logo reads on any background
    const halo = g.createRadialGradient(W / 2, logoTop + lh / 2, lh * 0.1, W / 2, logoTop + lh / 2, lwid * 0.62);
    halo.addColorStop(0, 'rgba(22,49,216,0.42)');
    halo.addColorStop(0.55, 'rgba(63,212,255,0.12)');
    halo.addColorStop(1, 'rgba(63,212,255,0)');
    g.fillStyle = halo;
    g.fillRect(W / 2 - lwid * 0.7, logoTop - lh * 0.6, lwid * 1.4, lh * 2.2);
    g.shadowColor = 'rgba(63,212,255,0.9)';
    g.shadowBlur = 3 * u;
    g.drawImage(logo, 0, 0, logo.naturalWidth, sh, (W - lwid) / 2, logoTop, lwid, lh);
    g.shadowBlur = 0;
  }

  // --- tagline plaque at the bottom, sitting on the border ---
  const ph = 7.6 * u;
  const pw = 84 * u;
  const px = (W - pw) / 2;
  const py = H - m - lw / 2 - ph / 2 - 0.4 * u;
  g.beginPath();
  roundRect(g, px, py, pw, ph, ph / 2);
  const plate = g.createLinearGradient(0, py, 0, py + ph);
  plate.addColorStop(0, '#2a5bff');
  plate.addColorStop(0.55, ROYAL_DEEP);
  plate.addColorStop(1, NAVY);
  g.fillStyle = plate;
  g.shadowColor = CYAN;
  g.shadowBlur = 3 * u;
  g.fill();
  g.shadowBlur = 0;
  g.lineWidth = 0.5 * u;
  g.strokeStyle = CYAN;
  g.stroke();
  // capsule and cube badges at the ends of the plaque
  capsule(g, px + ph * 0.05, py + ph / 2, ph * 1.05, ph * 0.26, -0.5, ROYAL, u);
  cube(g, px + pw - ph * 0.05, py + ph * 0.55, ph * 0.36, LIME, u);
  // glossy highlight on the plaque
  g.beginPath();
  roundRect(g, px + ph * 0.3, py + ph * 0.12, pw - ph * 0.6, ph * 0.32, ph * 0.16);
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.fill();
  // text: white + lime, fitted to the plaque
  const a = 'ACTIVATING GROWTH THROUGH ';
  const b = 'SYNBIOTIC SCIENCE';
  let fs = ph * 0.46;
  const setFont = () => (g.font = `700 ${fs}px "${font}", "Nunito", system-ui, sans-serif`);
  setFont();
  while (g.measureText(a + b).width > pw - ph * 0.9 && fs > 4) {
    fs *= 0.95;
    setFont();
  }
  const tw = g.measureText(a + b).width;
  let tx = W / 2 - tw / 2;
  const ty = py + ph / 2;
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = 0.6 * u;
  g.fillStyle = '#ffffff';
  g.fillText(a, tx, ty);
  tx += g.measureText(a).width;
  g.fillStyle = LIME;
  g.fillText(b, tx, ty);
  g.shadowBlur = 0;

  g.restore();
  return { plaqueTop: py };
}

/* ------------------------------ shapes ------------------------------ */

function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/** Glossy glass capsule centred at (x, y), `len` long, radius `rad`, rotated by `angle`. */
function capsule(g, x, y, len, rad, angle, color, u) {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  const half = len / 2 - rad;
  const body = () => {
    g.beginPath();
    g.moveTo(-half, -rad);
    g.lineTo(half, -rad);
    g.arc(half, 0, rad, -Math.PI / 2, Math.PI / 2);
    g.lineTo(-half, rad);
    g.arc(-half, 0, rad, Math.PI / 2, (3 * Math.PI) / 2);
    g.closePath();
  };
  body();
  const fill = g.createLinearGradient(0, -rad, 0, rad);
  fill.addColorStop(0, 'rgba(160,230,255,0.95)');
  fill.addColorStop(0.35, color);
  fill.addColorStop(1, 'rgba(5,13,99,0.95)');
  g.fillStyle = fill;
  g.shadowColor = CYAN;
  g.shadowBlur = 2.2 * u;
  g.fill();
  g.shadowBlur = 0;
  g.lineWidth = 0.35 * u;
  g.strokeStyle = 'rgba(200,245,255,0.9)';
  g.stroke();
  // middle seam + highlight
  g.beginPath();
  g.moveTo(0, -rad);
  g.lineTo(0, rad);
  g.strokeStyle = 'rgba(200,245,255,0.5)';
  g.lineWidth = 0.25 * u;
  g.stroke();
  g.beginPath();
  g.moveTo(-half, -rad * 0.45);
  g.lineTo(half * 0.8, -rad * 0.45);
  g.strokeStyle = 'rgba(255,255,255,0.75)';
  g.lineWidth = rad * 0.28;
  g.lineCap = 'round';
  g.stroke();
  g.restore();
}

/** Hexagon molecule network (two fused rings with glowing nodes), faint cyan. */
function molecule(g, x, y, s, u) {
  const ring = (cx, cy) => {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      pts.push([cx + Math.cos(a) * s, cy + Math.sin(a) * s]);
    }
    return pts;
  };
  const rings = [ring(x, y), ring(x + s * 1.732, y), ring(x + s * 0.866, y + s * 1.5)];
  g.save();
  g.strokeStyle = 'rgba(120,225,255,0.55)';
  g.lineWidth = 0.22 * u;
  g.shadowColor = CYAN;
  g.shadowBlur = 1 * u;
  for (const pts of rings) {
    g.beginPath();
    pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
    g.closePath();
    g.stroke();
  }
  g.fillStyle = 'rgba(200,245,255,0.9)';
  for (const pts of rings) for (const [px, py] of pts) {
    g.beginPath();
    g.arc(px, py, 0.32 * u, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

/** Four-point sparkle glint. */
function sparkle(g, x, y, s) {
  g.save();
  g.translate(x, y);
  g.fillStyle = '#ffffff';
  g.shadowColor = CYAN;
  g.shadowBlur = s * 1.2;
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i;
    const r = i % 2 ? s * 0.18 : s;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
  g.restore();
}

/** Glossy isometric glass cube centred at (x, y) with edge length `s`. */
function cube(g, x, y, s, color, u) {
  const c = s * 0.866;
  const top = [
    [x, y - s],
    [x + c, y - s / 2],
    [x, y],
    [x - c, y - s / 2],
  ];
  const left = [
    [x - c, y - s / 2],
    [x, y],
    [x, y + s],
    [x - c, y + s / 2],
  ];
  const right = [
    [x, y],
    [x + c, y - s / 2],
    [x + c, y + s / 2],
    [x, y + s],
  ];
  const face = (pts, fill) => {
    g.beginPath();
    pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  g.save();
  g.shadowColor = color;
  g.shadowBlur = 2.5 * u;
  face(top, shade(color, 0.45));
  g.shadowBlur = 0;
  face(left, shade(color, 0));
  face(right, shade(color, -0.35));
  // glowing edges
  g.lineWidth = 0.3 * u;
  g.strokeStyle = 'rgba(235,255,255,0.9)';
  for (const pts of [top, left, right]) {
    g.beginPath();
    pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
    g.closePath();
    g.stroke();
  }
  // sparkle
  g.beginPath();
  g.arc(x - c * 0.35, y - s * 0.62, s * 0.08, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.fill();
  g.restore();
}

function bubble(g, x, y, rad, color) {
  const grd = g.createRadialGradient(x - rad * 0.35, y - rad * 0.35, rad * 0.1, x, y, rad);
  grd.addColorStop(0, 'rgba(255,255,255,0.95)');
  grd.addColorStop(0.35, color);
  grd.addColorStop(1, 'rgba(10,26,166,0.6)');
  g.beginPath();
  g.arc(x, y, rad, 0, Math.PI * 2);
  g.fillStyle = grd;
  g.fill();
}

/** Lighten (k > 0) or darken (k < 0) a #rrggbb colour. */
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k)));
  return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
}

/** Small repeatable random generator (the frame looks the same every time). */
function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * Frame 2: a ready-made artwork frame (public/brand/frame-2.webp, logo
 * included). Its border lines are lined up with the screen edges (the glow
 * outside them is cut off), the top (logo) and bottom (light streams) keep
 * their true shape, and only the plain border in between stretches to fit.
 * `box` = the border's outer edges in the image (from findArtworkBorder).
 * @returns {{ plaqueTop: number }}  where the buttons should stay above (none needed here)
 */
export function drawArtworkFrame(g, W, H, img, box) {
  g.clearRect(0, 0, W, H);
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const b = box ?? { x0: 0, x1: iw - 1, y0: 0, y1: ih - 1 };
  const k = W / (b.x1 - b.x0 + 1); // border width -> screen width
  const dx = -b.x0 * k;
  const dw = iw * k;
  const T = Math.round(ih * ART_TOP);
  const B = Math.round(ih * ART_BOTTOM);
  const topY = -b.y0 * k; // top border on the screen's top edge
  const botY = H - (b.y1 + 1 - B) * k; // bottom border on the screen's bottom edge
  const midTop = topY + T * k;
  if (botY <= midTop) {
    g.drawImage(img, b.x0, b.y0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, 0, 0, W, H); // very wide screen: just fit the border
  } else {
    g.drawImage(img, 0, 0, iw, T, dx, topY, dw, T * k);
    g.drawImage(img, 0, T, iw, B - T, dx, midTop, dw, botY - midTop);
    g.drawImage(img, 0, B, iw, ih - B, dx, botY, dw, (ih - B) * k);
  }
  return { plaqueTop: H };
}

/**
 * Find the outer edges of the frame's border lines in the artwork: the
 * columns / rows that are solid along most of the plain middle part.
 */
export function findArtworkBorder(img) {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H).data;
  const solid = (x, y) => d[(y * W + x) * 4 + 3] > 180;
  const share = (n, t) => (t ? n / t : 0);
  const colSolid = (x) => {
    let n = 0, t = 0;
    for (let y = Math.floor(H * ART_TOP); y < H * ART_BOTTOM; y += 2, t++) if (solid(x, y)) n++;
    return share(n, t) > 0.85;
  };
  const rowSolid = (y, x0, x1) => {
    let n = 0, t = 0;
    for (let x = Math.floor(x0); x < x1; x += 2, t++) if (solid(x, y)) n++;
    return share(n, t) > 0.85;
  };
  let x0 = 0;
  while (x0 < W / 3 && !colSolid(x0)) x0++;
  let x1 = W - 1;
  while (x1 > (W * 2) / 3 && !colSolid(x1)) x1--;
  // top/bottom lines: check a stretch of the border away from the corner art
  let y0 = 0;
  while (y0 < H / 6 && !rowSolid(y0, W * 0.3, W * 0.45)) y0++;
  let y1 = H - 1;
  while (y1 > (H * 5) / 6 && !rowSolid(y1, W * 0.05, W * 0.2)) y1--;
  const ok = x0 < W / 3 && x1 > (W * 2) / 3 && y0 < H / 6 && y1 > (H * 5) / 6;
  return ok ? { x0, x1, y0, y1 } : null;
}
const ART_TOP = 0.24; // frame-2.webp: the logo and corner art end above this share of its height
const ART_BOTTOM = 0.59; // ...and the bottom artwork starts below this
