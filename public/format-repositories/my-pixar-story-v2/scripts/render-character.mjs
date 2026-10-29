#!/usr/bin/env node
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadSecrets } from './lib/secrets.mjs';
import { missingReplicateTokenError, saveNanoBanana } from './replicate-image.mjs';

function parseArgs(args = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (k.startsWith('--')) {
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      out[k.slice(2)] = val;
    }
  }
  return out;
}

export async function renderCharacter({ charId, runId = 'r6-live', timeoutMs = 600_000, log = console.log } = {}) {
  const caPath = `runs/${runId}/outputs/character-architect.json`;
  if (!existsSync(caPath)) throw new Error(`Character Architect output not found at ${caPath}`);
  const caData = JSON.parse(await readFile(caPath, 'utf8'));

  const char = caData.characters.find(
    (c) => c.characterId === charId || c.elementTag === charId || c.imageTag === charId || c.name.toLowerCase() === charId.toLowerCase()
  );
  if (!char) throw new Error(`Character "${charId}" not found in ${caPath}`);

  const token = loadSecrets(undefined, () => true).REPLICATE_API_TOKEN?.trim();
  if (!token) throw new Error(missingReplicateTokenError());
  const assetsDir = `runs/${runId}/assets`;
  await mkdir(assetsDir, { recursive: true });
  const localDest = join(assetsDir, `${char.imageTag.replace('@', '')}-${char.characterId}.png`);
  log(`Rendering ${char.name} (${char.imageTag}) with Nano Banana 2.1`);
  const saved = await saveNanoBanana({
    prompt: char.masterRenderPrompt?.promptText,
    aspectRatio: char.masterRenderPrompt?.aspectRatio || '1:1',
    resolution: '1K',
    apiKey: token,
    dest: localDest,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, timeoutMs))),
  });
  log(`Saved character asset to ${saved.dest} (${saved.id})`);
  return { ok: true, char, localDest, id: saved.id, url: saved.url };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''))) {
  const args = parseArgs();
  const charId = args.char || args.id || 'shaz';
  renderCharacter({ charId, runId: args['run-id'] || 'r6-live' })
    .then((res) => {
      console.log(`Render complete: ${res.localDest}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`Render failed: ${err.message}`);
      process.exit(1);
    });
}
