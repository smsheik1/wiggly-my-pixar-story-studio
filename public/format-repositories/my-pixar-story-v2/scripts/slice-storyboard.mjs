#!/usr/bin/env node
// Slice storyboard sheets into per-shot 1920x1080 stills by detecting the drawn panel borders (any layout Flow returns).
//  - blank panels ignored; panels read top-to-bottom, left-to-right, mapped to the manifest's shot ids in order
//  - each rect is moved inward past its border (dark run + anti-alias + a few px) until no edge line is border or paper
//  - --fit auto (default): panel ratio 1.5-2.1 -> crop to 16:9 keeping the top (excess comes off the bottom);
//    otherwise the whole panel is centred over a blurred copy of itself. --fit crop|pad|blur forces one mode.
//  - fails loudly when the detected count differs from the manifest, or an output edge still shows border/paper
// Usage: node scripts/slice-storyboard.mjs --manifest <manifest.json> --sheets <dir> --out <dir> [--only 1,2] [--dry] [--fit auto|crop|blur|pad] [--report r.json]
import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readGray, detectPanels, refineRect, fitPlan, paperGray, edgeStats, crop169, isDirtyEdge } from './lib/panel-detect.mjs';
import { sliceArgs } from './lib/animatic.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const man = JSON.parse(await readFile(arg('--manifest'), 'utf8'));
const dir = arg('--sheets'), out = arg('--out'); const dry = process.argv.includes('--dry'); const fit = arg('--fit', 'auto');
if (!dry) await mkdir(out, { recursive: true });
const only = arg('--only')?.split(',');
const files = await readdir(dir); const report = []; let bad = 0;
for (const s of man.sheets) {
  if (only && !only.includes(String(s.sheetId))) continue;
  const f = files.find((x) => new RegExp(`^sheet-${s.sheetId}\\.(png|jpe?g|webp)$`, 'i').test(x));
  if (!f) { report.push({ sheetId: s.sheetId, error: 'image missing' }); bad++; continue; }
  const img = readGray(join(dir, f), 100000); // full resolution: edge checks are per pixel
  const paper = paperGray(img.gray, img.w, img.h);
  const { panels, all } = detectPanels(img.gray, img.w, img.h);
  if (panels.length !== s.panels.length) { bad++; report.push({ sheetId: s.sheetId, expected: s.panels.length, detected: panels.length }); console.error(`SHEET ${s.sheetId}: detected ${panels.length} non-empty panels (+${all.length - panels.length} blank), expected ${s.panels.length}; not sliced`); continue; }
  s.panels.forEach((sp, i) => {
    const r = refineRect(img.gray, img.w, img.h, panels[i], { paper });
    let plan = fitPlan(r);
    if (fit === 'crop') plan = { mode: 'crop', ratio: plan.ratio, rect: crop169(r) };
    else if (fit === 'blur' || fit === 'pad') plan = { mode: fit, ratio: plan.ratio, rect: fitPlan(r, { lo: 99 }).rect };
    const edges = Object.fromEntries(['top', 'bottom', 'left', 'right'].map((e) => [e, edgeStats(img.gray, img.w, plan.rect, e, { paper })]));
    const dirty = Object.entries(edges).filter(([, e]) => isDirtyEdge(e)).map(([k]) => k);
    const rec = { sheetId: s.sheetId, shotId: sp.shotId, ratio: +plan.ratio.toFixed(2), mode: plan.mode === 'pad' && fit === 'auto' ? 'blur-pad' : plan.mode, rect: plan.rect, paper, edges, dirty };
    report.push(rec); if (dirty.length) bad++;
    if (!dry) execFileSync('ffmpeg', sliceArgs(join(dir, f), plan.rect, join(out, `${sp.shotId}.png`), { fit: plan.mode === 'pad' && fit === 'auto' ? 'blur' : plan.mode }));
    console.log(`${sp.shotId}  sheet ${s.sheetId}  ratio ${rec.ratio}  ${rec.mode}${dirty.length ? `  EDGE NOT CLEAN: ${dirty.join(',')}` : ''}`);
  });
}
if (arg('--report')) await writeFile(arg('--report'), JSON.stringify(report, null, 2));
if (bad) { console.error(`${bad} problem(s)`); process.exit(1); }
