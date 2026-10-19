// Change 6: patch mode. Fix one thing (a line, a shot or a part) without redoing the story; prove nothing else changed;
// rerun downstream only for what the change touches; list what would need re-rendering. Fake models only: zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { parseTarget, checkPatchScope, describeScope, diffPaths } from '../crew/linter/patch-scope.mjs';
import { computeImpact, normalizePrior, rerenderList, patchReflectionRounds, characterArchitectPatchSpec, locationScoutPatchSpec, resyncLocationScenes } from '../graph/patch.mjs';
import { runPatch } from '../scripts/patch.mjs';
import { deepAgentInvoke, REFLECTION } from '../graph/deep-agent-node.mjs';
import { V2_MODELS } from '../config/models.mjs';
import { assembleCompiledPrompt, makeSeedancePatchSchema } from '../crew/seedance-compiler/schema.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const FIX = { 'story-director': 'good-stage-play.json', 'character-architect': 'good-master-renders.json', 'location-scout': 'good-location-plates.json', 'seedance-compiler': 'good-seedance-prompts.json' };
const sd = () => normalizePrior({ storyDirector: json(FIX['story-director']) }).storyDirector;
const codes = (issues) => issues.map((i) => i.code);
const OLD = '{I am a scientist.}', NEW = '{I told everyone I am a scientist.}'; // both verbatim from the test answers

async function tmp(run) { const d = await mkdtemp(join(tmpdir(), 'wiggly-v2-patch-')); try { await run(d); } finally { await rm(d, { recursive: true, force: true }); } }
/** A finished prior run on disk: runs/<id>/outputs/*.json + project.json. */
async function priorRun(root, id = 'prior') {
  const out = join(root, id, 'outputs'); await mkdir(out, { recursive: true });
  for (const [a, f] of Object.entries(FIX)) await writeFile(join(out, `${a}.json`), JSON.stringify(json(f), null, 2));
  await writeFile(join(out, 'state.json'), JSON.stringify({ status: 'done', approvedAssets: json('good-approved-assets.json') }));
  const ans = json('good-answers.json');
  await writeFile(join(root, id, 'project.json'), JSON.stringify({ inputs: { subject: ans.subject, answers: ans.answers } }));
  return id;
}
const hashDir = async (dir) => { const out = {}; const walk = async (d) => { for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) await walk(p); else out[p.slice(dir.length)] = createHash('sha256').update(await readFile(p)).digest('hex'); } }; await walk(dir); return out; };
/** Fake invoke: the SD fixes line 1.2 (optionally also touching something else); the SC recompiles only what it is given. */
function fakeInvoke({ sdTouch = () => {}, sdTouchOn = () => true } = {}) {
  const calls = [];
  const invoke = async (req) => {
    calls.push(req);
    const { agent, input, attempt } = req;
    if (agent === 'story-director') { const d = structuredClone(input.patch.currentOutput); d.segments[0].shots[1].dialogue.line = NEW; if (sdTouchOn(attempt)) sdTouch(d); return d; }
    if (agent === 'seedance-compiler') {
      const segs = structuredClone(input.patch.priorSegments).map((s) => { s.tenBlocks.block5_shots = s.tenBlocks.block5_shots.replace(OLD, NEW);
        s.shots = s.shots.map((x) => (x.dialogue?.line === OLD ? { ...x, dialogue: { ...x.dialogue, line: NEW } } : x)); s.compiledPrompt = assembleCompiledPrompt(s.tenBlocks); return s; });
      return { segments: segs, totalRuntimeSec: segs.reduce((n, s) => n + s.totalDurationSec, 0) };
    }
    throw new Error(`${agent} must not run for this patch`);
  };
  return { invoke, calls };
}

// ---- targets
test('target ids: part, shot, line (kind optional when the shot has one line); clear errors', () => {
  const d = sd();
  assert.deepEqual(parseTarget('part:2', d), { kind: 'part', id: 'part:2', segmentId: 2, si: 1, isFinal: true });
  assert.equal(parseTarget('2.3', d).id, 'shot:2.3');
  assert.equal(parseTarget('line:1.2', d).id, 'line:1.2.dialogue');
  assert.equal(parseTarget('line:2.1.narration', d).id, 'line:2.1.narration');
  assert.throws(() => parseTarget('part:9', d), /no part 9/);
  assert.throws(() => parseTarget('shot:1.9', d), /no shot 9/);
  assert.throws(() => parseTarget('line:1.1', d), /no spoken line/);
  assert.throws(() => parseTarget('line:1.2.narration', d), /no narration line/);
  assert.throws(() => parseTarget('the second shot', d), /not a target id/);
  assert.match(describeScope(parseTarget('line:1.2', d)), /Everything else is locked/);
});

