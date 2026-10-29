// Customer film: the full v2 graph, Nano Banana stills already on Replicate, Seedance 2.5 at 480p after production approval.
// Gates stay pauses. outputs/state.json is rewritten on every status change.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Command } from '@langchain/langgraph';
import { buildGraph } from '../graph/graph.mjs';
import { FileMemorySaver } from '../graph/file-checkpointer.mjs';
import { nanoBananaStill } from '../graph/stills.mjs';
import { openRouterModel, RUNS_ROOT } from '../graph/deep-agent-node.mjs';
import { renderClipWithReplicate } from '../graph/producer.mjs';
import { invokePersisting, writeRunState } from '../graph/run-state.mjs';
import { sendPrompt } from '../crew/seedance-compiler/schema.mjs';
import { inputsFromProject, loadPhotoReferences, defaultPhotoRefsPath } from './run-rehearsal.mjs';
import { loadSecrets, defaultSecretsPath } from './lib/secrets.mjs';
import { withEventLog, appendEvent } from '../graph/event-log.mjs';

export function seedance480pRenderer({ apiKey, fetchFn = globalThis.fetch } = {}) {
  return async ({ clip, runDir, duration, state }) => renderClipWithReplicate({
    clip,
    promptText: sendPrompt(clip),
    referenceFiles: (clip.references ?? []).map((ref) => state?.assetFiles?.[ref.sourceTag] || state?.assetFiles?.[ref.assetKey] || state?.assetFiles?.[ref.tag]).filter(Boolean),
    runDir,
    apiKey,
    duration: duration ?? clip.generationPayload?.durationSec ?? 10,
    resolution: '480p',
    fetchFn,
  });
}

export async function runCustomer({
  projectPath,
  project,
  runId = `film-${randomUUID().slice(0, 8)}`,
  runsRoot = RUNS_ROOT,
  invoke,
  apiKey,
  fetchFn,
  secretsPath = defaultSecretsPath(),
  secrets,
  photoRefsPath,
  buildGraphFn = buildGraph,
  renderClip,
  renderStill,
  chargeRender,
  log = console.log,
} = {}) {
  const source = project ?? JSON.parse(await readFile(projectPath, 'utf8'));
  const inputs = inputsFromProject(source);
  const refs = await loadPhotoReferences(photoRefsPath === undefined && projectPath ? defaultPhotoRefsPath(projectPath) : photoRefsPath);
  if (refs.length) inputs.photoReferences = refs;
  const sec = secrets ?? loadSecrets(secretsPath, () => true);
  const token = apiKey ?? sec.REPLICATE_API_TOKEN;
  if (!invoke && !sec.OPENROUTER_API_KEY) throw new Error(`OPENROUTER_API_KEY not found in ${secretsPath}`);
  const runDir = join(runsRoot, runId);
  const stateFile = join(runDir, 'outputs', 'state.json');
  const eventsFile = join(runDir, 'events.jsonl');
  const checkpointer = new FileMemorySaver(join(runDir, 'outputs', 'checkpoint.json'));
  const still = renderStill ?? nanoBananaStill({ apiKey: token, fetchFn });
  const clip = renderClip ?? seedance480pRenderer({ apiKey: token, fetchFn });
  const graph = buildGraphFn({
    storyboard: true,
    production: true,
    autoApprove: false,
    autoApproveAnimatic: false,
    autoApproveProduction: false,
    useInterrupt: true,
    checkpointer,
    runDir,
    renderClip: chargeRender ? (request) => chargeRender({ kind: 'clip', request, render: () => clip(request) }) : clip,
    renderStill: chargeRender ? (request) => chargeRender({ kind: 'still', request, render: () => still(request) }) : still,
    onEvent: withEventLog(eventsFile),
    runTag: runId,
    ...(invoke ? { invoke } : { deepAgent: { runId, runsRoot, createModel: (config, agent) => openRouterModel(config, agent, { apiKey: sec.OPENROUTER_API_KEY }) } }),
  });
  appendEvent(eventsFile, { type: 'run-started', runId, production: true, resolution: '480p' });
  await writeRunState(stateFile, { status: 'running', pendingApproval: [] });
  const state = await invokePersisting(graph, { inputs }, { configurable: { thread_id: runId }, recursionLimit: 80, runName: 'wiggly-v2 customer', tags: [`runId:${runId}`, 'wiggly-v2', 'customer'] }, stateFile);
  log(`run ${runId}: status ${state.status}`);
  return { state, runId, stateFile, runDir };
}

export async function resumeCustomer({
  runId,
  runsRoot = RUNS_ROOT,
  decision,
  invoke,
  apiKey,
  fetchFn,
  secrets,
  secretsPath = defaultSecretsPath(),
  buildGraphFn = buildGraph,
  renderClip,
  renderStill,
  chargeRender,
  log = console.log,
} = {}) {
  if (!runId) throw new Error('runId is required to resume a film.');
  if (!decision) throw new Error('An approval decision is required.');
  const runDir = join(runsRoot, runId);
  const stateFile = join(runDir, 'outputs', 'state.json');
  await writeFile(join(runDir, 'outputs', 'approval.json'), JSON.stringify({ at: new Date().toISOString(), decision }, null, 2));
  const sec = secrets ?? (invoke ? {} : loadSecrets(secretsPath, () => true));
  const token = apiKey ?? sec.REPLICATE_API_TOKEN;
  const checkpointer = new FileMemorySaver(join(runDir, 'outputs', 'checkpoint.json'));
  const still = renderStill ?? nanoBananaStill({ apiKey: token, fetchFn });
  const clip = renderClip ?? seedance480pRenderer({ apiKey: token, fetchFn });
  const graph = buildGraphFn({
    storyboard: true,
    production: true,
    autoApprove: false,
    autoApproveAnimatic: false,
    autoApproveProduction: false,
    useInterrupt: true,
    checkpointer,
    runDir,
    renderClip: chargeRender ? (request) => chargeRender({ kind: 'clip', request, render: () => clip(request) }) : clip,
    renderStill: chargeRender ? (request) => chargeRender({ kind: 'still', request, render: () => still(request) }) : still,
    onEvent: withEventLog(join(runDir, 'events.jsonl')),
    runTag: runId,
    ...(invoke ? { invoke } : { deepAgent: { runId, runsRoot, createModel: (config, agent) => openRouterModel(config, agent, { apiKey: sec.OPENROUTER_API_KEY }) } }),
  });
  const state = await invokePersisting(graph, new Command({ resume: decision }), { configurable: { thread_id: runId }, recursionLimit: 80, runName: 'wiggly-v2 customer resume', tags: [`runId:${runId}`, 'wiggly-v2', 'customer'] }, stateFile);
  log(`run ${runId}: status ${state.status}`);
  return { state, runId, stateFile, runDir };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (name) => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
  runCustomer({ projectPath: arg('--project'), ...(arg('--run-id') ? { runId: arg('--run-id') } : {}), ...(arg('--photo-refs') ? { photoRefsPath: arg('--photo-refs') } : {}) })
    .then(({ state }) => { process.exitCode = state.status === 'failed' ? 2 : 0; })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
