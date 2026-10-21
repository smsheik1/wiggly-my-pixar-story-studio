// House storyboard style for my-pixar-story (generic: any family). The text lives in style.md; the hard rules are code.
// Root-cause history: sheets of 6-8 panels rendered at 1K (1376x768) gave ~300px-wide, ~1.42:1 panels that the slicer
// upscaled 6x and centred over blurred bars; full location plates (wide, chest-height, evening lamp light) attached to
// every panel pulled every frame into a dim wide room shot. Panels are now one native 16:9 2K image per shot.

export const PANEL_ASPECT = 16 / 9;
export const PANEL_ASPECT_TOLERANCE = 0.01;      // 1%: 1920x1080, 2752x1536, 2560x1440 all pass; 4:3 or 1.42 never
export const PANEL_MIN_WIDTH = 1920;             // native full res; never an upscaled thumbnail
// Model-agnostic: any image model that takes reference images works; this is the named default. The spec is the gate.
export const DEFAULT_PANEL_MODEL = 'nano-banana-2.1';
export const PANEL_IMAGE = Object.freeze({ engine: DEFAULT_PANEL_MODEL, aspect: '16:9', resolution: '2K', minWidth: 1920 });
export const PANEL_FILE_RE = /^\d+\.\d+\.(png|jpe?g|webp)$/i; // <part>.<shot>, e.g. 1.4.png
export const STYLE_FILE = 'crew/storyboard-artist/storyboard-style.md';

/** Shot-size family of a "Medium close-up, low angle" style string: wide | full | medium | close | insert. */
export function shotFamily(s) {
  const t = String(s ?? '').toLowerCase();
  if (/\b(insert|extreme close|ecu|detail)\b/.test(t)) return 'insert';
  if (/\b(close|cu|mcu)\b/.test(t)) return 'close';
  if (/\b(full|medium wide|mws|cowboy)\b/.test(t)) return 'full';
  if (/\b(establishing|extreme wide|wide|long|ews|ws|ls)\b/.test(t)) return 'wide';
  if (/\b(medium|mid|two[- ]shot|over[- ]the[- ]shoulder|ots|ms)\b/.test(t)) return 'medium';
  return 'unknown';
}

/**
 * Shot-size mix for one part's panels (in order). Rules (coverage ladder: wide sets geography, medium plays the beat,
 * close lands the turn):
 *  - SB_SHOT_SIZE_UNKNOWN: every panel names a shot size the house vocabulary knows
 *  - SB_NO_CLOSE: a part of 3+ panels has at least one close-up or medium close-up (faces carry this format)
 *  - SB_TOO_MANY_WIDE: at most one wide per three panels (ceil(n/3)); characters must stay large in frame
 *  - SB_SIZE_RUN: never three panels in a row of the same family
 *  - SB_ONE_SIZE: a part of 4+ panels uses at least three different families
 */
export function checkShotMix(panels, { path = '' } = {}) {
  const issues = []; const err = (code, message) => issues.push({ severity: 'error', code, message, path });
  const fam = panels.map((p) => shotFamily(p.shotSizeAndAngle));
  panels.forEach((p, i) => { if (fam[i] === 'unknown') err('SB_SHOT_SIZE_UNKNOWN', `panel ${p.shotId}: "${p.shotSizeAndAngle}" names no shot size (wide, full, medium, medium close-up, close-up, insert)`); });
  const n = panels.length;
  if (n >= 3 && !fam.includes('close')) err('SB_NO_CLOSE', `part has ${n} panels and no close-up or medium close-up; land the turn on a face`);
  const wides = fam.filter((f) => f === 'wide').length;
  if (n >= 2 && wides > Math.ceil(n / 3)) err('SB_TOO_MANY_WIDE', `${wides} wide panels of ${n}; at most ${Math.ceil(n / 3)} (one establishing wide, then go in)`);
  for (let i = 2; i < n; i++) if (fam[i] !== 'unknown' && fam[i] === fam[i - 1] && fam[i] === fam[i - 2]) { err('SB_SIZE_RUN', `panels ${panels[i - 2].shotId}-${panels[i].shotId} are all ${fam[i]}; change the distance`); break; }
  if (n >= 4 && new Set(fam.filter((f) => f !== 'unknown')).size < 3) err('SB_ONE_SIZE', `part uses only ${[...new Set(fam)].join(', ')}; mix at least three shot sizes`);
  return issues;
}

/** Hard rules on one rendered panel image: native 16:9, full res. { width, height } in source pixels. */
export function checkPanelSize({ width, height }) {
  const issues = [];
  const r = width / height;
  if (Math.abs(r / PANEL_ASPECT - 1) > PANEL_ASPECT_TOLERANCE) issues.push({ severity: 'error', code: 'PANEL_NOT_16_9', message: `${width}x${height} is ${r.toFixed(3)}:1, not 16:9` });
  if (width < PANEL_MIN_WIDTH) issues.push({ severity: 'error', code: 'PANEL_LOW_RES', message: `${width}px wide; panels are rendered natively at ${PANEL_MIN_WIDTH}px or more, never upscaled` });
  return issues;
}

/**
 * Padding / blurred side bars: a band at the left/right (or top/bottom) edge with far less fine detail than the centre,
 * or a flat band. gray: 8-bit buffer w x h. Detail = mean |horizontal + vertical gradient|.
 */
export function paddingBands(gray, w, h, { band = 0.08, ratio = 0.25 } = {}) {
  const detail = (x0, y0, x1, y1) => { let s = 0, n = 0; for (let y = Math.max(1, y0); y < y1; y++) for (let x = Math.max(1, x0); x < x1; x++) { const i = y * w + x; s += Math.abs(gray[i] - gray[i - 1]) + Math.abs(gray[i] - gray[i - w]); n++; } return n ? s / n : 0; };
  const bx = Math.max(2, Math.round(w * band)), by = Math.max(2, Math.round(h * band));
  const centre = detail(Math.round(w * 0.3), Math.round(h * 0.3), Math.round(w * 0.7), Math.round(h * 0.7));
  const bands = { left: detail(0, 0, bx, h), right: detail(w - bx, 0, w, h), top: detail(0, 0, w, by), bottom: detail(0, h - by, w, h) };
  const flagged = Object.entries(bands).filter(([, d]) => d < 0.5 || (centre > 2 && d < centre * ratio)).map(([k]) => k);
  // a symmetric pair is padding; a single soft edge (sky, wall) is just composition
  const padded = (flagged.includes('left') && flagged.includes('right')) || (flagged.includes('top') && flagged.includes('bottom'));
  return { padded, flagged, centre: +centre.toFixed(2), bands: Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, +v.toFixed(2)])) };
}
