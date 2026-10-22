#!/usr/bin/env node
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { emitFlowJob, waitForFlowJob } from './flow-queue.mjs';
import { loadSecrets } from './lib/secrets.mjs';

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

  const sec = loadSecrets(undefined, () => true);
  const webhook = sec.FLOW_WEBHOOK_URL ? { url: sec.FLOW_WEBHOOK_URL, auth: sec.FLOW_WEBHOOK_AUTH } : null;

  const jobId = `loc-${loc.locationId}`;
  log(`Emitting Flow job for ${loc.name} (${loc.elementTag}): ${jobId}`);
  log(`Aspect: ${loc.locationPlatePrompt?.aspectRatio || '16:9'}`);
  log(`Prompt: ${loc.locationPlatePrompt?.promptText.slice(0, 120)}...`);

  await emitFlowJob({
    jobId,
    runId,
    kind: 'location-plate',
    prompt: loc.locationPlatePrompt?.promptText,
    aspect: loc.locationPlatePrompt?.aspectRatio || '16:9',
    webhook,
  });

  log(`Job emitted to Flow Queue. Waiting for Grokbot to render ${loc.name}...`);
  const landed = await waitForFlowJob(jobId, { runId, timeoutMs, isPanel: false });
  log(`SUCCESS: ${loc.name} landed! Resolution: ${landed.width}x${landed.height}`);

  // Copy to run assets
  const assetsDir = `runs/${runId}/assets`;
  await mkdir(assetsDir, { recursive: true });
  const localDest = join(assetsDir, `${loc.elementTag.replace('@', '')}-${loc.locationId}.png`);
  await copyFile(landed.outputPath, localDest);
  log(`Saved location asset to ${localDest}`);

  return { ok: true, loc, localDest, ...landed };
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
