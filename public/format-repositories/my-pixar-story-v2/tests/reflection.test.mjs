// Story Director self-critique: after the first draft the same agent critiques its own draft (plain model call) and
// rewrites it (Deep Agent run that resubmits), config.reflectionRounds times. Scripted model only: zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { deepAgentInvoke, REFLECTION, reflectionRoundsFor, replyText } from '../graph/deep-agent-node.mjs';
import { buildGraph } from '../graph/graph.mjs';
import { V2_MODELS } from '../config/models.mjs';
import { parseStagePlay } from '../crew/story-director/schema.mjs';

class ScriptedModel extends BaseChatModel {
  constructor(script) { super({}); this.modelName = 'isolated-scripted-model'; this.script = script; this.calls = []; }
  getName() { return 'ChatOpenAI'; }
  _llmType() { return 'isolated-scripted-test'; }
  bindTools() { return this; }
  async _generate(messages) {
    this.calls.push(messages);
    const step = this.script.shift();
    assert.ok(step, 'model called after expected termination');
    return { generations: [{ text: '', message: step(messages) }] };
  }
}
const call = (name, args) => new AIMessage({ content: '', tool_calls: [{ name, args, id: name + Math.random().toString(36).slice(2, 7), type: 'tool_call' }] });
const say = (t) => new AIMessage(t);
const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const FIX = { 'story-director': 'good-stage-play.json', 'character-architect': 'good-master-renders.json', 'location-scout': 'good-location-plates.json', 'seedance-compiler': 'good-seedance-prompts.json' };
const SUBMIT = 'submit_story_director';
const titled = (t) => { const d = json(FIX['story-director']); d.masthead.title = t; return d; };
const text = (msgs) => msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
async function tmp(run) { const d = await mkdtemp(join(tmpdir(), 'wiggly-v2-reflect-')); try { await run(d); } finally { await rm(d, { recursive: true, force: true }); } }
const INPUT = { subject: 'Test family', answers: { finale: 'I want her to know she can always call me.' } };

test('config: Story Director runs 2 rounds by default, every other agent 0', () => {
  assert.equal(V2_MODELS['story-director'].reflectionRounds, 2);
  for (const a of ['character-architect', 'location-scout', 'seedance-compiler']) assert.equal(reflectionRoundsFor(V2_MODELS[a]), 0, a);
  assert.equal(reflectionRoundsFor({}), 0); assert.equal(reflectionRoundsFor({ reflectionRounds: -1 }), 0); assert.equal(reflectionRoundsFor({ reflectionRounds: 2 }, 0), 0);
  assert.equal(replyText(new AIMessage({ content: [{ type: 'reasoning', reasoning: 'x' }, { type: 'text', text: 'ok' }] })), 'ok');
});

