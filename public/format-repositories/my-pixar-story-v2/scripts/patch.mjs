#!/usr/bin/env node
// Patch mode: fix one thing (a line, a shot or a part) of a finished run without redoing the story.
// Reads runs/<from>/outputs/*, writes a NEW run runs/<run-id>/ (the prior run is never written to): a copy of the prior
// outputs, the patched outputs on top, and patch.json (target, note, what changed, what ran again, what to re-render).
// Only the LangGraph patch graph (graph/patch.mjs) calls models; nothing is rendered. See docs/specs/patch-mode.md.
// Usage: node scripts/patch.mjs --from <runId> --target <part:N | shot:N.M | line:N.M[.dialogue|.narration]> --note "<what is wrong>"
//   [--run-id <new id>] (default <from>-patch-1, -2, ...)  [--project <project.json>] (default runs/<from>/project.json)
//   [--placeholder-assets] approve new character/location references with fake keys (no images)
//   [--reflection-rounds N] (default: config patchReflectionRounds, 1)  [--check] validate target + prior run only, no model calls
//   [--secrets <secrets.env>] [--no-tracing]
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPatchGraph, patchReflectionRounds, normalizePrior } from '../graph/patch.mjs';
import { placeholderAssets } from '../graph/graph.mjs';
import { RUNS_ROOT, openRouterModel } from '../graph/deep-agent-node.mjs';
import { createLiveness, LivenessHandler, DEFAULT_TIMEOUTS } from '../graph/liveness.mjs';
import { parseTarget, describeScope } from '../crew/linter/patch-scope.mjs';
import { selectStoryDirectorInput } from '../crew/story-director/input.mjs';
import { validateStoryDirectorOutput } from '../crew/linter/check-stage-play.mjs';
import { inputsFromProject, loadPhotoReferences, defaultPhotoRefsPath } from './run-rehearsal.mjs';
import { loadSecrets, defaultSecretsPath } from './lib/secrets.mjs';
import { makeTracing } from './lib/tracing.mjs';

const OUT = { 'story-director': 'storyDirector', 'character-architect': 'characterArchitect', 'location-scout': 'locationScout', 'seedance-compiler': 'seedanceCompiler' };
const readJson = async (f) => JSON.parse(await readFile(f, 'utf8'));
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/** Load a prior run's outputs and inputs; throws with a plain reason if it cannot be patched. */
export async function loadPriorRun({ from, runsRoot = RUNS_ROOT, projectPath }) {
  if (!from || !SAFE_ID.test(from)) throw new Error('--from <prior run id> is required (letters, digits, . _ -)');
  const dir = join(runsRoot, from), out = join(dir, 'outputs');
  if (!existsSync(join(out, 'story-director.json'))) throw new Error(`run ${from} has no outputs/story-director.json`);
  const opt = async (f) => (existsSync(join(out, f)) ? readJson(join(out, f)) : undefined);
  const prior = { storyDirector: await readJson(join(out, 'story-director.json')), characterArchitect: await opt('character-architect.json'),
    locationScout: await opt('location-scout.json'), seedanceCompiler: await opt('seedance-compiler.json') };
  const state = (await opt('state.json')) ?? {};
  // A run resumed with run-sc-only.mjs keeps its approvals in sc-state.json (state.json still says awaiting-approval).
  if (!state.approvedAssets) { const sc = await opt('sc-state.json'); if (sc?.approvedAssets) state.approvedAssets = sc.approvedAssets; }
  const project = projectPath ?? join(dir, 'project.json');
  if (!existsSync(project)) throw new Error(`no project file: pass --project (looked for ${project})`);
  const inputs = inputsFromProject(await readJson(project));
  const refs = await loadPhotoReferences(defaultPhotoRefsPath(project)); if (refs.length) inputs.photoReferences = refs;
  // The prior outputs must match today's contracts, and the stage play must pass today's gate, or nothing outside the
  // target could be kept as it is.
  Object.assign(prior, normalizePrior(prior));
  const g = validateStoryDirectorOutput(prior.storyDirector, selectStoryDirectorInput({ inputs }));
  if (!g.isValid) throw Object.assign(new Error(`PATCH_PRIOR_INVALID: run ${from}'s stage play fails the current gate (${[...new Set(g.issues.filter((i) => i.severity === 'error').map((i) => i.code))].join(', ')}), so it cannot be patched (do a full run).`), { code: 'PATCH_PRIOR_INVALID', issues: g.issues });
  return { dir, outDir: out, prior, state, inputs, project };
}

const nextRunId = (runsRoot, from) => { for (let n = 1; ; n++) { const id = `${from}-patch-${n}`; if (!existsSync(join(runsRoot, id))) return id; } };

