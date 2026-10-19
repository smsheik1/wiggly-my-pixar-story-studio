// Cold read for Story Director self-review: an extra short model call per review round BEFORE critique
// that receives only the script (draft JSON) as a first-time viewer. Zero network calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { deepAgentInvoke, REFLECTION } from '../graph/deep-agent-node.mjs';
import { coldReadMessages, coldReadEnabled } from '../graph/cold-read.mjs';
import { loadColdRead, V2_MODELS } from '../config/models.mjs';
import { RunStoppedError } from '../graph/provider-errors.mjs';

class ScriptedModel extends BaseChatModel {
  constructor(script) {
    super({});
    this.modelName = 'isolated-cold-read-model';
    this.script = script;
    this.calls = [];
  }
  getName() { return 'ChatOpenAI'; }
  _llmType() { return 'isolated-cold-read-test'; }
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
const SUBMIT = 'submit_story_director';
const titled = (t) => { const d = json('good-stage-play.json'); d.masthead.title = t; return d; };
const text = (msgs) => msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
async function tmp(run) {
  const d = await mkdtemp(join(tmpdir(), 'wiggly-v2-cold-read-'));
  try { await run(d); } finally { await rm(d, { recursive: true, force: true }); }
}

const DISTINCT_ANSWER = 'Distinctive questionnaire memory about finding an old map in the attic with Gran.';
const INPUT = {
  subject: 'Test family',
  targetTotalRuntimeSec: 90,
  answers: {
    childhood: DISTINCT_ANSWER,
    finale: 'I want her to know she can always call me.',
  },
};

const COLD_FAIL_NOTES = `1. Setup & payoff: FAIL
- 1.2 "@Theo finds the map" - no earlier mention that Gran had a map.
2. Referents: PASS
3. Time framing: PASS
4. Finale clarity: FAIL
- 2.4 "@Theo waves goodbye" - lacks closing gesture.`;

const SHIP_CRITIQUE = `R1 Fidelity: PASS
R2 Invented details: PASS
R3 Setup and payoff: PASS
R4 Cast in the scene: PASS
R5 Referents: PASS
R6 Finale: PASS
R7 Time framing: PASS
R8 Length: PASS
R9 Gate rules: PASS

FIXES:
(none)

Works: everything is clean.
VERDICT: SHIP`;

const REVISE_CRITIQUE = `R1 Fidelity: PASS
R2 Invented details: PASS
R3 Setup and payoff: FAIL
- 1.2 "finds the map" -> missing setup
R4 Cast in the scene: PASS
R5 Referents: PASS
R6 Finale: PASS
R7 Time framing: PASS
R8 Length: PASS
R9 Gate rules: PASS

FIXES:
1. 1.1: add setup for the map.

Works: the dialogue.
VERDICT: REVISE`;

test('COLD-READ.md is under 150 words, generic, and loaded for story-director only', { timeout: 10000 }, () => {
  const prompt = loadColdRead('story-director');
  assert.ok(prompt, 'loadColdRead should return prompt for story-director');
  const words = prompt.trim().split(/\s+/).length;
  assert.ok(words < 150, `COLD-READ.md must be under 150 words; got ${words}`);
  assert.match(prompt, /Setup & payoff/i);
  assert.match(prompt, /Referents/i);
  assert.match(prompt, /Time framing/i);
  assert.match(prompt, /Finale clarity/i);
  assert.match(prompt, /PASS.*FAIL/i);
  // Other agents get null
  for (const a of ['character-architect', 'location-scout', 'seedance-compiler']) {
    assert.equal(loadColdRead(a), null, `${a} must not have cold-read prompt`);
  }
});

test('coldReadMessages contains the script but NONE of the questionnaire answers or input fields', { timeout: 10000 }, () => {
  const draft = titled('Draft for cold read');
  const msgs = coldReadMessages(draft);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
  const all = text(msgs);
  assert.match(all, /Draft for cold read/);
  assert.match(all, /The script to read/);
  // Verify that questionnaire answers and input fields are absent
  assert.ok(!all.includes(DISTINCT_ANSWER), 'distinctive questionnaire answer must NOT be in cold-read messages');
  assert.ok(!all.includes('targetTotalRuntimeSec'), 'input fields must NOT be in cold-read messages');
  assert.ok(!all.includes('answers'), 'answers field must NOT be in cold-read messages');
  assert.ok(!all.includes('/references/input.json'), 'input.json reference must NOT be in cold-read messages');
});

test('call order is cold-read then critique per round; critique prompt contains "Cold viewer notes" + the notes', { timeout: 10000 }, () => tmp(async (runs) => {
  const seen = {};
  const m = new ScriptedModel([
    () => call('read_file', { file_path: '/skills/story-director/SKILL.md' }),
    () => call(SUBMIT, titled('Draft zero')),
    // Round 1: cold-read
    (msgs) => { seen.cold1 = text(msgs); return say(COLD_FAIL_NOTES); },
    // Round 1: critique (receives cold notes)
    (msgs) => { seen.critique1 = text(msgs); return say(REVISE_CRITIQUE); },
    // Round 1: rewrite
    (msgs) => { seen.rewrite1 = text(msgs); return call(SUBMIT, titled('Revision one')); },
    // Round 2: cold-read
    (msgs) => { seen.cold2 = text(msgs); return say('1. Setup & payoff: PASS\n2. Referents: PASS\n3. Time framing: PASS\n4. Finale clarity: PASS'); },
    // Round 2: critique
    (msgs) => { seen.critique2 = text(msgs); return say(SHIP_CRITIQUE); },
  ]);

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'cr-order' })({
    agent: 'story-director',
    config: V2_MODELS['story-director'],
    input: INPUT,
    attempt: 1,
    gate: () => ({ issues: [] }),
  });

  assert.equal(m.calls.length, 7, 'draft (2 turns) + r1 (cold-read + critique + rewrite) + r2 (cold-read + critique [SHIP early stop])');
  // Cold-read 1 contains draft zero and no questionnaire answers
  assert.match(seen.cold1, /Draft zero/);
  assert.ok(!seen.cold1.includes(DISTINCT_ANSWER));

  // Critique 1 prompt contains "Cold viewer notes" and the cold notes
  assert.match(seen.critique1, /Cold viewer notes/);
  assert.match(seen.critique1, /no earlier mention/);
  assert.match(seen.critique1, /A first-time viewer read the script without the answers/i);

  // Files written to disk
  const dir = join(runs, 'cr-order_attempt-1', 'story-director', 'reflection');
  assert.ok(existsSync(join(dir, 'round-1-cold-read.md')), 'round-1-cold-read.md must exist');
  assert.ok(existsSync(join(dir, 'round-1-critique.md')), 'round-1-critique.md must exist');
  assert.ok(existsSync(join(dir, 'round-2-cold-read.md')), 'round-2-cold-read.md must exist');
  assert.ok(existsSync(join(dir, 'round-2-critique.md')), 'round-2-critique.md must exist');

  const savedCold1 = await readFile(join(dir, 'round-1-cold-read.md'), 'utf8');
  assert.match(savedCold1, /Setup & payoff: FAIL/);

  // Reflection entry logs cold notes and file
  const r = out[REFLECTION];
  assert.equal(r.log.length, 2);
  assert.equal(r.log[0].coldRead, COLD_FAIL_NOTES);
  assert.equal(r.log[0].coldReadFile, join('cr-order_attempt-1', 'story-director', 'reflection', 'round-1-cold-read.md'));
  assert.match(r.log[1].coldRead, /Setup & payoff: PASS/);
}));

