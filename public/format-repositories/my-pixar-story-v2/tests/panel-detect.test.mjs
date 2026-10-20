// Slicer panel detection on synthetic sheets: any layout, dark borders, labels above, blank panels ignored, reading order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPanels, readingOrder, crop169, readGray } from '../scripts/lib/panel-detect.mjs';

test('crop169: centre-crops tall and wide boxes to 16:9', () => {
  const a = crop169({ x: 0, y: 0, w: 400, h: 400 }); assert.ok(Math.abs(a.w / a.h - 16 / 9) < 0.02 && a.w === 400 && a.y > 0);
  const b = crop169({ x: 0, y: 0, w: 1000, h: 300 }); assert.ok(Math.abs(b.w / b.h - 16 / 9) < 0.02 && b.h === 300 && b.x > 0);
});
test('readingOrder: rows top to bottom, then left to right (tolerates jitter)', () => {
  const p = (x, y) => ({ x, y, w: 100, h: 60 });
  assert.deepEqual(readingOrder([p(300, 205), p(0, 0), p(150, 3), p(0, 200)]).map((q) => [q.x, q.y]), [[0, 0], [150, 3], [0, 200], [300, 205]]);
});
test('detectPanels on a buffer: bordered boxes found, blank one flagged', () => {
  const w = 400, h = 200, g = new Uint8Array(w * h).fill(240);
  const box = (x0, y0, x1, y1, fill) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const edge = x - x0 < 4 || x1 - x < 4 || y - y0 < 4 || y1 - y < 4; g[y * w + x] = edge ? 10 : fill(x, y); } };
  box(10, 20, 190, 120, (x, y) => ((x * 7 + y * 13) % 200) + 30); box(210, 20, 390, 120, () => 240);
  const { panels, all } = detectPanels(g, w, h);
  assert.equal(all.length, 2); assert.equal(panels.length, 1); assert.ok(panels[0].x < 30);
});
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version']); return true; } catch { return false; } })();
test('slice-storyboard: 3-over-2 sheet + blank box + labels -> 5 stills in order; count mismatch fails loudly', { skip: !hasFfmpeg }, () => {
  const d = mkdtempSync(join(tmpdir(), 'slice-')); mkdirSync(join(d, 'sheets'));
  const W = 1920, H = 1080, pw = 520, ph = 300; // slightly off 16:9 on purpose
  const pos = [[90, 120], [700, 120], [1310, 120], [395, 620], [1005, 620], [1600, 660]]; // last = small blank box
  const inputs = ['-f', 'lavfi', '-i', `color=c=0xf4efe6:s=${W}x${H}`];
  pos.slice(0, 5).forEach((_, i) => inputs.push('-f', 'lavfi', '-i', `testsrc2=s=${pw}x${ph}:r=1,hue=h=${i * 60}`));
  let last = '[0:v]';
  const chain = [];
  pos.slice(0, 5).forEach(([x, y], i) => { chain.push(`${last}[${i + 1}:v]overlay=${x}:${y}[o${i}]`); last = `[o${i}]`; });
  const boxes = pos.map(([x, y], i) => { const [bw, bh] = i === 5 ? [270, 160] : [pw, ph]; return `drawbox=x=${x - 10}:y=${y - 10}:w=${bw + 20}:h=${bh + 20}:color=0x151515:t=10,drawbox=x=${x}:y=${y - 50}:w=60:h=22:color=0x202020:t=fill`; }).join(',');
  chain.push(`${last}${boxes}[out]`); const fc = chain.join(';');
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', fc, '-map', '[out]', '-frames:v', '1', join(d, 'sheets', 'sheet-1.png')]);
  const img = readGray(join(d, 'sheets', 'sheet-1.png'));
  const { panels, all } = detectPanels(img.gray, img.w, img.h);
  assert.equal(panels.length, 5); assert.equal(all.length - panels.length, 1);
  const shots = ['1.1', '1.2', '1.3', '1.4', '1.5'];
  writeFileSync(join(d, 'm.json'), JSON.stringify({ sheets: [{ sheetId: '1', panels: shots.map((shotId, i) => ({ panelNumber: i + 1, shotId })) }] }));
  const script = new URL('../scripts/slice-storyboard.mjs', import.meta.url).pathname;
  execFileSync('node', [script, '--manifest', join(d, 'm.json'), '--sheets', join(d, 'sheets'), '--out', join(d, 'out')]);
  for (const s of shots) {
    assert.ok(existsSync(join(d, 'out', `${s}.png`)), s);
    assert.equal(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(d, 'out', `${s}.png`)]).toString().trim(), '1920,1080');
  }
  writeFileSync(join(d, 'm6.json'), JSON.stringify({ sheets: [{ sheetId: '1', panels: [...shots, '1.6'].map((shotId, i) => ({ panelNumber: i + 1, shotId })) }] }));
  assert.throws(() => execFileSync('node', [script, '--manifest', join(d, 'm6.json'), '--sheets', join(d, 'sheets'), '--out', join(d, 'out6')], { stdio: 'pipe' }));
});
