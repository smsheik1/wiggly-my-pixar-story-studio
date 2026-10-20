#!/usr/bin/env node
// Slice storyboard sheets into per-shot stills by detecting the drawn panel borders (any layout Flow returns).
// Blank panels are ignored; detected panels are read top-to-bottom, left-to-right and mapped to the manifest's shot ids
// in order; each is centre-cropped to 16:9 and scaled to 1920x1080. Fails loudly when the count does not match.
// Usage: node scripts/slice-storyboard.mjs --manifest <manifest.json> --sheets <dir of sheet-<id>.png> --out <dir> [--only 1,2,8] [--dry]
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readGray, detectPanels, crop169 } from './lib/panel-detect.mjs';
import { sliceArgs } from './lib/animatic.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const man = JSON.parse(await readFile(arg('--manifest'), 'utf8'));
const dir = arg('--sheets'), out = arg('--out'); const dry = process.argv.includes('--dry');
if (!dry) await mkdir(out, { recursive: true });
const only = arg('--only')?.split(',');
const files = await readdir(dir); const report = []; let bad = 0;
for (const s of man.sheets) {
  if (only && !only.includes(String(s.sheetId))) continue;
  const f = files.find((x) => new RegExp(`^sheet-${s.sheetId}\\.(png|jpe?g|webp)$`, 'i').test(x));
  if (!f) { report.push({ sheetId: s.sheetId, error: 'image missing' }); bad++; continue; }
  const img = readGray(join(dir, f)); const k = img.W / img.w;
  const { panels, all } = detectPanels(img.gray, img.w, img.h);
  const r = { sheetId: s.sheetId, expected: s.panels.length, detected: panels.length, blank: all.length - panels.length };
  report.push(r);
  if (panels.length !== s.panels.length) { bad++; console.error(`SHEET ${s.sheetId}: detected ${panels.length} non-empty panels (+${r.blank} blank), expected ${s.panels.length}; not sliced`); continue; }
  if (!dry) s.panels.forEach((p, i) => execFileSync('ffmpeg', sliceArgs(join(dir, f), crop169(panels[i], k), join(out, `${p.shotId}.png`))));
  console.log(`sheet ${s.sheetId}: ${panels.length}/${s.panels.length} panels${r.blank ? ` (${r.blank} blank ignored)` : ''}${dry ? '' : ` -> ${s.panels.map((p) => p.shotId).join(', ')}`}`);
}
console.log(JSON.stringify(report));
if (bad) process.exit(1);
