#!/usr/bin/env node
// Storyboard Artist only, from finished SD / CA / LS outputs. Prompts only: no image or video calls.
// Usage: node scripts/run-sb-only.mjs --sd <story-director.json> --ca <character-architect.json> --ls <location-scout.json>
//          --run-id <id> [--max-usd 0.3] [--export <dir>] [--secrets <file>]
// --export writes sheet-<sheetId>.txt per sheet + manifest.json (references per sheet, panel -> shot map) for Google Flow.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RunnableLambda } from '@langchain/core/runnables';
import { makeAgentNode } from '../graph/graph.mjs';
import { RUNS_ROOT, openRouterModel, deepAgentInvoke } from '../graph/deep-agent-node.mjs';
import { createLiveness, LivenessHandler, DEFAULT_TIMEOUTS } from '../graph/liveness.mjs';
import { loadSecrets, defaultSecretsPath } from './lib/secrets.mjs';
import { shotTimeline } from './lib/animatic.mjs';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const log = (...a) => console.log(new Date().toISOString(), ...a);
const runId = arg('--run-id'), maxUsd = +(arg('--max-usd') ?? 0.3);
if (!runId || !arg('--sd') || !arg('--ca') || !arg('--ls')) throw new Error('--sd, --ca, --ls and --run-id are required');
const sec = loadSecrets(arg('--secrets') ?? defaultSecretsPath());
if (!sec.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing');
const keyUsage = async () => { const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${sec.OPENROUTER_API_KEY}` } }); const d = (await r.json()).data ?? {}; return { usage: d.usage }; };
const load = async (k) => JSON.parse(await readFile(arg(k), 'utf8'));
const unwrap = (o, key) => (o?.[key] ? o : o?.output?.[key] ? o.output : o);
const sd = unwrap(await load('--sd'), 'segments'), ca = unwrap(await load('--ca'), 'characters'), ls = unwrap(await load('--ls'), 'locations');
const state = { storyDirector: sd, characterArchitect: { output: ca }, locationScout: { output: ls } };
const out = join(RUNS_ROOT, runId, 'outputs'); await mkdir(out, { recursive: true });
const b0 = await keyUsage(); log(`[budget] cap $${maxUsd}`);
const guard = setInterval(async () => { try { const b = await keyUsage(); const spent = b.usage - b0.usage; if (spent > maxUsd) { log(`ABORT: spent $${spent.toFixed(4)} > $${maxUsd}`); process.exit(3); } } catch {} }, 15000);
const t = { ...DEFAULT_TIMEOUTS, firstTokenMs: 900_000, idleMs: 900_000, stallMs: 600_000 };
const liveness = createLiveness({ stallMs: t.stallMs }); const events = [];
const onEvent = (e) => { events.push({ type: e.type, attempt: e.attempt, at: new Date().toISOString(), ...(e.issues ? { issues: e.issues.map((i) => ({ severity: i.severity, code: i.code, path: i.path, message: i.message })) } : {}) }); log(`[sb] ${e.type}${e.attempt ? ` attempt ${e.attempt}` : ''}${e.issues ? ` ${e.issues.filter((i) => i.severity === 'error').length} errors` : ''}`); };
const invoke = deepAgentInvoke({ runId, runsRoot: RUNS_ROOT, reflectionRounds: 0, createModel: (c, a) => openRouterModel(c, a, { apiKey: sec.OPENROUTER_API_KEY }) });
const node = makeAgentNode('storyboard-artist', invoke, { onEvent, runTag: runId, liveness, timeouts: { firstTokenMs: t.firstTokenMs, idleMs: t.idleMs } });
const hb = setInterval(() => { for (const e of liveness.active()) log(`[heartbeat] ${liveness.line(e)}`); }, 30000);
const t0 = Date.now(); let res;
try { res = await RunnableLambda.from(node).invoke(state, { runName: 'wiggly-v2 storyboard-artist only', tags: [`runId:${runId}`, 'sb-only'], callbacks: [new LivenessHandler(liveness)] }); }
finally { clearInterval(hb); clearInterval(guard); }
const wallSec = Math.round((Date.now() - t0) / 1000);
const b1 = await keyUsage();
if (res.storyboardArtist) await writeFile(join(out, 'storyboard-artist.json'), JSON.stringify(res.storyboardArtist, null, 2));
await writeFile(join(out, 'sb-state.json'), JSON.stringify({ status: res.status ?? 'done', attempts: res.attempts, gateIssues: res.gateIssues, validationErrors: res.validationErrors, wallSec, keySpentUsd: b1.usage - b0.usage, events }, null, 2));
const exp = arg('--export');
if (exp && res.storyboardArtist?.sheets) {
  await mkdir(exp, { recursive: true });
  const timing = Object.fromEntries(shotTimeline(sd).map((s) => [s.shotId, s]));
  for (const s of res.storyboardArtist.sheets) await writeFile(join(exp, `sheet-${s.sheetId}.txt`), s.fullPrompt + '\n');
  await writeFile(join(exp, 'manifest.json'), JSON.stringify({ runId, engine: 'nano-banana-2.1', aspect: '16:9',
    note: 'Attach references in the listed order (position = "reference image N" in the prompt). Save each result as sheet-<sheetId>.png, then run scripts/slice-storyboard.mjs.',
    sheets: res.storyboardArtist.sheets.map((s) => ({ sheetId: s.sheetId, segmentId: s.segmentId, panelCount: s.panels.length, layout: s.layout, promptFile: `sheet-${s.sheetId}.txt`, promptChars: s.fullPrompt.length, references: s.references,
      panels: s.panels.map((p) => ({ ...p, durationSec: timing[p.shotId]?.durationSec })) })) }, null, 2));
  log(`exported ${res.storyboardArtist.sheets.length} sheets -> ${exp}`);
}
log(`SB ${res.status ?? 'passed'}: attempts ${res.attempts?.['storyboard-artist']}, wall ${wallSec}s, spend $${(b1.usage - b0.usage).toFixed(4)}`);
log('DONE'); process.exit(res.status === 'failed' ? 2 : 0);
