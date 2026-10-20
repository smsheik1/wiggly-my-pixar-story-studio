// Story first: beats (A) + critique/rewrite (B) plain-text calls before the shots call (C). Scripted model, zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { deepAgentInvoke, STORY } from '../graph/deep-agent-node.mjs';
import { storyBeatsEnabled, rewrittenBeats, loadBeatsPrompt, loadCritiquePrompt, parseThesis } from '../graph/story-beats.mjs';
import { V2_MODELS } from '../config/models.mjs';

class ScriptedModel extends BaseChatModel {
  constructor(script) { super({}); this.script = script; this.calls = []; }
  _llmType() { return 'scripted'; }
  bindTools() { return this; }
  async _generate(messages) { this.calls.push(messages); const step = this.script.shift(); assert.ok(step, 'unexpected call'); return { generations: [{ text: '', message: step(messages) }] }; }
}
const call = (name, args) => new AIMessage({ content: '', tool_calls: [{ name, args, id: 'c' + Math.random().toString(36).slice(2, 7), type: 'tool_call' }] });
const say = (t) => new AIMessage(t);
const text = (msgs) => msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
const play = () => JSON.parse(readFileSync(new URL('./fixtures/good-stage-play.json', import.meta.url), 'utf8'));
const INPUT = { subject: 'Test family', answers: { finale: 'I want her to know she can always call me.' } };

test('config and gating: on for the Story Director only, off in patch mode', () => {
  assert.equal(V2_MODELS['story-director'].storyBeats, true);
  assert.equal(storyBeatsEnabled('story-director', { storyBeats: true }), true);
  assert.equal(storyBeatsEnabled('story-director', { storyBeats: true }, { scope: 'part 2' }), false);
  assert.equal(storyBeatsEnabled('story-director', { storyBeats: true }, { task: 'patch' }), false);
  assert.equal(storyBeatsEnabled('character-architect', { storyBeats: true }), false);
  assert.equal(storyBeatsEnabled('story-director', {}), false);
  assert.equal(rewrittenBeats('1. ok\n## Rewritten beats\nThesis: X'), 'Thesis: X');
});

test('prompts are generic: no JSON gate codes, no toy example names', () => {
  for (const p of [loadBeatsPrompt(), loadCritiquePrompt()]) {
    assert.ok(p && p.length < 3000);
    assert.doesNotMatch(p, /\b(Theo|Gran|Wren|Ben|Miss Park)\b/);
    assert.doesNotMatch(p, /\b[A-Z]+_[A-Z_]+\b/, 'no gate codes');
  }
});

test('critique prompt: four scored story checks first, then the other checks, rebuild rule, no length growth', () => {
  const p = loadCritiquePrompt();
  const order = ['**Core:**', '**Specific:**', '**Turn:**', '**Feel:**', '**Strongest material:**', '**People on screen:**', '**Said out loud:**'].map((k) => p.indexOf(k));
  assert.ok(order.every((i) => i >= 0), 'all checks present');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'story scores listed first');
  assert.match(p, /1-5/); assert.match(p, /2 or lower/); assert.match(p, /from scratch/); assert.match(p, /must not grow/); assert.match(p, /## Rewritten beats/);
});

test('A -> B -> C order: beats see answers, critique sees beats, shots task carries the rewritten beats; artifacts saved', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'wiggly-beats-'));
  try {
    const seen = {};
    const m = new ScriptedModel([
      (msgs) => { seen.a = text(msgs); return say('Thesis: she can always call.\nBeat 1: first call.'); },
      (msgs) => { seen.b = text(msgs); return say('1. Build: fine.\n## Rewritten beats\nThesis: she can always call.\nBeat 1 (rewritten): the first call.'); },
      (msgs) => { seen.c = text(msgs); return call('submit_story_director', play()); },
    ]);
    const out = await deepAgentInvoke({ finalReview: false, createModel: async () => m, runsRoot: runs, runId: 'sf' })({ agent: 'story-director', config: { model: 'x', storyBeats: true, reflectionRounds: 0 }, input: INPUT, attempt: 1 });
    assert.equal(m.calls.length, 3);
    assert.match(seen.a, /Thesis first/); assert.match(seen.a, /always call me/);
    assert.match(seen.b, /Rewritten beats/); assert.match(seen.b, /Beat 1: first call/);
    assert.match(seen.c, /approved beats/); assert.match(seen.c, /Beat 1 \(rewritten\)/); assert.doesNotMatch(seen.c, /Beat 1: first call/);
    const dir = join(runs, 'sf_attempt-1', 'story-director', 'story');
    assert.match(await readFile(join(dir, 'beats.md'), 'utf8'), /first call/);
    assert.match(await readFile(join(dir, 'critique.md'), 'utf8'), /Build: fine/);
    assert.match(await readFile(join(dir, 'approved-beats.md'), 'utf8'), /rewritten/);
    assert.equal(out[STORY].files.length, 3);
  } finally { await rm(runs, { recursive: true, force: true }); }
});

