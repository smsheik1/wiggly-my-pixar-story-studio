// Slicer geometry + animatic ffmpeg command builder; one real ffmpeg smoke run when ffmpeg is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { panelRects, sliceArgs, animaticArgs, shotTimeline } from '../scripts/lib/animatic.mjs';

const sd = { segments: [{ segmentId: 1, shots: [{ shotNumber: 1, startSec: 0, endSec: 4 }, { shotNumber: 2, startSec: 4, endSec: 6.5 }] }, { segmentId: 2, shots: [{ shotNumber: 1, startSec: 0, endSec: 3 }] }] };

test('shotTimeline: parts back to back, hold = end - start', () => {
  assert.deepEqual(shotTimeline(sd).map((s) => [s.shotId, s.durationSec, s.timelineStartSec]), [['1.1', 4, 0], ['1.2', 2.5, 4], ['2.1', 3, 6.5]]);
  assert.throws(() => shotTimeline({ segments: [{ segmentId: 1, shots: [{ shotNumber: 1, startSec: 3, endSec: 3 }] }] }));
});
test('panelRects: 2x4 grid, 16:9, inside the sheet, left-to-right then top-to-bottom', () => {
  const r = panelRects(2752, 1536);
  assert.equal(r.length, 8);
  for (const p of r) { assert.ok(Math.abs(p.w / p.h - 16 / 9) < 0.01); assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= 2752 && p.y + p.h <= 1536); assert.equal(p.w % 2, 0); }
  assert.ok(r[1].x > r[0].x && r[0].y === r[3].y && r[4].y > r[0].y && r[4].x === r[0].x);
});
test('sliceArgs: crop then scale to 1920x1080, one frame', () => {
  const a = sliceArgs('s.png', { w: 640, h: 360, x: 10, y: 20 }, '1.1.png');
  assert.equal(a[a.indexOf('-vf') + 1], 'crop=640:360:10:20,scale=1920:1080:flags=lanczos');
  assert.equal(a.at(-1), '1.1.png');
});
test('animaticArgs: each still looped for its duration; silence when no audio; exact total', () => {
  const frames = shotTimeline(sd).map((s) => ({ ...s, path: `${s.shotId}.png` }));
  const { args, totalSec } = animaticArgs(frames, { out: 'a.mp4' });
  assert.equal(totalSec, 9.5);
  assert.deepEqual(args.slice(3, 11), ['-loop', '1', '-framerate', '24', '-t', '4', '-i', '1.1.png']);
  assert.ok(args.includes('anullsrc=r=48000:cl=stereo'));
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.ok(fc.includes('concat=n=3:v=1:a=0[v]') && fc.includes('[3:a]') && fc.includes('atrim=0:9.5'));
  assert.equal(args[args.indexOf('-t', args.indexOf('-filter_complex')) + 1], '9.5');
  const withAudio = animaticArgs(frames, { audio: 'narr.wav' }).args;
  assert.ok(withAudio.includes('narr.wav') && !withAudio.includes('anullsrc=r=48000:cl=stereo'));
  const ph = animaticArgs([{ shotId: '1.1', durationSec: 2, path: null }]).args;
  assert.ok(ph.includes('color=c=black:s=1920x1080:r=24'));
});
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version']); return true; } catch { return false; } })();
test('ffmpeg smoke: slice a synthetic sheet and build a 3-shot animatic', { skip: !hasFfmpeg }, () => {
  const d = mkdtempSync(join(tmpdir(), 'anim-'));
  const sheet = join(d, 'sheet-1.png');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=1376x768', '-frames:v', '1', sheet]);
  const rects = panelRects(1376, 768);
  const frames = shotTimeline(sd).map((s, i) => { const p = join(d, `${s.shotId}.png`); execFileSync('ffmpeg', sliceArgs(sheet, rects[i], p)); return { ...s, path: p }; });
  const out = join(d, 'animatic_preview.mp4');
  execFileSync('ffmpeg', animaticArgs(frames, { out }).args);
  assert.ok(existsSync(out));
  const dur = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString();
  assert.ok(Math.abs(dur - 9.5) < 0.15, `duration ${dur}`);
});