// ---- deterministic scope proof
test('scope: identical passes; the target may change; anything else is PATCH_OUTSIDE_TARGET', () => {
  const d = sd(), t = parseTarget('line:1.2', d);
  assert.deepEqual(checkPatchScope(d, structuredClone(d), t), []);
  const ok = structuredClone(d); ok.segments[0].shots[1].dialogue.line = NEW; ok.htmlScriptDocument += ' '; ok.masthead.draftNumber = 2;
  assert.deepEqual(checkPatchScope(d, ok, t), []);
  const bad = structuredClone(ok); bad.segments[0].shots[2].whatWeSee = '@Sister blinks.'; bad.segments[1].title = 'Part 2: Changed';
  const r = checkPatchScope(d, bad, t);
  assert.deepEqual(codes(r), ['PATCH_OUTSIDE_TARGET', 'PATCH_OUTSIDE_TARGET']);
  assert.match(r[0].message, /segments\[0\]\.shots\[2\]\.whatWeSee changed .* outside the target line:1\.2\.dialogue/);
  const vis = structuredClone(d); vis.segments[0].shots[1].whatWeSee = '@Shaz stands.'; // a line target cannot touch the shot's action
  assert.deepEqual(codes(checkPatchScope(d, vis, t)), ['PATCH_OUTSIDE_TARGET']);
  assert.deepEqual(checkPatchScope(d, vis, parseTarget('shot:1.2', d)), []);
});
test('scope: a timing ripple inside the part is allowed only as a uniform shift with matching totals', () => {
  const d = sd(), t = parseTarget('line:2.2', d);
  const r = structuredClone(d); const s = r.segments[1].shots;
  s[1].endSec += 2; s[2].startSec += 2; s[2].endSec += 2; r.segments[1].targetDurationSec += 2; r.shapeBar.parts[1].durationSec += 2; r.shapeBar.totalRuntimeSec += 2;
  assert.deepEqual(checkPatchScope(d, r, t), []);
  const stretch = structuredClone(r); stretch.segments[1].shots[2].endSec += 1; // a later shot changed length
  assert.deepEqual(codes(checkPatchScope(d, stretch, t)), ['PATCH_TIMING_RIPPLE']);
  const tot = structuredClone(r); tot.shapeBar.totalRuntimeSec += 5;
  assert.deepEqual(codes(checkPatchScope(d, tot, t)), ['PATCH_TIMING_RIPPLE']);
  const early = structuredClone(d); early.segments[1].shots[0].endSec -= 1; early.segments[1].shots[1].startSec -= 1; // before the target: locked
  assert.ok(codes(checkPatchScope(d, early, t)).includes('PATCH_OUTSIDE_TARGET'));
  const other = structuredClone(r); other.segments[0].shots[5].endSec += 1; // another part: locked
  assert.ok(codes(checkPatchScope(d, other, t)).includes('PATCH_OUTSIDE_TARGET'));
});
test('scope: shot and part targets; cast/locations append-only; finaleThesis only with the final part', () => {
  const d = sd();
  const fewer = structuredClone(d); fewer.segments[0].shots.pop();
  assert.match(checkPatchScope(d, fewer, parseTarget('shot:1.2', d))[0].message, /number of shots .* Target part:1/);
  assert.ok(!codes(checkPatchScope(d, fewer, parseTarget('part:1', d))).length, 'a part target may change the shot list');
  assert.ok(codes(checkPatchScope(d, fewer, parseTarget('part:2', d))).includes('PATCH_OUTSIDE_TARGET'));
  const card = { ...structuredClone(d.cast[0]), name: 'Wren', elementTag: '@Wren', realPerson: 'Wren' };
  const add = structuredClone(d); add.cast.push(card);
  assert.deepEqual(checkPatchScope(d, add, parseTarget('shot:1.2', d)), []);
  assert.deepEqual(codes(checkPatchScope(d, add, parseTarget('line:1.2', d))), ['PATCH_OUTSIDE_TARGET']);
  const ins = structuredClone(d); ins.cast.unshift(card);
  assert.deepEqual(codes(checkPatchScope(d, ins, parseTarget('shot:1.2', d))), ['PATCH_LOCKED_APPEND']);
  const edit = structuredClone(d); edit.cast[1].age += 1;
  assert.deepEqual(codes(checkPatchScope(d, edit, parseTarget('part:1', d))), ['PATCH_OUTSIDE_TARGET']);
  const fin = structuredClone(d); fin.finaleThesis = 'A different single idea for the finale.';
  assert.deepEqual(checkPatchScope(d, fin, parseTarget('part:2', d)), []);
  assert.deepEqual(codes(checkPatchScope(d, fin, parseTarget('part:1', d))), ['PATCH_OUTSIDE_TARGET']);
  const panel = structuredClone(d); panel.storyboardSheets[0].panels[1].whatIsInFrame = '@Shaz, close, chin down, warm medium brown skin.';
  assert.deepEqual(checkPatchScope(d, panel, parseTarget('shot:1.2', d)), []);
  assert.deepEqual(codes(checkPatchScope(d, panel, parseTarget('shot:1.3', d))), ['PATCH_OUTSIDE_TARGET']);
});