test('2 rounds happen: critique sees rules + answers + draft, rewrite sees the critique, final output is the last revision, critiques saved', () => tmp(async (runs) => {
  const seen = {};
  const m = new ScriptedModel([
    () => call('read_file', { file_path: '/skills/story-director/SKILL.md' }),
    () => call(SUBMIT, titled('Draft zero')),
    (msgs) => { seen.c1 = text(msgs); return say('1. Part 2 shot 3: last line is off the idea. Fix: use the answer sentence whole.\nVERDICT: REVISE'); },
    (msgs) => { seen.r1 = text(msgs); return call(SUBMIT, titled('Revision one')); },
    (msgs) => { seen.c2 = text(msgs); return say('1. Minor: shot 2 action is vague.\nVERDICT: REVISE'); },
    (msgs) => { seen.r2 = text(msgs); return call(SUBMIT, titled('Revision two')); },
  ]);
  const gateCalls = [];
  const gate = (o) => { gateCalls.push(o.masthead.title); return { issues: o.masthead.title === 'Draft zero' ? [{ severity: 'error', code: 'FINALE_TOO_THIN', message: 'thin finale', path: 'segments.1' }] : [] }; };
  const out = await deepAgentInvoke({ finalReview: false, storyBeats: false, createModel: async () => m, runsRoot: runs, runId: 'two' })({ agent: 'story-director', config: { model: 'isolated-scripted-model', reflectionRounds: 2 }, input: INPUT, attempt: 1, gate });
  assert.equal(m.calls.length, 6, 'draft (2 turns) + 2 x (critique + rewrite)');
  assert.equal(out.masthead.title, 'Revision two');
  // Critique 1: its own rules, the family's answers, the draft, the finale thesis checks, and the gate findings.
  assert.match(seen.c1, /review round 1 of 2/); assert.match(seen.c1, /closing idea|ONE idea/); assert.match(seen.c1, /I want her to know she can always call me/);
  assert.match(seen.c1, /Draft zero/); assert.match(seen.c1, /finaleThesis/); assert.match(seen.c1, /editor, not the writer/); assert.match(seen.c1, /S1 Core[\s\S]*R1 Fidelity[\s\S]*R8 Length/); assert.match(seen.c1, /FINALE_TOO_THIN/);
  assert.match(seen.r1, /revision round 1 of 2/); assert.match(seen.r1, /last line is off the idea/); assert.match(seen.r1, /Draft zero/);
  assert.match(seen.c2, /Revision one/); assert.ok(!/Draft zero/.test(seen.c2), 'round 2 critiques the revised draft'); assert.match(seen.c2, /currently passes/);
  assert.match(seen.r2, /shot 2 action is vague/);
  assert.deepEqual(gateCalls, ['Draft zero', 'Revision one', 'Revision two']);
  // Saved for review: on the output (non-enumerable, never serialized) and on disk.
  const r = out[REFLECTION];
  assert.equal(r.rounds, 2); assert.equal(r.log.length, 2);
  assert.match(r.log[0].critique, /off the idea/); assert.match(r.log[1].critique, /vague/); assert.ok(r.log.every((e) => e.changed));
  assert.equal(r.log[0].gateErrorsBefore, 1); assert.equal(r.log[1].gateErrorsBefore, 0);
  assert.ok(!JSON.stringify(out).includes('VERDICT'), 'the reflection log never leaks into the output JSON');
  const dir = join(runs, 'two_attempt-1', 'story-director', 'reflection');
  for (const f of ['draft-0.json', 'round-1-critique.md', 'draft-1.json', 'round-2-critique.md', 'draft-2.json', 'reflection.json']) assert.ok((await stat(join(dir, f))).isFile(), f);
  assert.equal(JSON.parse(await readFile(join(dir, 'draft-0.json'), 'utf8')).masthead.title, 'Draft zero');
  assert.match(await readFile(join(dir, 'round-2-critique.md'), 'utf8'), /vague/);
  assert.equal(JSON.parse(await readFile(join(dir, 'reflection.json'), 'utf8')).log.length, 2);
  assert.equal(r.log[0].critiqueFile, join('two_attempt-1', 'story-director', 'reflection', 'round-1-critique.md'));
}));

test('rounds = 0 behaves exactly as before: one draft, no extra model calls, no files, nothing attached', () => tmp(async (runs) => {
  for (const config of [{ model: 'isolated-scripted-model', reflectionRounds: 0 }, { model: 'isolated-scripted-model' }]) {
    const m = new ScriptedModel([
      () => call('read_file', { file_path: '/skills/story-director/SKILL.md' }),
      () => call('read_file', { file_path: '/references/input.json' }),
      () => call(SUBMIT, json(FIX['story-director'])),
    ]);
    const id = `zero${config.reflectionRounds ?? 'u'}`;
    const out = await deepAgentInvoke({ finalReview: false, storyBeats: false, createModel: async () => m, runsRoot: runs, runId: id })({ agent: 'story-director', config, input: INPUT, attempt: 1, gate: () => assert.fail('gate is not called without reflection') });
    assert.equal(m.calls.length, 3);
    const { storyboardSheets: _sb, htmlScriptDocument: _html, ...want } = parseStagePlay(json(FIX['story-director'])); // the graph's parse adds these in code
    assert.deepEqual(out, want);
    assert.equal(out[REFLECTION], undefined);
    assert.ok(!existsSync(join(runs, `${id}_attempt-1`, 'story-director', 'reflection')));
  }
  // The invoke-level override turns it off for an agent whose config has rounds.
  const m = new ScriptedModel([() => call(SUBMIT, json(FIX['story-director']))]);
  const out = await deepAgentInvoke({ finalReview: false, storyBeats: false, createModel: async () => m, runsRoot: runs, runId: 'ovr', reflectionRounds: { 'story-director': 0 } })({ agent: 'story-director', config: V2_MODELS['story-director'], input: INPUT, attempt: 1 });
  assert.equal(m.calls.length, 1); assert.equal(out[REFLECTION], undefined);
}));

