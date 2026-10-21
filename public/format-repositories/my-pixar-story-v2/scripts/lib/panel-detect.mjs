// Detect storyboard panels on a sheet image from their dark borders (no fixed grid): threshold dark pixels, find
// connected components, keep ring-shaped boxes of panel size, drop nested ones, drop blank panels (low variance),
// order top-to-bottom then left-to-right. Pure JS on a grayscale buffer; decoding is done with ffmpeg.
import { execFileSync } from 'node:child_process';

/** Decode an image to an 8-bit grayscale buffer, downscaled to at most maxW wide. Returns { gray, w, h, W, H }. */
export function readGray(path, maxW = 1600) {
  const [W, H] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path]).toString().trim().split(',').map(Number);
  const w = Math.min(W, maxW), h = Math.round(H * (w / W));
  const gray = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 28 });
  return { gray, w, h, W, H };
}

/** Connected components of the dark mask (4-neighbour), returning bounding boxes and pixel counts. */
function components(mask, w, h) {
  const lab = new Int32Array(w * h); const out = []; const st = new Int32Array(w * h); let id = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lab[i]) continue;
    id++; let sp = 0; st[sp++] = i; lab[i] = id; let x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0;
    while (sp) {
      const p = st[--sp]; const x = p % w, y = (p / w) | 0; n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = id; st[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = id; st[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !lab[p - w]) { lab[p - w] = id; st[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !lab[p + w]) { lab[p + w] = id; st[sp++] = p + w; }
    }
    out.push({ id, x0, y0, x1, y1, n });
  }
  return { lab, comps: out };
}

/**
 * Panels on a sheet. Options: dark threshold, minimum panel size (fraction of sheet), blank std-dev limit.
 * Returns { panels: [{ x, y, w, h, std, blank }] in reading order (non-blank only), all: every candidate } in
 * the buffer's coordinates.
 */
export function detectPanels(gray, w, h, { dark = 80, minFrac = 0.12, edgeDark = 0.55, blankStd = 10 } = {}) {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = gray[i] < dark ? 1 : 0;
  const { lab, comps } = components(mask, w, h);
  const ring = (c) => { // fraction of each bbox edge (sampled a few px in) that belongs to this component
    const N = 40, xs = Array.from({ length: N }, (_, k) => Math.round(c.x0 + ((k + 0.5) / N) * (c.x1 - c.x0))), ys = Array.from({ length: N }, (_, k) => Math.round(c.y0 + ((k + 0.5) / N) * (c.y1 - c.y0)));
    const band = (pts, dx, dy) => pts.filter(([x, y]) => { for (let d = 0; d < 6; d++) if (lab[Math.min(h - 1, Math.max(0, y + dy * d)) * w + Math.min(w - 1, Math.max(0, x + dx * d))] === c.id) return true; return false; }).length / pts.length;
    return Math.min(band(xs.map((x) => [x, c.y0]), 0, 1), band(xs.map((x) => [x, c.y1]), 0, -1), band(ys.map((y) => [c.x0, y]), 1, 0), band(ys.map((y) => [c.x1, y]), -1, 0));
  };
  let cand = comps.filter((c) => (c.x1 - c.x0) >= w * minFrac && (c.y1 - c.y0) >= h * minFrac * 0.6 && (c.x1 - c.x0) < w * 0.98)
    .map((c) => ({ ...c, ring: ring(c) })).filter((c) => c.ring >= edgeDark);
  // drop boxes nested inside another candidate
  cand = cand.filter((c) => !cand.some((o) => o !== c && o.x0 <= c.x0 && o.y0 <= c.y0 && o.x1 >= c.x1 && o.y1 >= c.y1));
  const all = cand.map((c) => {
    // interior: border thickness = smallest median run of border pixels in from each edge (dark content that touches the
    // border on some scan lines does not inflate it), capped at 8% of the box
    const bw = c.x1 - c.x0, bh = c.y1 - c.y0, cap = Math.max(2, Math.round(Math.min(bw, bh) * 0.08));
    const run = (x, y, dx, dy) => { let t = 0; while (t < cap && lab[(y + dy * t) * w + (x + dx * t)] === c.id) t++; return t; };
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    const ks = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const t = Math.min(med(ks.map((f) => run(c.x0 + Math.round(bw * f), c.y0, 0, 1))), med(ks.map((f) => run(c.x0 + Math.round(bw * f), c.y1, 0, -1))),
      med(ks.map((f) => run(c.x0, c.y0 + Math.round(bh * f), 1, 0))), med(ks.map((f) => run(c.x1, c.y0 + Math.round(bh * f), -1, 0))));
    const pad = t + 2; const x = c.x0 + pad, y = c.y0 + pad, ww = bw - 2 * pad, hh = bh - 2 * pad;
    let s = 0, s2 = 0, n = 0;
    const mx = Math.round(ww * 0.04), my = Math.round(hh * 0.04); // variance on the inner area only (no border anti-aliasing)
    for (let yy = y + my; yy < y + hh - my; yy += 3) for (let xx = x + mx; xx < x + ww - mx; xx += 3) { const v = gray[yy * w + xx]; s += v; s2 += v * v; n++; }
    const std = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
    return { x, y, w: ww, h: hh, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, std: +std.toFixed(1), blank: std < blankStd };
  });
  return { panels: readingOrder(all.filter((p) => !p.blank)), all: readingOrder(all) };
}