test('SHIP early stop still skips the rewrite even if cold notes list FAILs', { timeout: 10000 }, () => tmp(async (runs) => {
  const seen = {};
  const m = new ScriptedModel([
    () => call(SUBMIT, titled('Draft zero')),
    // Round 1: cold-read returns FAIL notes
    (msgs) => { seen.cold1 = text(msgs); return say(COLD_FAIL_NOTES); },
    // Round 1: critique ignores cold notes and says SHIP
    (msgs) => { seen.critique1 = text(msgs); return say(SHIP_CRITIQUE); },
  ]);

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'cr-early-stop' })({
    agent: 'story-director',
    config: V2_MODELS['story-director'],
    input: INPUT,
    attempt: 1,
    gate: () => ({ issues: [] }),
  });

  // Only 3 calls: draft, cold-read, critique (SHIP stops early)
  assert.equal(m.calls.length, 3, 'draft + cold-read + critique (rewrite skipped on SHIP)');
  assert.equal(out.masthead.title, 'Draft zero');
  assert.match(seen.critique1, /Cold viewer notes/);
  const r = out[REFLECTION];
  assert.equal(r.stoppedEarly, true);
  assert.equal(r.roundsRun, 1);
  assert.equal(r.log[0].verdict, 'SHIP');
  assert.equal(r.log[0].stoppedEarly, true);
  assert.equal(r.log[0].changed, false);
  assert.ok(r.log[0].coldRead.includes('Setup & payoff: FAIL'));
}));

