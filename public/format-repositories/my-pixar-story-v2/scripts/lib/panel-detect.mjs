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
    // interior: step in past the border on each side
    let t = 0; const cy = ((c.y0 + c.y1) / 2) | 0;
    while (t < (c.x1 - c.x0) / 4 && lab[cy * w + c.x0 + t] === c.id) t++;
    const pad = t + 2; const x = c.x0 + pad, y = c.y0 + pad, ww = c.x1 - c.x0 - 2 * pad, hh = c.y1 - c.y0 - 2 * pad;
    let s = 0, s2 = 0, n = 0;
    for (let yy = y; yy < y + hh; yy += 3) for (let xx = x; xx < x + ww; xx += 3) { const v = gray[yy * w + xx]; s += v; s2 += v * v; n++; }
    const std = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
    return { x, y, w: ww, h: hh, std: +std.toFixed(1), blank: std < blankStd };
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