/** Top-to-bottom rows (centres within half a panel height), then left-to-right. */
export function readingOrder(ps) {
  const s = [...ps].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2)); const rows = [];
  for (const p of s) { const r = rows.at(-1); if (r && Math.abs((p.y + p.h / 2) - (r[0].y + r[0].h / 2)) < r[0].h / 2) r.push(p); else rows.push([p]); }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x));
}

/** Centre-crop a rect to 16:9 (even integers), in source-image coordinates scaled by k. */
export function crop169(p, k = 1, aspect = 16 / 9) {
  let w = p.w * k, h = p.h * k; let x = p.x * k, y = p.y * k;
  if (w / h > aspect) { const nw = h * aspect; x += (w - nw) / 2; w = nw; } else { const nh = w / aspect; y += (h - nh) / 2; h = nh; }
  const ev = (v) => Math.max(2, Math.floor(v / 2) * 2);
  return { x: ev(x), y: ev(y), w: ev(w), h: ev(h) };
}

/** The detected rect scaled by k to source coordinates (even integers), for pad mode. */
export function scaleRect(p, k = 1) { const ev = (v) => Math.max(2, Math.floor(v / 2) * 2); return { x: ev(p.x * k), y: ev(p.y * k), w: ev(p.w * k), h: ev(p.h * k) }; }

/** Paper colour of the sheet: median gray of the four corner patches. */
export function paperGray(gray, w, h, s = 12) {
  const v = []; for (const [x0, y0] of [[0, 0], [w - s, 0], [0, h - s], [w - s, h - s]]) for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) v.push(gray[y * w + x]);
  return v.sort((a, b) => a - b)[v.length >> 1];
}

/**
 * An edge line that is border ink (mostly near-black AND flat: ink is uniform, dark scene content is not) or mostly
 * sheet-paper colour.
 */
export const isDirtyEdge = (e, { darkFrac = 0.6, paperFrac = 0.6, inkStd = 6 } = {}) => (e.dark > darkFrac && (e.std == null || e.std < inkStd)) || e.paper > paperFrac;