test('disabled via config -> no extra call', { timeout: 10000 }, () => tmp(async (runs) => {
  const seen = {};
  const m = new ScriptedModel([
    () => call(SUBMIT, titled('Draft zero')),
    // Critique directly, no cold-read call
    (msgs) => { seen.critique1 = text(msgs); return say(SHIP_CRITIQUE); },
  ]);

  const disabledConfig = { ...V2_MODELS['story-director'], coldRead: false };
  assert.equal(coldReadEnabled('story-director', disabledConfig), false);

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'cr-disabled' })({
    agent: 'story-director',
    config: disabledConfig,
    input: INPUT,
    attempt: 1,
    gate: () => ({ issues: [] }),
  });

  // Exactly 2 calls: draft + critique (no cold read)
  assert.equal(m.calls.length, 2);
  assert.ok(!seen.critique1.includes('Cold viewer notes'), 'critique must not contain cold notes when disabled');
  const dir = join(runs, 'cr-disabled_attempt-1', 'story-director', 'reflection');
  assert.ok(!existsSync(join(dir, 'round-1-cold-read.md')), 'round-1-cold-read.md must NOT exist');
  assert.equal(out[REFLECTION].log[0].coldRead, undefined);
}));

test('other agents get no cold read', { timeout: 10000 }, () => {
  for (const a of ['character-architect', 'location-scout', 'seedance-compiler', 'vera', 'linter']) {
    assert.equal(coldReadEnabled(a), false, `${a} must not have cold read enabled by default`);
    assert.equal(coldReadEnabled(a, V2_MODELS[a]), false, `${a} with V2_MODELS must not have cold read enabled`);
    assert.equal(loadColdRead(a), null, `${a} must have null cold-read prompt`);
  }
  assert.equal(coldReadEnabled('story-director'), true, 'story-director must have cold read enabled by default');
});

test('non-fatal error in cold-read is skipped and continues; fatal provider error rethrows', { timeout: 10000 }, () => tmp(async (runs) => {
  // 1. Non-fatal error: skipped
  const m1 = new ScriptedModel([
    () => call(SUBMIT, titled('Draft zero')),
    () => { throw new Error('Temporary 503 from model provider'); }, // cold-read throws non-fatal
    () => say(SHIP_CRITIQUE), // critique continues normally
  ]);
  const out = await deepAgentInvoke({ createModel: async () => m1, runsRoot: runs, runId: 'cr-err-skip' })({
    agent: 'story-director',
    config: V2_MODELS['story-director'],
    input: INPUT,
    attempt: 1,
    gate: () => ({ issues: [] }),
  });
  assert.equal(m1.calls.length, 3);
  assert.equal(out[REFLECTION].log[0].coldRead, undefined);

  // 2. Fatal provider error: rethrows
  const m2 = new ScriptedModel([
    () => call(SUBMIT, titled('Draft zero')),
    () => { throw new RunStoppedError('Provider credit exhausted'); }, // fatal provider error
  ]);
  await assert.rejects(
    deepAgentInvoke({ createModel: async () => m2, runsRoot: runs, runId: 'cr-err-fatal' })({
      agent: 'story-director',
      config: V2_MODELS['story-director'],
      input: INPUT,
      attempt: 1,
      gate: () => ({ issues: [] }),
    }),
    /Provider credit exhausted/
  );
}));
