#!/usr/bin/env node
// Render a single storyboard panel using Google Flow Grokbot via the Flow Queue.
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { emitFlowJob, waitForFlowJob } from './flow-queue.mjs';
import { loadSecrets } from './lib/secrets.mjs';
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

  const sec = loadSecrets(undefined, () => true);
  const webhook = sec.FLOW_WEBHOOK_URL ? { url: sec.FLOW_WEBHOOK_URL, auth: sec.FLOW_WEBHOOK_AUTH } : null;

  const jobId = `panel-${panel.shotId.replace('.', '_')}${jobSuffix ? `-${jobSuffix}` : ''}`;
  log(`Emitting Flow job for Shot ${panel.shotId}: ${jobId}`);
  log(`Aspect: ${panel.aspect || '16:9'} (2K)`);
  log(`References (${refPaths.length}): ${panel.references.map((r) => r.imageTag || r.tag).join(', ')}`);
  log(`Prompt: ${prompt.slice(0, 140)}...`);

  await emitFlowJob({
    jobId,
    runId,
    kind: 'storyboard-panel',
    prompt,
    references: refPaths,
    aspect: panel.aspect || '16:9',
    webhook,
  });

  log(`Job emitted to Flow Queue. Waiting for Grokbot to render Shot ${panel.shotId}...`);
  const landed = await waitForFlowJob(jobId, { runId, timeoutMs, isPanel: true });
  log(`SUCCESS: Shot ${panel.shotId} landed! Resolution: ${landed.width}x${landed.height}`);

  // Copy to run storyboard-panels directory
  const panelsDir = `runs/${runId}/storyboard-panels`;
  await mkdir(panelsDir, { recursive: true });
  const localDest = join(panelsDir, `${panel.shotId}.png`);
  await copyFile(landed.outputPath, localDest);
  log(`Saved storyboard panel to ${localDest}`);

  // Append event to events.jsonl
  const eventsFile = `runs/${runId}/events.jsonl`;
  appendEvent(eventsFile, {
    at: new Date().toISOString(),
    type: 'render-job-landed',
    kind: 'storyboard-panel',
    shotId: panel.shotId,
    resolution: `${landed.width}x${landed.height}`,
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