// ---- downstream impact
test('impact: only parts whose compiler input changed; line sources alone do not count; new cast and places are found', () => {
  const d = sd();
  const line = structuredClone(d); line.segments[0].shots[1].dialogue.line = NEW;
  assert.deepEqual(computeImpact(d, line), { sdChangedPaths: ['segments[0].shots[1].dialogue.line'], changedShots: ['1.2'], newCast: [], newLocations: [], scParts: [1] });
  const src = structuredClone(d); src.segments[0].shots[1].dialogue.source = { answer: 'scene1Childhood.memory', kind: 'paraphrase' };
  assert.deepEqual(computeImpact(d, src).scParts, [], 'the compiler never sees line sources');
  const rip = structuredClone(d); const s = rip.segments[1].shots; s[1].endSec += 1; s[2].startSec += 1; s[2].endSec += 1;
  assert.deepEqual(computeImpact(d, rip).scParts, [2]);
  const grow = structuredClone(d); grow.cast.push({ ...d.cast[0], name: 'Wren', elementTag: '@Wren' }); grow.locations.push({ name: 'Garden', description: 'A small back garden with a wooden fence, afternoon.' });
  const im = computeImpact(d, grow);
  assert.deepEqual([im.newCast, im.newLocations, im.scParts], [['@Wren'], ['Garden'], []], 'a new card that no shot uses touches no part');
});
test('re-render list: changed parts with their changed prompt shots; the next part is a continuity follow-up', () => {
  const prior = normalizePrior({ seedanceCompiler: json(FIX['seedance-compiler']) }).seedanceCompiler;
  const next = structuredClone(prior); const s = next.segments[0];
  s.tenBlocks.block5_shots = s.tenBlocks.block5_shots.replace(OLD, NEW); s.compiledPrompt = assembleCompiledPrompt(s.tenBlocks);
  const r = rerenderList(prior, next, ['1.2']);
  assert.deepEqual(r.parts.map((p) => [p.segmentId, p.changedPromptShots, p.changedBlocks, p.stageShots]), [[1, [2], ['block5_shots'], ['1.2']]]);
  assert.deepEqual(r.continuityFollowUps.map((f) => f.segmentId), [2]);
  assert.deepEqual(rerenderList(prior, structuredClone(prior)), { parts: [], continuityFollowUps: [] });
});
test('compiler patch schema: each part keeps its place in the film; only the affected parts', () => {
  const sc = normalizePrior({ seedanceCompiler: json(FIX['seedance-compiler']) }).seedanceCompiler;
  const two = { segments: [sc.segments[1]], totalRuntimeSec: sc.segments[1].totalDurationSec };
  assert.ok(makeSeedancePatchSchema({ 1: 1, 2: 2 }, [2]).safeParse(two).success);
  const msgs = (r) => r.error.issues.map((i) => i.message).join(' | ');
  assert.match(msgs(makeSeedancePatchSchema({ 1: 1, 2: 2 }, [1]).safeParse(two)), /not affected by the patch.*\| part 1 is affected/);
  assert.match(msgs(makeSeedancePatchSchema({ 1: 1, 2: 3 }).safeParse(two)), /segmentIndex must be 3/);
});

