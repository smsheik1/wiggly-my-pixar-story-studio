#!/usr/bin/env node
// Render a single storyboard panel using Google Flow Grokbot via the Flow Queue.
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadSecrets } from './lib/secrets.mjs';
import { missingReplicateTokenError, saveNanoBanana } from './replicate-image.mjs';
import { appendEvent } from '../graph/event-log.mjs';

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

export async function renderPanel({ shotId, runId = 'r6-live', jobSuffix = '', timeoutMs = 1_800_000, log = console.log } = {}) {
  const panelsManifest = `runs/${runId}/storyboard-export/panels/panels.json`;
  if (!existsSync(panelsManifest)) throw new Error(`panels.json not found at ${panelsManifest}`);
  const manifest = JSON.parse(await readFile(panelsManifest, 'utf8'));

  const panel = manifest.panels.find((p) => p.shotId === String(shotId));
  if (!panel) throw new Error(`Shot "${shotId}" not found in ${panelsManifest}`);

  const promptPath = `runs/${runId}/storyboard-export/panels/${panel.promptFile}`;
  if (!existsSync(promptPath)) throw new Error(`Prompt file not found at ${promptPath}`);
  const prompt = await readFile(promptPath, 'utf8');

  // Resolve reference images from state.json
  const statePath = `runs/${runId}/outputs/state.json`;
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const refPaths = [];
  for (const ref of panel.references) {
    const key = ref.imageTag || ref.tag;
    const refFile = state.assetFiles[key];
    if (!refFile || !existsSync(refFile)) throw new Error(`Reference file missing for ${key}: ${refFile}`);
    refPaths.push(refFile);
  }

  const token = loadSecrets(undefined, () => true).REPLICATE_API_TOKEN?.trim();
  if (!token) throw new Error(missingReplicateTokenError());
  log(`Rendering Shot ${panel.shotId} with Nano Banana 2.1`);
  log(`References (${refPaths.length}): ${panel.references.map((r) => r.imageTag || r.tag).join(', ')}`);
  const panelsDir = `runs/${runId}/storyboard-panels`;
  await mkdir(panelsDir, { recursive: true });
  const localDest = join(panelsDir, `${panel.shotId}.png`);
  const saved = await saveNanoBanana({
    prompt,
    aspectRatio: panel.aspect || '16:9',
    resolution: '2K',
    referencePaths: refPaths,
    apiKey: token,
    dest: localDest,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, timeoutMs))),
  });
  const landed = { id: saved.id, url: saved.url };
  log(`Saved storyboard panel to ${localDest} (${saved.id})`);

  // Append event to events.jsonl
  const eventsFile = `runs/${runId}/events.jsonl`;
  appendEvent(eventsFile, {
    at: new Date().toISOString(),
    type: 'render-job-landed',
    kind: 'storyboard-panel',
    shotId: panel.shotId,
    predictionId: landed.id,
    file: localDest,
  });

  return { ok: true, panel, localDest, ...landed };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''))) {
  const args = parseArgs();
  const shotId = args.shot || args.id || '1.1';
  const jobSuffix = args.suffix || args['job-suffix'] || '';
  renderPanel({ shotId, runId: args['run-id'] || 'r6-live', jobSuffix })
    .then((res) => {
      console.log(`Render complete: ${res.localDest}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`Render failed: ${err.message}`);
      process.exit(1);
    });
}
