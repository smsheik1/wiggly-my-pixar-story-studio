// Deterministic storyboard -> animatic tools (no model calls):
//  slicer: crop each storyboard sheet (2 rows x 4 panels) into per-shot 16:9 stills named <shotId>.png
//  animatic: hold each still for its shot's duration (SD timecodes), lay optional scratch audio under it (else silence)
import { GRID } from '../../crew/storyboard-artist/compile.mjs';

/** Shot timeline from the SD output: parts play back to back; each shot holds for endSec - startSec. */
export function shotTimeline(sd) {
  const out = []; let t = 0;
  for (const seg of sd?.segments ?? []) for (const sh of seg.shots ?? []) {
    const dur = (sh.endSec ?? 0) - (sh.startSec ?? 0);
    if (!(dur > 0)) throw new Error(`shot ${seg.segmentId}.${sh.shotNumber}: non-positive duration`);
    out.push({ shotId: `${seg.segmentId}.${sh.shotNumber}`, segmentId: seg.segmentId, startSec: sh.startSec, endSec: sh.endSec, durationSec: dur, timelineStartSec: t });
    t += dur;
  }
  return out;
}

/**
 * Panel rectangles for a sheet image W x H: rows x cols equal cells inside a page margin with gutters, then each cell is
 * centre-cropped to 16:9 and inset (to drop the drawn border and the corner label's edge). All values are even integers.
 */
export function panelRects(W, H, { rows = GRID.rows, cols = GRID.cols, margin = 0.02, gutter = 0.012, inset = 0.03, aspect = GRID.panelAspect } = {}) {
  const ev = (x) => Math.max(2, Math.floor(x / 2) * 2);
  const mx = W * margin, my = H * margin, gx = W * gutter, gy = H * gutter;
  const cw = (W - 2 * mx - (cols - 1) * gx) / cols, ch = (H - 2 * my - (rows - 1) * gy) / rows;
  let w = cw * (1 - 2 * inset), h = ch * (1 - 2 * inset);
  if (w / h > aspect) w = h * aspect; else h = w / aspect;
  const rects = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const cx = mx + c * (cw + gx) + cw / 2, cy = my + r * (ch + gy) + ch / 2;
    rects.push({ panelNumber: r * cols + c + 1, row: r, col: c, w: ev(w), h: ev(h), x: ev(cx - w / 2), y: ev(cy - h / 2) });
  }
  return rects;
}

/** ffmpeg args to crop one panel out of a sheet into a 1920x1080 PNG. */
export function sliceArgs(sheetPath, rect, outPath, { width = 1920, height = 1080 } = {}) {
  return ['-y', '-loglevel', 'error', '-i', sheetPath, '-vf', `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y},scale=${width}:${height}:flags=lanczos`, '-frames:v', '1', outPath];
}

/**
 * ffmpeg args for the animatic. frames: [{ shotId, durationSec, path|null }] (null path = black placeholder). audio: path or null (silence).
 * Each still is looped for its duration, letterboxed to WxH, concatenated; audio is padded/trimmed to the exact total.
 */
export function animaticArgs(frames, { audio = null, out = 'animatic_preview.mp4', fps = 24, width = 1920, height = 1080 } = {}) {
  if (!frames.length) throw new Error('animaticArgs: no frames');
  const total = +frames.reduce((a, f) => a + f.durationSec, 0).toFixed(3);
  const args = ['-y', '-loglevel', 'error'];
  for (const f of frames) {
    if (f.path) args.push('-loop', '1', '-framerate', String(fps), '-t', String(f.durationSec), '-i', f.path);
    else args.push('-f', 'lavfi', '-t', String(f.durationSec), '-i', `color=c=black:s=${width}x${height}:r=${fps}`); // missing frame placeholder
  }
  const ai = frames.length;
  if (audio) args.push('-i', audio); else args.push('-f', 'lavfi', '-t', String(total), '-i', 'anullsrc=r=48000:cl=stereo');
  const v = frames.map((_, i) => `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`);
  const fc = `${v.join(';')};${frames.map((_, i) => `[v${i}]`).join('')}concat=n=${frames.length}:v=1:a=0[v];[${ai}:a]aresample=48000,apad,atrim=0:${total}[a]`;
  args.push('-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-b:a', '160k', '-t', String(total), '-movflags', '+faststart', out);
  return { args, totalSec: total };
}
