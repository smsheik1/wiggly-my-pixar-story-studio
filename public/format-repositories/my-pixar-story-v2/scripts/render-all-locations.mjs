#!/usr/bin/env node
import { readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderLocation } from './render-location.mjs';

async function main() {
  const runId = process.argv[2] || 'r6-live';
  const lsPath = `runs/${runId}/outputs/location-scout.json`;
  const data = JSON.parse(await readFile(lsPath, 'utf8'));

  console.log(`Rendering all locations for run ${runId} (${data.locations.length} total)...`);

  const results = [];
  for (const l of data.locations) {
    const assetFile = `runs/${runId}/assets/${l.elementTag.replace('@', '')}-${l.locationId}.png`;
    if (existsSync(assetFile)) {
      console.log(`[SKIP] ${l.name} (${l.elementTag}) already rendered at ${assetFile}`);
      results.push({ ok: true, loc: l, localDest: assetFile });
      continue;
    }

    console.log(`\n========================================`);
    console.log(`STARTING: ${l.name} (${l.elementTag}) - ${l.locationId}`);
    console.log(`========================================`);

    try {
      const res = await renderLocation({ locId: l.locationId, runId, timeoutMs: 600_000 });
      results.push(res);
      console.log(`COMPLETED: ${l.name} -> ${res.localDest}`);

      // Copy to antigravity brain artifacts dir for viewing
      const artifactDest = `/Users/shaz/.gemini/antigravity/brain/8574b48e-ceb5-4f27-bf76-83c6902bfcbe/${l.locationId}-render.png`;
      try {
        await copyFile(res.localDest, artifactDest);
      } catch {}
    } catch (err) {
      console.error(`FAILED: ${l.name}: ${err.message}`);
    }
  }

  console.log(`\nAll location renders finished! (${results.length}/${data.locations.length} succeeded)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
