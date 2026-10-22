#!/usr/bin/env node
import { readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderCharacter } from './render-character.mjs';

async function main() {
  const runId = process.argv[2] || 'r6-live';
  const caPath = `runs/${runId}/outputs/character-architect.json`;
  const data = JSON.parse(await readFile(caPath, 'utf8'));

  console.log(`Rendering all characters for run ${runId} (${data.characters.length} total)...`);

  const results = [];
  for (const c of data.characters) {
    const assetFile = `runs/${runId}/assets/${c.imageTag.replace('@', '')}-${c.characterId}.png`;
    if (existsSync(assetFile)) {
      console.log(`[SKIP] ${c.name} (${c.imageTag}) already rendered at ${assetFile}`);
      results.push({ ok: true, char: c, localDest: assetFile });
      continue;
    }

    console.log(`\n========================================`);
    console.log(`STARTING: ${c.name} (${c.imageTag}) - ${c.characterId}`);
    console.log(`========================================`);

    try {
      const res = await renderCharacter({ charId: c.characterId, runId, timeoutMs: 600_000 });
      results.push(res);
      console.log(`COMPLETED: ${c.name} -> ${res.localDest}`);

      // Copy to antigravity brain artifacts dir for viewing
      const artifactDest = `/Users/shaz/.gemini/antigravity/brain/8574b48e-ceb5-4f27-bf76-83c6902bfcbe/${c.characterId}-render.png`;
      try {
        await copyFile(res.localDest, artifactDest);
      } catch {}
    } catch (err) {
      console.error(`FAILED: ${c.name}: ${err.message}`);
    }
  }

  console.log(`\nAll character renders finished! (${results.length}/${data.characters.length} succeeded)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
