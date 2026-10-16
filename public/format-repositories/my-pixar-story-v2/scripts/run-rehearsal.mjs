#!/usr/bin/env node
// Rehearsal runner: questionnaire answers -> real v2 graph (Deep Agents on OpenRouter Muse Spark 1.3).
// Stops at asset approval unless --placeholder-assets. Saves outputs + report.html under runs/<runId>/,
// updates the 'v2 dry run' section of ~/wiggly-progress.html live, traces to LangSmith when a key is present.
// Usage: node scripts/run-rehearsal.mjs --project <project.json> [--secrets <secrets.env>] [--placeholder-assets] [--run-id <id>] [--no-tracker]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildGraph, placeholderAssets } from '../graph/graph.mjs';
import { RUNS_ROOT, openRouterModel } from '../graph/deep-agent-node.mjs';
import { loadSecrets, defaultSecretsPath } from './lib/secrets.mjs';
import { makeTracing } from './lib/tracing.mjs';
import { createRecorder, upsertTracker, reportHtml, defaultTrackerPath } from './lib/report.mjs';

const OUTPUT_KEYS = { 'story-director': (s) => s.storyDirector, 'character-architect': (s) => s.characterArchitect?.output,
  'location-scout': (s) => s.locationScout?.output, 'seedance-compiler': (s) => s.seedanceCompiler?.output };

/** Map a studio project (inputs.subject object or string, inputs.answers) to graph inputs. No fallback story. */
export function inputsFromProject(project) {
  const inp = project?.inputs ?? project ?? {};
  const answers = inp.answers;
  if (!answers || typeof answers !== 'object' || !Object.keys(answers).length) throw new Error('project has no questionnaire answers (inputs.answers)');
  const s = inp.subject;
  const subject = typeof s === 'string' ? s
    : [s?.preferredName ?? s?.fullName, s?.recipientName && `story for ${s.recipientName}`, s?.relationshipToRecipient && `(${s.relationshipToRecipient})`].filter(Boolean).join(', ');
  return { subject, answers, ...(inp.castDescriptions ? { castDescriptions: inp.castDescriptions } : {}) };
}

const summarize = (agent, o) => {
  if (!o) return 'not run';
  if (agent === 'story-director') return `${o.title ?? 'untitled'}: ${o.scenes?.length ?? 0} scenes, cast ${(o.cast ?? []).map((c) => c.name).join(', ')}`;
  if (agent === 'character-architect') return `${o.characters?.length ?? 0} characters: ${(o.characters ?? []).map((c) => `${c.imageTag} ${c.name}`).join(', ')}`;
  if (agent === 'location-scout') return `${o.locations?.length ?? 0} locations: ${(o.locations ?? []).map((l) => `${l.elementTag} ${l.name}`).join(', ')}`;
  return `${o.segments?.length ?? 0} segments, ${o.totalRuntimeSec}s`;
};

export async function runRehearsal({ projectPath, runId = `rehearsal-${randomUUID().slice(0, 8)}`, runsRoot = RUNS_ROOT, invoke, log = console.log,
  secretsPath = defaultSecretsPath(), secrets, usePlaceholderAssets = false, trackerPath = defaultTrackerPath(), tracing } = {}) {
  if (!projectPath) throw new Error('--project <path to project/answers json> is required');
  const inputs = inputsFromProject(JSON.parse(await readFile(projectPath, 'utf8')));
  const sec = secrets ?? loadSecrets(secretsPath);
  if (!invoke && !sec.OPENROUTER_API_KEY) throw new Error(`OPENROUTER_API_KEY not found in ${secretsPath}`);
  const tr = tracing === undefined ? await makeTracing(sec) : tracing;
  const rec = createRecorder({ runId, placeholderAssets: usePlaceholderAssets, onChange: (m) => { if (trackerPath) { try { upsertTracker(m, trackerPath); } catch { /* tracker is optional */ } } } });
  const graph = buildGraph({ ...(invoke ? { invoke } : { deepAgent: { runId, runsRoot, createModel: (c, a) => openRouterModel(c, a, { apiKey: sec.OPENROUTER_API_KEY }) } }),
    onEvent: rec.onEvent, runTag: runId, ...(usePlaceholderAssets ? { autoApprove: placeholderAssets } : {}) });
  if (usePlaceholderAssets) log('PLACEHOLDER ASSETS: asset approval auto-filled with fake keys (no images generated)');
  const config = { runName: 'wiggly-v2 rehearsal', tags: [`runId:${runId}`, 'wiggly-v2', ...(usePlaceholderAssets ? ['placeholder-assets'] : [])],
    metadata: { runId, placeholderAssets: usePlaceholderAssets }, recursionLimit: 50, ...(tr ? { callbacks: tr.callbacks, runId: tr.rootRunId } : {}) };
  const state = await graph.invoke({ inputs }, config);
  if (tr) await tr.flush?.();
  const url = tr ? await tr.url() : null;
  rec.finish(state, url);
  const runDir = join(runsRoot, runId), dir = join(runDir, 'outputs');
  await mkdir(dir, { recursive: true });
  log(`run ${runId}: status ${state.status}`);
  for (const [agent, get] of Object.entries(OUTPUT_KEYS)) {
    const o = get(state);
    if (o) await writeFile(join(dir, `${agent}.json`), JSON.stringify(o, null, 2));
    log(`  ${agent}: ${summarize(agent, o)} (attempts ${state.attempts?.[agent] ?? 0}, retries ${state.retryCounts?.[agent] ?? 0})`);
  }
  await writeFile(join(dir, 'state.json'), JSON.stringify({ status: state.status, placeholderAssets: usePlaceholderAssets, approvedAssets: state.approvedAssets, pendingApproval: state.pendingApproval, retryCounts: state.retryCounts, escalations: state.escalations, validationErrors: state.validationErrors }, null, 2));
  const report = join(runDir, 'report.html');
  await writeFile(report, reportHtml(rec.model));
  for (const e of state.escalations ?? []) {
    log(`ESCALATED ${e.agent}: ${e.reason}`);
    for (const i of (e.issues ?? []).filter((x) => x.severity === 'error')) log(`  - [${i.code}] ${i.message}`);
  }
  if (state.status === 'awaiting-approval') log(`awaiting approval for: ${(state.pendingApproval ?? []).join(', ')}`);
  log(`outputs saved to ${dir}`); log(`report: ${report}`);
  log(url ? `LangSmith: ${url}` : 'LangSmith: not traced (no LANGSMITH_API_KEY)');
  return { state, dir, runId, report, url, model: rec.model };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const has = (k) => process.argv.includes(k);
  runRehearsal({ projectPath: arg('--project'), ...(arg('--run-id') ? { runId: arg('--run-id') } : {}), ...(arg('--secrets') ? { secretsPath: arg('--secrets') } : {}),
    usePlaceholderAssets: has('--placeholder-assets'), ...(has('--no-tracker') ? { trackerPath: null } : {}) })
    .then(({ state }) => { process.exitCode = state.status === 'failed' ? 2 : 0; })
    .catch((e) => { console.error(`rehearsal failed: ${e.message}`); process.exitCode = 1; });
}
