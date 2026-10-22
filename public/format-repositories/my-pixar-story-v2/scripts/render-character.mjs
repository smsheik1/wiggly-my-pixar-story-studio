#!/usr/bin/env node
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { emitFlowJob, waitForFlowJob, resolveQueueDir } from './flow-queue.mjs';
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

export async function renderCharacter({ charId, runId = 'r6-live', timeoutMs = 600_000, log = console.log } = {}) {
  const caPath = `runs/${runId}/outputs/character-architect.json`;
  if (!existsSync(caPath)) throw new Error(`Character Architect output not found at ${caPath}`);
  const caData = JSON.parse(await readFile(caPath, 'utf8'));

  const char = caData.characters.find(
    (c) => c.characterId === charId || c.elementTag === charId || c.imageTag === charId || c.name.toLowerCase() === charId.toLowerCase()
  );
  if (!char) throw new Error(`Character "${charId}" not found in ${caPath}`);

  const sec = loadSecrets(undefined, () => true);
  const webhook = sec.FLOW_WEBHOOK_URL ? { url: sec.FLOW_WEBHOOK_URL, auth: sec.FLOW_WEBHOOK_AUTH } : null;

  const jobId = `char-${char.characterId}`;
  log(`Emitting Flow job for ${char.name} (${char.imageTag}): ${jobId}`);
  log(`Aspect: ${char.masterRenderPrompt?.aspectRatio || '1:1'}`);
  log(`Prompt: ${char.masterRenderPrompt?.promptText.slice(0, 120)}...`);

  await emitFlowJob({
    jobId,
    runId,
    kind: 'character-master',
    prompt: char.masterRenderPrompt?.promptText,
    aspect: char.masterRenderPrompt?.aspectRatio || '1:1',
    webhook,
  });

  log(`Job emitted to Flow Queue. Waiting for Grokbot to render ${char.name}...`);
  const landed = await waitForFlowJob(jobId, { runId, timeoutMs, isPanel: false });
  log(`SUCCESS: ${char.name} landed! Resolution: ${landed.width}x${landed.height}`);

  // Copy to run assets
  const assetsDir = `runs/${runId}/assets`;
  await mkdir(assetsDir, { recursive: true });
  const localDest = join(assetsDir, `${char.imageTag.replace('@', '')}-${char.characterId}.png`);
  await copyFile(landed.outputPath, localDest);
  log(`Saved character asset to ${localDest}`);

  return { ok: true, char, localDest, ...landed };
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
