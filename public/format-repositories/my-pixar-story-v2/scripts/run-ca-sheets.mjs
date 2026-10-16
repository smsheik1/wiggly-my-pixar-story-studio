#!/usr/bin/env node
// Wiggly v2: run ONLY the Character Architect in model-sheet mode (Format B) on an earlier run's outputs.
// Reuses the graph's CA node (select -> invoke -> parse -> gate -> retry). Never overwrites the source run.
// Usage: node scripts/run-ca-sheets.mjs --from <runId> --run-id <newRunId> --project <project.json> [--photo-refs <file>] [--secrets <secrets.env>]
//   [--first-token-timeout-sec 900] [--idle-timeout-sec 900] [--stall-warn-sec 600]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RunnableLambda } from '@langchain/core/runnables';
import { makeAgentNode } from '../graph/graph.mjs';
import { RUNS_ROOT, deepAgentInvoke, openRouterModel } from '../graph/deep-agent-node.mjs';
import { createLiveness, LivenessHandler, DEFAULT_TIMEOUTS } from '../graph/liveness.mjs';
import { loadSecrets, defaultSecretsPath } from './lib/secrets.mjs';
import { makeTracing } from './lib/tracing.mjs';
import { auditRun } from './audit-trace.mjs';
import { inputsFromProject, loadPhotoReferences, defaultPhotoRefsPath } from './run-rehearsal.mjs';

/** Build the CA model-sheet state from an earlier run's story-director + character-architect outputs. */
export function sheetState({ inputs, storyDirector, characters }) {
  const masterRenderRef = {}, masterRenderPrompts = {};
  for (const c of characters.characters) {
    masterRenderRef[c.elementTag] = `asset:master-render:${c.characterId}-v1`;
    masterRenderPrompts[c.elementTag] = c.masterRenderPrompt.promptText;
  }
  return { inputs, storyDirector, characterArchitect: { options: { mode: 'model-sheet', masterRenderRef, masterRenderPrompts } } };
}

export async function runCaSheets({ from, runId, projectPath, photoRefsPath, secretsPath = defaultSecretsPath(), secrets, runsRoot = RUNS_ROOT, invoke, timeouts = {}, log = console.log,
  tracing, audit = auditRun, auditDelayMs = 5000 } = {}) {
  if (!from || !runId || !projectPath) throw new Error('--from, --run-id and --project are required');
  if (from === runId) throw new Error('--run-id must differ from --from (never overwrite the source run)');
  const outDir = join(runsRoot, runId, 'outputs');
  if (existsSync(outDir)) throw new Error(`${outDir} already exists`);
  const src = join(runsRoot, from, 'outputs');
  const storyDirector = JSON.parse(await readFile(join(src, 'story-director.json'), 'utf8'));
  const characters = JSON.parse(await readFile(join(src, 'character-architect.json'), 'utf8'));
  const inputs = inputsFromProject(JSON.parse(await readFile(projectPath, 'utf8')));
  const refs = await loadPhotoReferences(photoRefsPath ?? defaultPhotoRefsPath(projectPath));
  if (refs.length) inputs.photoReferences = refs;
  const sec = secrets ?? loadSecrets(secretsPath);
  const tr = tracing === undefined ? await makeTracing(sec) : tracing;
  const t = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const liveness = createLiveness({ stallMs: t.stallMs });
  if (!invoke) {
    if (!sec.OPENROUTER_API_KEY) throw new Error(`OPENROUTER_API_KEY not found in ${secretsPath}`);
    invoke = deepAgentInvoke({ runId, runsRoot, createModel: (c, a) => openRouterModel(c, a, { apiKey: sec.OPENROUTER_API_KEY }) });
  }
  const events = [];
  const node = makeAgentNode('character-architect', invoke, { runTag: runId, liveness, timeouts: { firstTokenMs: t.firstTokenMs, idleMs: t.idleMs },
    onEvent: (e) => { events.push({ at: new Date().toISOString(), type: e.type, attempt: e.attempt, codes: (e.issues ?? []).filter((i) => i.severity === 'error').map((i) => i.code) });
      log(`[ca-sheets] ${e.type}${e.attempt ? ` #${e.attempt}` : ''}`); } });
  if (tr) log(`LangSmith: tracing to ${tr.projectName}`);
  const started = Date.now();
  const hb = setInterval(() => { for (const e of liveness.active()) log(`[heartbeat] ${liveness.line(e)}`); }, 15000);
  let res;
  try {
    res = await RunnableLambda.from(node).invoke(sheetState({ inputs, storyDirector, characters }), {
      runName: 'wiggly-v2 ca-sheets', tags: [`runId:${runId}`, 'wiggly-v2', 'ca-sheets'],
      metadata: { runId, from, mode: 'model-sheet' },
      callbacks: [new LivenessHandler(liveness), ...(tr?.callbacks ?? [])],
      ...(tr ? { runId: tr.rootRunId } : {}),
    });
  } finally { clearInterval(hb); }
  if (tr) await tr.flush?.();
  const url = tr ? await tr.url() : null;
  await mkdir(outDir, { recursive: true });
  if (res.characterArchitect?.output) await writeFile(join(outDir, 'character-architect.json'), JSON.stringify(res.characterArchitect.output, null, 2));
  const summary = { from, runId, status: res.status ?? 'passed', ms: Date.now() - started, attempts: res.attempts, gateIssues: res.gateIssues, validationErrors: res.validationErrors, escalations: res.escalations, events, langsmithUrl: url, tracingProject: tr?.projectName ?? null };
  await writeFile(join(outDir, 'state.json'), JSON.stringify(summary, null, 2));
  if (tr && audit) {
    try { if (auditDelayMs) await new Promise((r) => setTimeout(r, auditDelayMs)); await audit({ runId, traceId: tr.rootRunId, runsRoot, secrets: sec, trackerPath: null, log }); }
    catch (e) { log(`audit skipped: ${e.message}`); }
  }
  log(`run ${runId}: ${summary.status}, attempts ${JSON.stringify(res.attempts)}, ${Math.round(summary.ms / 1000)}s; outputs in ${outDir}`);
  log(url ? `LangSmith: ${url}` : 'LangSmith: not traced (no LANGSMITH_API_KEY)');
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const sec = (k) => (arg(k) ? +arg(k) * 1000 : undefined);
  const timeouts = Object.fromEntries(Object.entries({ firstTokenMs: sec('--first-token-timeout-sec') ?? 900_000, idleMs: sec('--idle-timeout-sec') ?? 900_000, stallMs: sec('--stall-warn-sec') ?? 600_000 }));
  runCaSheets({ from: arg('--from'), runId: arg('--run-id'), projectPath: arg('--project'), photoRefsPath: arg('--photo-refs'), ...(arg('--secrets') ? { secretsPath: arg('--secrets') } : {}), timeouts })
    .then((s) => process.exit(s.status === 'failed' ? 1 : 0), (e) => { console.error(e.message); process.exit(2); });
}
