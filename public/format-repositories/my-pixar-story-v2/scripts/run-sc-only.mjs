#!/usr/bin/env node
// Resume a rehearsal that stopped at asset approval: run ONLY the Seedance Compiler on the saved
// runs/<runId>/outputs/{story-director,character-architect,location-scout,state}.json.
// run-rehearsal.mjs has no checkpointer (the graph always starts at the Story Director), so this re-enters at the SC node.
// Approvals: placeholder asset keys for every pendingApproval tag (same as --placeholder-assets; no image or video calls).
// Budget guard: polls the OpenRouter key and aborts if this run spends more than --max-usd (default 0.05).
// Usage: node scripts/run-sc-only.mjs --project runs/<id>/project.json --run-id <id> [--max-usd 0.05] [--secrets <file>]
//   [--suffix v2]   write seedance-compiler-v2.json / sc-state-v2.json instead of overwriting the first SC output
//   [--audit-id <id>] audit folder runs/<id>/ (default <runId>-sc)
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunnableLambda } from '@langchain/core/runnables';
import { makeAgentNode, placeholderAssets } from '../graph/graph.mjs';
import { RUNS_ROOT, openRouterModel, deepAgentInvoke } from '../graph/deep-agent-node.mjs';
import { createLiveness, LivenessHandler, DEFAULT_TIMEOUTS } from '../graph/liveness.mjs';
import { loadSecrets, defaultSecretsPath } from './lib/secrets.mjs';
import { makeTracing } from './lib/tracing.mjs';
import { auditRun } from './audit-trace.mjs';
import { inputsFromProject, loadPhotoReferences, defaultPhotoRefsPath } from './run-rehearsal.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const log = (...a) => console.log(new Date().toISOString(), ...a);
const projectPath = arg('--project'), runId = arg('--run-id'), maxUsd = +(arg('--max-usd') ?? 0.05);
const suffix = arg('--suffix') ? `-${arg('--suffix')}` : '', auditId = arg('--audit-id') ?? `${runId}-sc`;
if (!projectPath || !runId) throw new Error('--project and --run-id are required');
const sec = loadSecrets(arg('--secrets') ?? defaultSecretsPath());
if (!sec.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing');
const keyUsage = async () => { const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${sec.OPENROUTER_API_KEY}` } }); const d = (await r.json()).data ?? {}; return { usage: d.usage, remaining: d.limit_remaining }; };

const out = join(RUNS_ROOT, runId, 'outputs');
const rd = async (f) => JSON.parse(await readFile(join(out, f), 'utf8'));
const [sd, ca, ls, prev] = await Promise.all(['story-director.json', 'character-architect.json', 'location-scout.json', 'state.json'].map(rd));
if (prev.status !== 'awaiting-approval') throw new Error(`run ${runId} is ${prev.status}, not awaiting-approval`);
const inputs = inputsFromProject(JSON.parse(await readFile(projectPath, 'utf8')));
const refs = await loadPhotoReferences(defaultPhotoRefsPath(projectPath)); if (refs.length) inputs.photoReferences = refs;
const approvedAssets = { ...(prev.approvedAssets ?? {}), ...placeholderAssets(prev.pendingApproval ?? []) };
log(`approving ${Object.keys(approvedAssets).length} tags with placeholder keys (no image generation)`);
const state = { inputs, storyDirector: sd, characterArchitect: { output: ca }, locationScout: { output: ls }, approvedAssets };

const b0 = await keyUsage(); log(`key remaining at start: $${b0.remaining?.toFixed(4)}; abort above $${maxUsd} spent`);
const guard = setInterval(async () => { try { const b = await keyUsage(); const spent = b.usage - b0.usage; log(`[budget] spent $${spent.toFixed(4)}, remaining $${b.remaining?.toFixed(4)}`);
  if (spent > maxUsd) { log(`ABORT: spent $${spent.toFixed(4)} > $${maxUsd}`); process.exit(3); } } catch (e) { log(`[budget] check failed: ${e.message}`); } }, 20000);

const tr = await makeTracing(sec);
const t = { ...DEFAULT_TIMEOUTS, firstTokenMs: 900_000, idleMs: 900_000, stallMs: 600_000 };
const liveness = createLiveness({ stallMs: t.stallMs });
const events = [];
const onEvent = (e) => { const s = { type: e.type, attempt: e.attempt, at: new Date().toISOString(), ...(e.issues ? { issues: e.issues.map((i) => ({ severity: i.severity, code: i.code, path: i.path, message: i.message })) } : {}), ...(e.message ? { message: e.message } : {}) };
  events.push(s); log(`[sc] ${e.type}${e.attempt ? ` attempt ${e.attempt}` : ''}${e.issues ? ` codes ${[...new Set(e.issues.filter((i) => i.severity === 'error').map((i) => i.code))].join(',') || '(none)'}` : ''}${e.message ? ` ${e.message}` : ''}`); };
const invoke = deepAgentInvoke({ runId, runsRoot: RUNS_ROOT, createModel: (c, a) => openRouterModel(c, a, { apiKey: sec.OPENROUTER_API_KEY }) });
const node = makeAgentNode('seedance-compiler', invoke, { onEvent, runTag: runId, liveness, timeouts: { firstTokenMs: t.firstTokenMs, idleMs: t.idleMs } });
const hb = setInterval(() => { for (const e of liveness.active()) log(`[heartbeat] ${liveness.line(e)}`); }, 30000);
const t0 = Date.now();
let res;
try {
  res = await RunnableLambda.from(node).invoke(state, { runName: 'wiggly-v2 seedance-compiler resume', tags: [`runId:${runId}`, 'wiggly-v2', 'sc-only', 'placeholder-assets'],
    metadata: { runId, scOnly: true }, callbacks: [new LivenessHandler(liveness), ...(tr?.callbacks ?? [])], ...(tr ? { runId: tr.rootRunId } : {}) });
} finally { clearInterval(hb); clearInterval(guard); }
const wallSec = Math.round((Date.now() - t0) / 1000);
if (res.seedanceCompiler?.output) await writeFile(join(out, `seedance-compiler${suffix}.json`), JSON.stringify(res.seedanceCompiler.output, null, 2));
const b1 = await keyUsage();
await writeFile(join(out, `sc-state${suffix}.json`), JSON.stringify({ status: res.status ?? 'done', approvedAssets, attempts: res.attempts, retryCounts: res.retryCounts, gateIssues: res.gateIssues,
  validationErrors: res.validationErrors, escalations: res.escalations ?? [], wallSec, keySpentUsd: b1.usage - b0.usage, events }, null, 2));
log(`SC ${res.status ?? 'passed'}: attempts ${res.attempts?.['seedance-compiler']}, wall ${wallSec}s, key spend $${(b1.usage - b0.usage).toFixed(4)}, remaining $${b1.remaining?.toFixed(4)}`);
if (tr) { await tr.flush?.(); try { await new Promise((r) => setTimeout(r, 8000)); await auditRun({ runId: auditId, traceId: tr.rootRunId, secrets: sec, trackerPath: null, log }); } catch (e) { log(`audit skipped: ${e.message}`); } }
log('DONE');
process.exit(res.status === 'failed' ? 2 : 0);
