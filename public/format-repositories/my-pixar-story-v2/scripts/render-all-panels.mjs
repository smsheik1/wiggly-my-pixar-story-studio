#!/usr/bin/env node
// Render all 20 storyboard panels sequentially via Google Flow Grokbot.
import { readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { renderPanel } from './render-panel.mjs';

async function main() {
  const runId = process.argv[2] || 'r6-live';
  const panelsManifest = `runs/${runId}/storyboard-export/panels/panels.json`;
  if (!existsSync(panelsManifest)) throw new Error(`panels.json not found at ${panelsManifest}`);
  const manifest = JSON.parse(await readFile(panelsManifest, 'utf8'));

  console.log(`Rendering all 20 storyboard panels for run ${runId}...`);

  const results = [];
  for (const p of manifest.panels) {
    const localDest = `runs/${runId}/storyboard-panels/${p.shotId}.png`;
    if (existsSync(localDest)) {
      console.log(`[SKIP] Shot ${p.shotId} already rendered at ${localDest}`);
      results.push({ ok: true, panel: p, localDest });
      continue;
    }

    console.log(`\n========================================`);
    console.log(`STARTING: Shot ${p.shotId} (${p.shotSizeAndAngle})`);
    console.log(`========================================`);

    try {
      const res = await renderPanel({ shotId: p.shotId, runId, timeoutMs: 600_000 });
      results.push(res);
      console.log(`COMPLETED: Shot ${p.shotId} -> ${res.localDest}`);

      // Copy to antigravity brain artifacts dir for viewing
      const artifactDest = `/Users/shaz/.gemini/antigravity/brain/8574b48e-ceb5-4f27-bf76-83c6902bfcbe/shot-${p.shotId.replace('.', '-')}-panel.png`;
      try {
        await copyFile(res.localDest, artifactDest);
      } catch {}
    } catch (err) {
      console.error(`FAILED: Shot ${p.shotId}: ${err.message}`);
      // Do not abort whole sequence on one failure; record and continue
      results.push({ ok: false, panel: p, error: err.message });
    }
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n========================================`);
  console.log(`Storyboard panel rendering complete: ${passed}/${manifest.panels.length} succeeded.`);
  console.log(`========================================`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
