#!/usr/bin/env node
// Slice storyboard sheets into per-shot 1920x1080 stills by detecting the drawn panel borders (any layout Flow returns).
//  - blank panels ignored; panels read top-to-bottom, left-to-right, mapped to the manifest's shot ids in order
//  - each rect is moved inward past its border (dark run + anti-alias + a few px) until no edge line is border or paper
//  - panel ratio 1.70-1.86 -> crop to 16:9 keeping the top (excess comes off the bottom); anything else is REJECTED
//    (never padded or blur-filled: house style, crew/storyboard-artist/storyboard-style.md). --fit crop forces a crop.
//  - a panel under 960 px wide in the sheet (>2x upscale to 1920) is rejected as PANEL_LOW_RES unless --review-only.
//    Sheets are a review aid; production panels are one native 16:9 2K image per shot (scripts/check-panels.mjs).
//  - fails loudly when the detected count differs from the manifest, or an output edge still shows border/paper
// Usage: node scripts/slice-storyboard.mjs --manifest <manifest.json> --sheets <dir> --out <dir> [--only 1,2] [--dry] [--fit auto|crop] [--review-only] [--report r.json]
import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readGray, detectPanels, refineRect, fitPlan, paperGray, edgeStats, crop169, isDirtyEdge } from './lib/panel-detect.mjs';
import { sliceArgs } from './lib/animatic.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const man = JSON.parse(await readFile(arg('--manifest'), 'utf8'));
const dir = arg('--sheets'), out = arg('--out'); const dry = process.argv.includes('--dry'); const fit = arg('--fit', 'auto'); const reviewOnly = process.argv.includes('--review-only');
if (!['auto', 'crop'].includes(fit)) throw new Error(`--fit ${fit}: only auto|crop (padding and blur fills are banned)`);
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
    if (plan.mode === 'reject') { bad++; report.push({ sheetId: s.sheetId, shotId: sp.shotId, ratio: +plan.ratio.toFixed(2), error: 'PANEL_NOT_16_9' }); console.error(`${sp.shotId}  ratio ${plan.ratio.toFixed(2)} is not 16:9; not sliced (re-render, never pad)`); return; }
    if (plan.rect.w < 960 && !reviewOnly) { bad++; report.push({ sheetId: s.sheetId, shotId: sp.shotId, width: plan.rect.w, error: 'PANEL_LOW_RES' }); console.error(`${sp.shotId}  ${plan.rect.w}px wide in the sheet; needs >2x upscale; not sliced (use --review-only for a scratch animatic)`); return; }
    const edges = Object.fromEntries(['top', 'bottom', 'left', 'right'].map((e) => [e, edgeStats(img.gray, img.w, plan.rect, e, { paper })]));
    const dirty = Object.entries(edges).filter(([, e]) => isDirtyEdge(e)).map(([k]) => k);
    const rec = { sheetId: s.sheetId, shotId: sp.shotId, ratio: +plan.ratio.toFixed(2), mode: plan.mode, rect: plan.rect, paper, edges, dirty };
    report.push(rec); if (dirty.length) bad++;
    if (!dry) execFileSync('ffmpeg', sliceArgs(join(dir, f), plan.rect, join(out, `${sp.shotId}.png`), { fit: 'crop' }));
    console.log(`${sp.shotId}  sheet ${s.sheetId}  ratio ${rec.ratio}  ${rec.mode}${dirty.length ? `  EDGE NOT CLEAN: ${dirty.join(',')}` : ''}`);
  });
}
if (arg('--report')) await writeFile(arg('--report'), JSON.stringify(report, null, 2));
if (bad) { console.error(`${bad} problem(s)`); process.exit(1); }