/** Stats of one edge line (row or column) inside rect r: mean, fraction dark, fraction paper-like. */
export function edgeStats(gray, w, r, side, { paper, dark = 55, tol = 10 } = {}) {
  const pts = [];
  if (side === 'top' || side === 'bottom') { const y = side === 'top' ? r.y : r.y + r.h - 1; for (let x = r.x; x < r.x + r.w; x++) pts.push(gray[y * w + x]); }
  else { const x = side === 'left' ? r.x : r.x + r.w - 1; for (let y = r.y; y < r.y + r.h; y++) pts.push(gray[y * w + x]); }
  // middle 80% of the line only: corners of a hand-drawn border curve into paper and would skew the stats
  const cut = Math.floor(pts.length * 0.1); pts.splice(0, cut); pts.splice(pts.length - cut, cut);
  const n = pts.length; const mean = pts.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(pts.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { mean: +mean.toFixed(1), std: +std.toFixed(1), dark: pts.filter((v) => v < dark).length / n, paper: paper == null ? 0 : pts.filter((v) => Math.abs(v - paper) <= tol).length / n };
}

/**
 * Move each side of a detected panel inward past its border: skip the dark border run, then the anti-aliased ramp,
 * plus `extra` px; then keep stepping in while the edge line is still mostly border-dark or paper-coloured.
 */
export function refineRect(gray, w, h, p, { dark = 55, extra = 3, paper, maxStep = 0.06, darkFrac = 0.5, paperFrac = 0.5 } = {}) {
  const r = { x: p.x0 ?? p.x, y: p.y0 ?? p.y, w: (p.x1 != null ? p.x1 - p.x0 + 1 : p.w), h: (p.y1 != null ? p.y1 - p.y0 + 1 : p.h) };
  const lim = Math.round(Math.min(r.w, r.h) * maxStep);
  // Per side: scan the first `lim` lines inward; the inset is one past the LAST border/paper line found (hand-drawn
  // borders wobble, so the outermost line can be clean while the ink band sits a few px further in), plus `extra`.
  const o = { ...r };
  const line = (side, k) => {
    const q = side === 'top' ? { ...o, y: o.y + k, h: 1 } : side === 'bottom' ? { ...o, y: o.y + o.h - 1 - k, h: 1 } : side === 'left' ? { ...o, x: o.x + k, w: 1 } : { ...o, x: o.x + o.w - 1 - k, w: 1 };
    return edgeStats(gray, w, q, side === 'top' || side === 'bottom' ? 'top' : 'left', { paper, dark });
  };
  const inset = {};
  for (const side of ['top', 'bottom', 'left', 'right']) {
    let last = -1; for (let k = 0; k < lim; k++) if (isDirtyEdge(line(side, k), { darkFrac, paperFrac, inkStd: 12 })) last = k; // looser than the final check: a few px of content is cheap
    inset[side] = last + 1 + extra;
  }
  r.x = o.x + inset.left; r.y = o.y + inset.top; r.w = o.w - inset.left - inset.right; r.h = o.h - inset.top - inset.bottom;
  return r;
}

/**
 * How to fit a panel into 16:9. ratio 1.70-1.86 (a few % off 16:9): crop (wider: centre the width; taller: cut only
 * from the bottom, the top is kept). Otherwise 'reject': the panel is not 16:9 and is re-rendered, never padded or
 * blur-filled (house style, crew/storyboard-artist/storyboard-style.md).
 */
export function fitPlan(r, { lo = 1.70, hi = 1.86, aspect = 16 / 9 } = {}) {
  const ratio = r.w / r.h;
  // even-integer rect that stays INSIDE the given one (never rounds outward onto the border)
  const inside = (x, y, w, h) => { const X = Math.ceil(x / 2) * 2, Y = Math.ceil(y / 2) * 2; return { x: X, y: Y, w: Math.floor((x + w - X) / 2) * 2, h: Math.floor((y + h - Y) / 2) * 2 }; };
  if (ratio < lo || ratio > hi) return { mode: 'reject', ratio, rect: inside(r.x, r.y, r.w, r.h) };
  if (ratio >= aspect) { const nw = r.h * aspect; return { mode: 'crop', ratio, rect: inside(r.x + (r.w - nw) / 2, r.y, nw, r.h) }; }
  // taller than 16:9: all the excess comes off the bottom, so the top (heads) is never cut
  return { mode: 'crop', ratio, rect: inside(r.x, r.y, r.w, r.w / aspect) };
}