test('new cast / new place: the Character Architect and Location Scout see only what is new; prior entries are kept and tags stay put', () => {
  const d = sd(), prior = normalizePrior({ characterArchitect: json(FIX['character-architect']), locationScout: json(FIX['location-scout']) });
  // a new cast member: only that card goes to the Character Architect; the merge keeps @Image 1-3 and adds @Image 4
  const withCard = structuredClone(d); withCard.cast.push({ ...structuredClone(d.cast[1]), name: 'Wren', elementTag: '@Wren', realPerson: 'Wren', photoRef: null });
  const ca = characterArchitectPatchSpec({ priorCa: prior.characterArchitect });
  const st = { storyDirector: withCard, characterArchitect: { output: prior.characterArchitect }, patch: { impact: { newCast: ['@Wren'] } } };
  assert.deepEqual(ca.select(st).cast.map((c) => c.elementTag), ['@Wren']);
  const wren = { ...structuredClone(prior.characterArchitect.characters[1]), characterId: 'wren', name: 'Wren', elementTag: '@Wren', imageTag: '@Image 1' };
  const merged = ca.merge(null, { ...prior.characterArchitect, characters: [wren] }, st);
  assert.deepEqual(merged.characters.slice(0, 3), prior.characterArchitect.characters, 'existing characters byte-identical');
  assert.equal(merged.characters[3].imageTag, '@Image 4');
  // a new place: part 2 moves to a garden; only that setting goes to the Location Scout; the kitchen plate keeps @Loc 1
  const moved = structuredClone(d); moved.locations.push({ name: 'Garden', description: 'A small back garden with a wooden fence, afternoon light.' });
  for (const sh of moved.segments[1].shots) sh.location = 'Garden';
  const ls0 = { storyDirector: moved, locationScout: { output: prior.locationScout } };
  const resynced = resyncLocationScenes(prior.locationScout, ls0);
  assert.deepEqual(resynced.locations[0].sceneIds, ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6'], 'kitchen scene ids re-synced in code');
  const ls = locationScoutPatchSpec(), st2 = { ...ls0, locationScout: { output: resynced }, patch: { impact: { newLocations: ['Garden'] } } };
  const sel = ls.select(st2);
  assert.deepEqual([sel.settings.map((x) => x.name), sel.scenes.map((x) => x.sceneId)], [['Garden'], ['2.1', '2.2', '2.3']]);
  const garden = { ...structuredClone(prior.locationScout.locations[0]), settingName: 'Garden', locationId: 'garden', elementTag: '@Loc 1', sceneIds: ['2.1', '2.2', '2.3'] };
  const m2 = ls.merge(null, { locations: [garden], assumptions: [] }, st2);
  assert.deepEqual(m2.locations.map((l) => [l.elementTag, l.settingName]), [['@Loc 1', 'Kitchen'], ['@Loc 2', 'Garden']]);
  assert.deepEqual(m2.locations[0], resynced.locations[0]);
});

// ---- the whole patch run (fake models)
test('patch run: a new run with only the target changed; only the affected part recompiled; the old run is untouched', () => tmp(async (root) => {
  const from = await priorRun(root);
  const before = await hashDir(join(root, from));
  const { invoke, calls } = fakeInvoke();
  const r = await runPatch({ from, target: 'line:1.2', note: 'He said he told everyone, not just that he is one.', runsRoot: root, invoke, log: () => {} });
  assert.equal(r.state.status, 'done'); assert.equal(r.runId, 'prior-patch-1');
  assert.deepEqual(await hashDir(join(root, from)), before, 'the prior run is byte-identical');
  // who ran, with what
  assert.deepEqual(calls.map((c) => c.agent), ['story-director', 'seedance-compiler'], 'no Character Architect or Location Scout');
  const sdReq = calls[0];
  assert.equal(sdReq.input.patch.target, 'line:1.2.dialogue'); assert.match(sdReq.input.patch.note, /told everyone/);
  assert.deepEqual(sdReq.input.patch.currentOutput, sd()); assert.ok(sdReq.input.answers.scene1Childhood, 'the family answers are in the input');
  assert.match(sdReq.task, /PATCH MODE[\s\S]*line:1\.2\.dialogue[\s\S]*Copy every other field exactly/); assert.equal(sdReq.rounds, 1);
  assert.deepEqual(calls[1].input.segments.map((s) => s.segmentId), [1], 'the compiler sees only the affected part');
  // outputs: patched where needed, the rest are the prior run's bytes
  const out = (f) => readFile(join(r.dir, 'outputs', f), 'utf8'), priorOut = (f) => readFile(join(root, from, 'outputs', f), 'utf8');
  for (const f of ['character-architect.json', 'location-scout.json']) assert.equal(await out(f), await priorOut(f), f);
  const nsd = JSON.parse(await out('story-director.json')), psd = sd();
  assert.equal(nsd.segments[0].shots[1].dialogue.line, NEW);
  assert.deepEqual(diffPaths(psd, nsd).map((c) => c.path.join('.')), ['segments.0.shots.1.dialogue.line'], 'unchanged parts stay identical');
  const nsc = JSON.parse(await out('seedance-compiler.json')), psc = normalizePrior({ seedanceCompiler: JSON.parse(await priorOut('seedance-compiler.json')) }).seedanceCompiler;
  assert.deepEqual(nsc.segments[1], psc.segments[1], 'part 2 prompt reused unchanged');
  assert.equal(nsc.totalRuntimeSec, psc.totalRuntimeSec);
  // report
  const p = JSON.parse(await readFile(join(r.dir, 'patch.json'), 'utf8'));
  assert.deepEqual([p.from, p.target, p.status, p.reran, p.outputsChanged], [from, 'line:1.2.dialogue', 'done', ['story-director', 'seedance-compiler'], ['story-director', 'seedance-compiler']]);
  assert.deepEqual(p.rerender.parts.map((x) => [x.segmentId, x.changedPromptShots]), [[1, [2]]]);
  assert.deepEqual(p.rerender.continuityFollowUps.map((x) => x.segmentId), [2]);
  // a second patch never overwrites the first
  const again = await runPatch({ from, target: 'line:1.2', note: 'again', runsRoot: root, invoke: fakeInvoke().invoke, log: () => {} });
  assert.equal(again.runId, 'prior-patch-2');
  await assert.rejects(runPatch({ from, target: 'line:1.2', note: 'x', runId: 'prior-patch-1', runsRoot: root, invoke, log: () => {} }), /already exists/);
}));
test('patch run: a draft that touches outside the target is rejected and retried with the reason; the next one passes', () => tmp(async (root) => {
  const from = await priorRun(root);
  const { invoke, calls } = fakeInvoke({ sdTouch: (d) => { d.segments[0].shots[2].whatWeSee = '@Sister blinks twice, unimpressed.'; }, sdTouchOn: (a) => a === 1 });
  const r = await runPatch({ from, target: 'line:1.2', note: 'He said he told everyone.', runsRoot: root, invoke, log: () => {} });
  assert.equal(r.state.status, 'done');
  const sdCalls = calls.filter((c) => c.agent === 'story-director');
  assert.equal(sdCalls.length, 2); assert.equal(r.state.retryCounts['story-director'], 1);
  assert.match(sdCalls[1].retryNotes, /PATCH_OUTSIDE_TARGET \(segments\[0\]\.shots\[2\]\.whatWeSee\)/);
  assert.equal(JSON.parse(await readFile(join(r.dir, 'outputs/story-director.json'), 'utf8')).segments[0].shots[2].whatWeSee, sd().segments[0].shots[2].whatWeSee);
}));
test('patch run: always touching outside the target escalates after the normal retries; nothing downstream runs; old run untouched', () => tmp(async (root) => {
  const from = await priorRun(root);
  const before = await hashDir(join(root, from));
  const { invoke, calls } = fakeInvoke({ sdTouch: (d) => { d.segments[1].title = 'Part 2: Something Else'; } });
  const r = await runPatch({ from, target: 'line:1.2', note: 'He said he told everyone.', runsRoot: root, invoke, log: () => {} });
  assert.equal(r.state.status, 'failed');
  assert.deepEqual(calls.map((c) => c.agent), ['story-director', 'story-director', 'story-director']);
  assert.equal(r.state.escalations[0].agent, 'story-director');
  assert.ok(r.state.escalations[0].issues.some((i) => i.code === 'PATCH_OUTSIDE_TARGET'));
  assert.deepEqual(r.patch.rerender.parts, []);
  assert.deepEqual(r.patch.outputsChanged, [], 'the new run keeps the prior outputs');
  assert.deepEqual(await hashDir(join(root, from)), before);
}));
test('patch run: prior runs that predate the current contract are refused before any model call', () => tmp(async (root) => {
  const from = await priorRun(root);
  const old = json(FIX['story-director']); delete old.finaleThesis; for (const s of old.segments) delete s.scenes;
  await writeFile(join(root, from, 'outputs/story-director.json'), JSON.stringify(old));
  const { invoke, calls } = fakeInvoke();
  await assert.rejects(runPatch({ from, target: 'line:1.2', note: 'x', runsRoot: root, invoke, log: () => {} }), /PATCH_PRIOR_INVALID/);
  assert.equal(calls.length, 0); assert.ok(!existsSync(join(root, 'prior-patch-1')));
  const ok = await priorRun(root, 'p2');
  const c = await runPatch({ from: ok, target: 'shot:1.2', runsRoot: root, check: true, log: () => {} });
  assert.equal(c.target.id, 'shot:1.2'); assert.ok(!existsSync(join(root, 'p2-patch-1')), '--check writes nothing');
}));

// ---- the deep agent in patch mode: the task message, one scoped self-review round
class ScriptedModel extends BaseChatModel {
  constructor(script) { super({}); this.modelName = 'isolated-scripted-model'; this.script = script; this.calls = []; }
  getName() { return 'ChatOpenAI'; }
  _llmType() { return 'isolated-scripted-test'; }
  bindTools() { return this; }
  async _generate(messages) { this.calls.push(messages); const step = this.script.shift(); assert.ok(step, 'model called after expected termination'); return { generations: [{ text: '', message: step(messages) }] }; }
}
const call = (name, args) => new AIMessage({ content: '', tool_calls: [{ name, args, id: name + Math.random().toString(36).slice(2, 7), type: 'tool_call' }] });
const text = (msgs) => msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
test('deep agent patch mode: the patch task opens the run; ONE review round scoped to the target (config default)', () => tmp(async (runs) => {
  assert.equal(V2_MODELS['story-director'].patchReflectionRounds, 1); assert.equal(patchReflectionRounds(), 1); assert.equal(patchReflectionRounds(0), 0);
  const prior = sd(), fixed = structuredClone(prior); fixed.segments[0].shots[1].dialogue.line = NEW;
  const t = parseTarget('line:1.2', prior), seen = {};
  const m = new ScriptedModel([
    (msgs) => { seen.first = text(msgs); return call('submit_story_director', fixed); },
    (msgs) => { seen.critique = text(msgs); return new AIMessage('FIXES:\n1. line 1.2: use the answer sentence whole.\nVERDICT: REVISE'); },
    (msgs) => { seen.rewrite = text(msgs); return call('submit_story_director', fixed); },
  ]);
  const { patchTask, patchScopeText } = await import('../graph/patch.mjs');
  const input = { subject: 'Test family', answers: json('good-answers.json').answers, patch: { target: t.id, note: 'He told everyone.', currentOutput: prior } };
  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'pm' })({ agent: 'story-director', config: V2_MODELS['story-director'], input, attempt: 1,
    task: patchTask(t, 'He told everyone.'), scope: patchScopeText(t, 'He told everyone.'), rounds: 1, gate: () => ({ issues: [] }) });
  assert.equal(m.calls.length, 3, 'draft + 1 x (critique + rewrite), not the 2 full-run rounds');
  assert.match(seen.first, /PATCH MODE[\s\S]*line:1\.2\.dialogue/);
  assert.match(seen.critique, /PATCH MODE: this review is scoped to the target line:1\.2\.dialogue/);
  assert.match(seen.critique, /the output before this patch; outside the target the draft must equal it exactly/, 'the prior output is not sent twice');
  assert.match(seen.rewrite, /PATCH MODE: this review is scoped/);
  assert.equal(out.segments[0].shots[1].dialogue.line, NEW); assert.equal(out[REFLECTION].rounds, 1);
}));
