#!/usr/bin/env node
// Enforce the house panel output spec (crew/storyboard-artist/storyboard-style.md) on a folder of rendered panels.
// Any image tool or model may make them; they pass only if every file is <shotId>.png|jpg|webp (e.g. 1.4.png),
// native 16:9 (within 1%), at least 1920 px wide, and has no padding or blurred bars on opposite edges.
// Usage: node scripts/check-panels.mjs --dir <panels> [--manifest panels.json] [--report r.json]   (exit 1 on any error)
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readGray } from './lib/panel-detect.mjs';
import { checkPanelSize, paddingBands, PANEL_FILE_RE } from '../crew/storyboard-artist/style.mjs';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const dir = arg('--dir'); if (!dir) throw new Error('--dir is required');
const files = (await readdir(dir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
const want = arg('--manifest') ? JSON.parse(await readFile(arg('--manifest'), 'utf8')).panels.map((p) => p.shotId) : null;
const report = []; let bad = 0;
for (const f of files) {
  const issues = [];
  if (!PANEL_FILE_RE.test(f)) issues.push({ code: 'PANEL_NAME', message: `${f}: name panels <part>.<shot>.png (e.g. 1.4.png)` });
  const img = readGray(join(dir, f), 960);
  issues.push(...checkPanelSize({ width: img.W, height: img.H }));
  const pad = paddingBands(img.gray, img.w, img.h);
  if (pad.padded) issues.push({ code: 'PANEL_PADDED', message: `${f}: low-detail bands on ${pad.flagged.join(', ')} (padding / blurred bars)` });
  if (issues.length) bad++;
  report.push({ file: f, width: img.W, height: img.H, padding: pad, issues });
  console.log(`${f}  ${img.W}x${img.H}  ${issues.length ? issues.map((i) => i.code).join(',') : 'ok'}`);
}
if (want) for (const id of want) if (!files.some((f) => f.startsWith(`${id}.`))) { bad++; console.error(`missing panel ${id}`); }
if (arg('--report')) await writeFile(arg('--report'), JSON.stringify(report, null, 2));
if (bad) { console.error(`${bad} panel problem(s)`); process.exit(1); }