test('off: exactly the old single shots call', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'wiggly-beats-'));
  try {
    const m = new ScriptedModel([() => call('submit_story_director', play())]);
    await deepAgentInvoke({ finalReview: false, createModel: async () => m, runsRoot: runs, runId: 'off' })({ agent: 'story-director', config: { model: 'x', reflectionRounds: 0 }, input: INPUT });
    assert.equal(m.calls.length, 1);
  } finally { await rm(runs, { recursive: true, force: true }); }
});

test('STRUCTURAL review sends the draft back to beats (A+B with the notes) and a fresh shots call; capped at 1 per attempt', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'wiggly-beats-'));
  try {
    const seen = {};
    const titled = (t) => { const d = play(); d.masthead.title = t; return d; };
    const STRUCT = 'S1 Core: 2 - no moment\nS2 Specific: 3 - x\nS3 Turn: 2 - x\nS4 Feel: 2 - x\nR1 Fidelity: PASS\nFIXES:\n1. story needs the first-call moment\nVERDICT: STRUCTURAL';
    const m = new ScriptedModel([
      () => say('Thesis: T.\nBeat 1: old.'), () => say('## Rewritten beats\nBeat 1: old approved.'),
      () => call('submit_story_director', titled('First')),
      () => say(STRUCT),
      (msgs) => { seen.a2 = text(msgs); return say('Thesis: T.\nBeat 1: new.'); },
      () => say('## Rewritten beats\nBeat 1: new approved.'),
      (msgs) => { seen.c2 = text(msgs); return call('submit_story_director', titled('Rebuilt')); },
      () => say(STRUCT), // round 2: cap reached, falls through to the normal line-fix path (no shot-scoped fixes: no rewrite)
    ]);
    const out = await deepAgentInvoke({ finalReview: false, createModel: async () => m, runsRoot: runs, runId: 'st' })({ agent: 'story-director', config: { model: 'x', storyBeats: true, reflectionRounds: 2 }, input: INPUT, attempt: 1, gate: () => ({ issues: [] }) });
    assert.match(seen.a2, /STRUCTURAL/); assert.match(seen.a2, /from scratch/);
    assert.match(seen.c2, /Beat 1: new approved/);
    const log = out[Symbol.for('wiggly.v2.reflection')].log;
    assert.equal(log[0].structural, true); assert.equal(log[0].changed, true); assert.ok(log[0].rebuildFiles.length >= 2);
    assert.deepEqual(log[0].storyScores, { core: 2, specific: 3, turn: 2, feel: 2 });
    assert.equal(log[1].structuralSkipped, 'cap reached');
    assert.equal(m.script.length, 0);
  } finally { await rm(runs, { recursive: true, force: true }); }
});

test('thesis: parsed from the Thesis: line; prompts carry one-sentence thesis, 3 card types and earned comedy', () => {
  assert.equal(parseThesis('**Thesis:** Love shows up, even quietly.\nBeat 1'), 'Love shows up, even quietly.');
  assert.equal(parseThesis('Thesis for X: A and B.'), 'A and B.'); assert.equal(parseThesis('no thesis'), null);
  for (const p of [loadBeatsPrompt(), loadCritiquePrompt()]) { assert.match(p, /young adult \(.*13-19.*18\)/); assert.match(p, /Thesis:/); }
  assert.match(loadBeatsPrompt(), /one thought are one idea/); assert.match(loadBeatsPrompt(), /at least one earned laugh/); assert.match(loadCritiquePrompt(), /earned laugh/);
});

test('approved thesis is pinned into finaleThesis, shown to the reviewer, and survives a rewrite that tries to change it', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'wiggly-beats-'));
  try {
    const seen = {};
    const draft = (t, th) => { const d = play(); d.masthead.title = t; d.finaleThesis = th; return d; };
    const m = new ScriptedModel([
      () => say('Thesis: Show up quietly, and think about the good in people.\nBeat 1: x'), () => say('fine\n## Rewritten beats\nThesis: Show up quietly, and think about the good in people.\nBeat 1: y'),
      (msgs) => { seen.c = text(msgs); return call('submit_story_director', draft('First', 'Something else')); },
      (msgs) => { seen.r = text(msgs); return say('S1 Core: 4 - x\nS2 Specific: 4 - x\nS3 Turn: 4 - x\nS4 Feel: 4 - x\nR6 Finale: FAIL\n- 5.1 "x" -> y\nFIXES:\n1. 1.1: tighten.\nVERDICT: REVISE'); },
      () => call('submit_story_director', draft('Second', 'Only the first idea')),
    ]);
    const out = await deepAgentInvoke({ finalReview: false, createModel: async () => m, runsRoot: runs, runId: 'th' })({ agent: 'story-director', config: { model: 'x', storyBeats: true, reflectionRounds: 1, coldRead: false }, input: INPUT, attempt: 1, gate: () => ({ issues: [] }) });
    const T = 'Show up quietly, and think about the good in people.';
    assert.match(seen.c, /finaleThesis is exactly/); assert.match(seen.r, /approved thesis/); assert.ok(seen.r.includes(T));
    assert.equal(out.finaleThesis, T);
  } finally { await rm(runs, { recursive: true, force: true }); }
});