export async function runPatch({ from, target, note, runId, runsRoot = RUNS_ROOT, projectPath, invoke, secrets, secretsPath = defaultSecretsPath(),
  usePlaceholderAssets = false, reflectionRounds, check = false, tracing, log = console.log, timeouts = {} } = {}) {
  const run = await loadPriorRun({ from, runsRoot, projectPath });
  const t = parseTarget(target, run.prior.storyDirector);
  log(`patch ${from} at ${t.id}: ${describeScope(t)}`);
  if (check) return { check: true, target: t };
  if (!note || !String(note).trim()) throw new Error('--note "<what is wrong>" is required');
  const id = runId ?? nextRunId(runsRoot, from);
  if (!SAFE_ID.test(id) || id === from) throw new Error(`bad --run-id ${id}`);
  const newDir = join(runsRoot, id), outDir = join(newDir, 'outputs');
  if (existsSync(newDir)) throw new Error(`run ${id} already exists; pick another --run-id`);
  await mkdir(outDir, { recursive: true });
  // the new run starts as a copy of the prior outputs (the prior run is only read)
  for (const f of await readdir(run.outDir)) if (f.endsWith('.json')) await copyFile(join(run.outDir, f), join(outDir, f));
  for (const f of ['project.json', 'project-photo-refs.json']) if (existsSync(join(run.dir, f)) && !projectPath) await copyFile(join(run.dir, f), join(newDir, f));
  if (projectPath) await copyFile(projectPath, join(newDir, 'project.json'));

  let sec = secrets, tr = tracing ?? null;
  if (!invoke) { sec = sec ?? loadSecrets(secretsPath); if (!sec.OPENROUTER_API_KEY) throw new Error(`OPENROUTER_API_KEY not found in ${secretsPath}`); if (tracing === undefined) tr = await makeTracing(sec); }
  const tm = { ...DEFAULT_TIMEOUTS, firstTokenMs: 900_000, idleMs: 900_000, stallMs: 600_000, ...timeouts };
  const liveness = invoke ? undefined : createLiveness({ stallMs: tm.stallMs });
  const events = [];
  const graph = buildPatchGraph({ prior: run.prior, target: t, note, reflectionRounds, runTag: id,
    ...(invoke ? { invoke } : { deepAgent: { runId: id, runsRoot, createModel: (c, a) => openRouterModel(c, a, { apiKey: sec.OPENROUTER_API_KEY }) }, liveness, timeouts: { firstTokenMs: tm.firstTokenMs, idleMs: tm.idleMs } }),
    onEvent: (e) => { if (['attempt-result', 'passed', 'failed'].includes(e.type)) { events.push({ agent: e.agent, type: e.type, attempt: e.attempt, codes: [...new Set((e.issues ?? []).filter((i) => i.severity === 'error').map((i) => i.code))] }); log(`[${e.agent}] ${e.type}${e.attempt ? ` attempt ${e.attempt}` : ''}`); } },
    ...(usePlaceholderAssets ? { autoApprove: placeholderAssets } : {}) });
  const init = { inputs: run.inputs, storyDirector: run.prior.storyDirector, characterArchitect: { output: run.prior.characterArchitect },
    locationScout: { output: run.prior.locationScout }, seedanceCompiler: { output: run.prior.seedanceCompiler }, approvedAssets: run.state.approvedAssets ?? undefined };
  const state = await graph.invoke(init, { runName: 'wiggly-v2 patch', tags: [`runId:${id}`, 'wiggly-v2', 'patch', `from:${from}`], metadata: { runId: id, patchOf: from, target: t.id },
    recursionLimit: 50, callbacks: [...(liveness ? [new LivenessHandler(liveness)] : []), ...(tr?.callbacks ?? [])], ...(tr ? { runId: tr.rootRunId } : {}) });
  if (tr) await tr.flush?.();
  const reran = Object.keys(state.attempts ?? {});
  const written = [];
  for (const [agent, key] of Object.entries(OUT)) { // overwrite only outputs the patch changed; the rest stay the prior run's bytes
    const o = key === 'storyDirector' ? state.storyDirector : state[key]?.output;
    if (o && JSON.stringify(o) !== JSON.stringify(run.prior[key])) { await writeFile(join(outDir, `${agent}.json`), JSON.stringify(o, null, 2)); written.push(agent); }
  }
  const patch = { from, runId: id, target: t.id, note, status: state.status, scope: describeScope(t), reflectionRounds: patchReflectionRounds(reflectionRounds),
    reran, outputsChanged: written, attempts: state.attempts, retryCounts: state.retryCounts, impact: state.patch?.impact ?? null, rerender: state.patch?.rerender ?? null,
    escalations: state.escalations ?? [], pendingApproval: state.pendingApproval ?? [], placeholderAssets: usePlaceholderAssets, events };
  await writeFile(join(newDir, 'patch.json'), JSON.stringify(patch, null, 2));
  await writeFile(join(outDir, 'state.json'), JSON.stringify({ status: state.status, patchOf: from, placeholderAssets: usePlaceholderAssets || !!run.state.placeholderAssets, approvedAssets: state.approvedAssets,
    pendingApproval: state.pendingApproval, retryCounts: state.retryCounts, escalations: state.escalations, validationErrors: state.validationErrors }, null, 2));
  if (Object.keys(state.reflections ?? {}).length) await writeFile(join(outDir, 'reflections.json'), JSON.stringify(state.reflections, null, 2));
  log(`patch run ${id}: status ${state.status}; ran again: ${reran.join(', ') || 'nothing'}`);
  for (const p of patch.rerender?.parts ?? []) log(`  re-render part ${p.segmentId} (prompt shots ${p.changedPromptShots.join(', ') || '-'})`);
  for (const e of patch.escalations) log(`ESCALATED ${e.agent}: ${e.reason}`);
  log(`patch report: ${join(newDir, 'patch.json')}`);
  return { state, patch, runId: id, dir: newDir };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const has = (k) => process.argv.includes(k);
  runPatch({ from: arg('--from'), target: arg('--target'), note: arg('--note'), runId: arg('--run-id'), projectPath: arg('--project'),
    usePlaceholderAssets: has('--placeholder-assets'), check: has('--check'), ...(arg('--secrets') ? { secretsPath: arg('--secrets') } : {}),
    ...(arg('--reflection-rounds') !== undefined ? { reflectionRounds: +arg('--reflection-rounds') } : {}), ...(has('--no-tracing') ? { tracing: null } : {}) })
    .then((r) => { process.exitCode = r.check ? 0 : r.state.status === 'failed' ? 2 : 0; })
    .catch((e) => { console.error(`patch failed: ${e.message}`); process.exitCode = 1; });
}
