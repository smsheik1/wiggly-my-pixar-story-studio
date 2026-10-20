#!/usr/bin/env node
// Slice storyboard sheets into per-shot stills. Usage:
//   node scripts/slice-storyboard.mjs --manifest <manifest.json> --sheets <dir with sheet-<id>.png|jpg> --out <frames dir> [--margin 0.02 --gutter 0.012 --inset 0.03]
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { panelRects, sliceArgs } from './lib/animatic.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const man = JSON.parse(await readFile(arg('--manifest'), 'utf8'));
const dir = arg('--sheets'), out = arg('--out'); await mkdir(out, { recursive: true });
const files = await readdir(dir);
const opt = Object.fromEntries(['margin', 'gutter', 'inset'].filter((k) => arg(`--${k}`)).map((k) => [k, +arg(`--${k}`)]));
for (const s of man.sheets) {
  const f = files.find((x) => new RegExp(`^sheet-${s.sheetId}\\.(png|jpe?g|webp)$`, 'i').test(x));
  if (!f) { console.error(`missing image for sheet ${s.sheetId}`); process.exitCode = 1; continue; }
  const [W, H] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(dir, f)]).toString().trim().split(',').map(Number);
  const rects = panelRects(W, H, opt);
  for (const p of s.panels) { execFileSync('ffmpeg', sliceArgs(join(dir, f), rects[p.panelNumber - 1], join(out, `${p.shotId}.png`))); console.log(`${s.sheetId} panel ${p.panelNumber} -> ${p.shotId}.png`); }
}
