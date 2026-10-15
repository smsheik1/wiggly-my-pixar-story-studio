#!/usr/bin/env node
// Rehearsal runner: questionnaire answers -> real v2 graph (Deep Agents on OpenRouter Muse Spark 1.3)
// -> stops at the asset approval gate. Saves each agent output under runs/<runId>/outputs/.
// Usage: OPENROUTER_API_KEY=... node scripts/run-rehearsal.mjs --project <project.json> [--run-id <id>]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildGraph } from '../graph/graph.mjs';
import { RUNS_ROOT } from '../graph/deep-agent-node.mjs';

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

export async function runRehearsal({ projectPath, runId = `rehearsal-${randomUUID().slice(0, 8)}`, runsRoot = RUNS_ROOT, invoke, log = console.log } = {}) {
  if (!projectPath) throw new Error('--project <path to project/answers json> is required');
  const inputs = inputsFromProject(JSON.parse(await readFile(projectPath, 'utf8')));
  if (!invoke && !process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');
  const graph = buildGraph(invoke ? { invoke } : { deepAgent: { runId, runsRoot } });
  const state = await graph.invoke({ inputs }); // no approvedAssets -> halts at the approval gate
  const dir = join(runsRoot, runId, 'outputs');
  await mkdir(dir, { recursive: true });
  log(`run ${runId}: status ${state.status}`);
  for (const [agent, get] of Object.entries(OUTPUT_KEYS)) {
    const o = get(state);
    if (o) await writeFile(join(dir, `${agent}.json`), JSON.stringify(o, null, 2));
    log(`  ${agent}: ${summarize(agent, o)} (attempts ${state.attempts?.[agent] ?? 0}, retries ${state.retryCounts?.[agent] ?? 0})`);
  }
  await writeFile(join(dir, 'state.json'), JSON.stringify({ status: state.status, pendingApproval: state.pendingApproval, retryCounts: state.retryCounts, escalations: state.escalations, validationErrors: state.validationErrors }, null, 2));
  for (const e of state.escalations ?? []) {
    log(`ESCALATED ${e.agent}: ${e.reason}`);
    for (const i of (e.issues ?? []).filter((x) => x.severity === 'error')) log(`  - [${i.code}] ${i.message}`);
  }
  if (state.status === 'awaiting-approval') log(`awaiting approval for: ${(state.pendingApproval ?? []).join(', ')}`);
  log(`outputs saved to ${dir}`);
  return { state, dir, runId };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  runRehearsal({ projectPath: arg('--project'), ...(arg('--run-id') ? { runId: arg('--run-id') } : {}) })
    .then(({ state }) => { process.exitCode = state.status === 'failed' ? 2 : 0; })
    .catch((e) => { console.error(`rehearsal failed: ${e.message}`); process.exitCode = 1; });
}
