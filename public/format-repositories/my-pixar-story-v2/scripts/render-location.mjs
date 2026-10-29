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

export async function renderLocation({ locId, runId = 'r6-live', timeoutMs = 600_000, log = console.log } = {}) {
  const lsPath = `runs/${runId}/outputs/location-scout.json`;
  if (!existsSync(lsPath)) throw new Error(`Location Scout output not found at ${lsPath}`);
  const lsData = JSON.parse(await readFile(lsPath, 'utf8'));

  const norm = String(locId).toLowerCase().replace(/[@\s-]+/g, '');
  const loc = lsData.locations.find((l) => {
    const lid = String(l.locationId).toLowerCase().replace(/[@\s-]+/g, '');
    const tag = String(l.elementTag).toLowerCase().replace(/[@\s-]+/g, '');
    const name = String(l.name).toLowerCase().replace(/[@\s-]+/g, '');
    return lid === norm || tag === norm || name === norm;
  });
  if (!loc) throw new Error(`Location "${locId}" not found in ${lsPath}`);

  const token = loadSecrets(undefined, () => true).REPLICATE_API_TOKEN?.trim();
  if (!token) throw new Error(missingReplicateTokenError());
  const assetsDir = `runs/${runId}/assets`;
  await mkdir(assetsDir, { recursive: true });
  const localDest = join(assetsDir, `${loc.elementTag.replace('@', '')}-${loc.locationId}.png`);
  log(`Rendering ${loc.name} (${loc.elementTag}) with Nano Banana 2.1`);
  const saved = await saveNanoBanana({
    prompt: loc.locationPlatePrompt?.promptText,
    aspectRatio: loc.locationPlatePrompt?.aspectRatio || '16:9',
    resolution: '1K',
    apiKey: token,
    dest: localDest,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, timeoutMs))),
  });
  log(`Saved location asset to ${saved.dest} (${saved.id})`);
  return { ok: true, loc, localDest, id: saved.id, url: saved.url };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''))) {
  const args = parseArgs();
  const locId = args.loc || args.id || 'loc-1';
  renderLocation({ locId, runId: args['run-id'] || 'r6-live' })
    .then((res) => {
      console.log(`Render complete: ${res.localDest}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`Render failed: ${err.message}`);
      process.exit(1);
    });
}