test('a rewrite that never resubmits keeps the previous valid draft and records why; the next round still runs', () => tmp(async (runs) => {
  const m = new ScriptedModel([
    () => call(SUBMIT, titled('Draft zero')),
    () => say('1. Fix the ending.\nVERDICT: REVISE'),
    () => say('I think it is fine.'), // rewrite run ends without calling submit
    (msgs) => { assert.match(text(msgs), /Draft zero/); return say('VERDICT: REVISE'); },
    () => call(SUBMIT, titled('Revision two')),
  ]);
  const out = await deepAgentInvoke({ finalReview: false, storyBeats: false, createModel: async () => m, runsRoot: runs, runId: 'keep' })({ agent: 'story-director', config: { model: 'x', reflectionRounds: 2 }, input: INPUT, attempt: 1 });
  assert.equal(out.masthead.title, 'Revision two');
  const [r1, r2] = out[REFLECTION].log;
  assert.equal(r1.changed, false); assert.match(r1.revisionError, /without calling submit/); assert.equal(r2.changed, true);
}));

// ---- Through the graph: the gate checks the FINAL revision; retries/escalation unchanged ----
// Inside a LangGraph node the deep agent takes one extra model turn after a valid submit (pre-existing, every agent),
// so the graph tests use a role-aware fake instead of a strict script: it answers by what it is asked.
const thin = (t) => { const d = titled(t); d.segments.at(-1).shots.forEach((h) => { delete h.narration; }); return d; };
const otherAgents = (agent) => new ScriptedModel([() => call(`submit_${agent.replaceAll('-', '_')}`, json(FIX[agent]))]);
const assets = () => json('good-approved-assets.json');
class RoleModel extends ScriptedModel {
  constructor({ draft, critiques, revisions, onCritique = () => {}, onDraft = () => {} }) {
    super([]); this.q = { draft: Array.isArray(draft) ? [...draft] : [draft, draft], critiques: [...critiques], revisions: [...revisions] }; this.onCritique = onCritique; this.onDraft = onDraft; this.kinds = [];
  }
  async _generate(messages) {
    this.calls.push(messages);
    const all = text(messages), last = messages.at(-1);
    let msg;
    if (/Cold Read/i.test(String(messages[0]?.content))) { this.kinds.push('cold-read'); msg = say('1. Setup & payoff: PASS\n2. Referents: PASS\n3. Time framing: PASS\n4. Finale clarity: PASS'); }
    else if (/reviewing your own draft/.test(String(messages[0]?.content))) { this.kinds.push('critique'); this.onCritique(all); msg = say(this.q.critiques.shift()); }
    else if ((last?.getType?.() ?? last?._getType?.()) === 'tool') { this.kinds.push('after-submit'); msg = say('Done.'); }
    else if (/Revise your story-director draft/.test(all)) { this.kinds.push('rewrite'); msg = call(SUBMIT, this.q.revisions.shift()); }
    else { this.kinds.push('draft'); this.onDraft(all); msg = call(SUBMIT, this.q.draft.shift()); }
    assert.ok(msg.tool_calls?.length ? msg.tool_calls[0].args : msg.content, `fake ran out of ${this.kinds.at(-1)} replies`);
    return { generations: [{ text: '', message: msg }] };
  }
}

test('graph: a gate-failing first draft fixed by the revisions passes on attempt 1; the gate saw only the final draft; critiques land in state', () => tmp(async (runs) => {
  const events = []; const critiqueTexts = []; let sd;
  const createModel = async (_c, agent) => (agent !== 'story-director' ? otherAgents(agent) : (sd = new RoleModel({
    draft: thin('Thin draft'), revisions: [thin('Still thin'), titled('Fixed')],
    critiques: ['1. Finale has no narration. VERDICT: REVISE', '1. Still no narration. VERDICT: REVISE'], onCritique: (t) => critiqueTexts.push(t) })));
  const s = await buildGraph({ deepAgent: { finalReview: false, storyBeats: false, createModel, runsRoot: runs, runId: 'g1' }, onEvent: (e) => events.push(e) }).invoke({ inputs: { answers: {} }, approvedAssets: assets() });
  assert.equal(s.status, 'done', JSON.stringify(s.escalations));
  assert.deepEqual(sd.kinds.filter((k) => k !== 'after-submit'), ['draft', 'draft', 'cold-read', 'critique', 'rewrite', 'cold-read', 'critique', 'rewrite']);
  assert.match(critiqueTexts[0], /FINALE_TOO_THIN/); assert.match(critiqueTexts[0], /Thin draft/); assert.match(critiqueTexts[1], /Still thin/);
  assert.equal(s.attempts['story-director'], 1); assert.equal(s.storyDirector.masthead.title, 'Fixed');
  assert.ok(!s.gateIssues['story-director'].some((i) => i.code === 'FINALE_TOO_THIN'));
  const res = events.filter((e) => e.agent === 'story-director' && e.type === 'attempt-result');
  assert.equal(res.length, 1); assert.equal(res[0].output.masthead.title, 'Fixed');
  const refl = s.reflections['story-director'];
  assert.equal(refl.length, 1); assert.equal(refl[0].attempt, 1); assert.deepEqual(refl[0].log.map((e) => e.critique), ['1. Finale has no narration. VERDICT: REVISE', '1. Still no narration. VERDICT: REVISE']);
  assert.ok(events.some((e) => e.type === 'reflection' && e.agent === 'story-director' && e.rounds === 2));
  assert.ok(!('reflections' in s.storyDirector), 'critiques never enter the Story Director output');
}));

test('graph: if the final revision fails the gate, the existing retry runs (with gate notes) and its own reflection rounds', () => tmp(async (runs) => {
  let sdModels = 0; const drafts = [];
  const createModel = async (_c, agent) => {
    if (agent !== 'story-director') return otherAgents(agent);
    sdModels++;
    return new RoleModel({ draft: thin('Draft'), revisions: [thin('Mid'), sdModels === 1 ? thin('Bad final') : titled('Good final')], critiques: ['critique a', 'critique b'], onDraft: (t) => drafts.push(t) });
  };
  const s = await buildGraph({ deepAgent: { finalReview: false, storyBeats: false, createModel, runsRoot: runs, runId: 'g2' } }).invoke({ inputs: { answers: {} }, approvedAssets: assets() });
  assert.equal(s.status, 'done'); assert.equal(s.attempts['story-director'], 2); assert.equal(s.storyDirector.masthead.title, 'Good final');
  assert.ok(s.validationErrors.find((v) => v.node === 'story-director').errors.some((i) => i.code === 'FINALE_TOO_THIN'));
  assert.ok(!/FINALE_TOO_THIN/.test(drafts[0])); assert.match(drafts[2], /FINALE_TOO_THIN/, 'attempt 2 gets the gate errors of the final revision as retry notes');
  assert.deepEqual(s.reflections['story-director'].map((r) => r.attempt), [1, 2]);
}));
