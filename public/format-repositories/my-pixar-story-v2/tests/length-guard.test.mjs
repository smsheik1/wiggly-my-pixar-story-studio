import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { deepAgentInvoke, REFLECTION } from '../graph/deep-agent-node.mjs';
import { cutQuotaNote, judgeRewrite, countShots, resolveTargetSeconds, runtimeOf } from '../graph/length-guard.mjs';

class ScriptedModel extends BaseChatModel {
  constructor(script) {
    super({});
    this.modelName = 'isolated-scripted-model';
    this.script = script;
    this.calls = [];
  }
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
const SUBMIT = 'submit_story_director';
const text = (msgs) => msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
async function tmp(run) {
  const d = await mkdtemp(join(tmpdir(), 'wiggly-v2-len-'));
  try { await run(d); } finally { await rm(d, { recursive: true, force: true }); }
}

const titled = (title, runtime = 46) => {
  const d = json('good-stage-play.json');
  d.masthead.title = title;
  d.shapeBar.totalRuntimeSec = runtime;
  return d;
};

// ---- Pure Helper Unit Tests ----

test('resolveTargetSeconds: priority input.targetTotalRuntimeSec > format.targetTotalSeconds > default 90', { timeout: 10000 }, () => {
  assert.equal(resolveTargetSeconds({ targetTotalRuntimeSec: 60 }), 60);
  assert.equal(resolveTargetSeconds({ format: { targetTotalSeconds: 75 } }), 75);
  assert.equal(resolveTargetSeconds({ targetTotalRuntimeSec: 80, format: { targetTotalSeconds: 100 } }), 80);
  assert.equal(resolveTargetSeconds({}), 90);
  assert.equal(resolveTargetSeconds(null), 90);
});

test('countShots: counts shots across segments or parts, handles empty drafts', { timeout: 10000 }, () => {
  assert.equal(countShots({ segments: [{ shots: [{}, {}] }, { shots: [{}] }] }), 3);
  assert.equal(countShots({ parts: [{ shots: [{}] }, { shots: [{}] }] }), 2);
  assert.equal(countShots({ shots: [{}, {}, {}] }), 3);
  assert.equal(countShots({}), 0);
  assert.equal(countShots(null), 0);
});

test('cutQuotaNote: computes excess and shot cut quota correctly when over target', { timeout: 10000 }, () => {
  // Runtime 137s, target 90s: excess = 47s. 26 shots -> avg = 137 / 26 = 5.269s -> ceil(47 / 5.269) = 9 shots.
  const shots = Array.from({ length: 26 }, (_, i) => ({ shotNumber: i + 1, startSec: i * 5, endSec: (i + 1) * 5 }));
  const draft = { shapeBar: { totalRuntimeSec: 137 }, segments: [{ shots }] };
  const note = cutQuotaNote({ targetTotalRuntimeSec: 90 }, draft);
  assert.match(note, /Runtime: this draft 137s; target 90s: cut at least 47s \(about 9 shots\)\. Any added shot must be paid for by a cut\./);

  // Divide-by-zero protection: 0 shots in draft
  const emptyShotsDraft = { shapeBar: { totalRuntimeSec: 100 }, segments: [] };
  const safeNote = cutQuotaNote({ targetTotalRuntimeSec: 90 }, emptyShotsDraft);
  assert.match(safeNote, /Runtime: this draft 100s; target 90s: cut at least 10s\. Any added shot must be paid for by a cut\./);
});

test('cutQuotaNote: under-target and at-target wording', { timeout: 10000 }, () => {
  const underDraft = { shapeBar: { totalRuntimeSec: 80 }, segments: [{ shots: [{}] }] };
  const underNote = cutQuotaNote({ targetTotalRuntimeSec: 90 }, underDraft);
  assert.match(underNote, /Runtime: this draft 80s; target 90s: under target\. The revision must not be longer\./);

  const atDraft = { shapeBar: { totalRuntimeSec: 90 }, segments: [{ shots: [{}] }] };
  const atNote = cutQuotaNote({ targetTotalRuntimeSec: 90 }, atDraft);
  assert.match(atNote, /Runtime: this draft 90s; target 90s: at target\. The revision must not be longer\./);

  // Missing runtime returns empty
  assert.equal(cutQuotaNote({ targetTotalRuntimeSec: 90 }, {}), '');
});

test('judgeRewrite: growth allowed at/under target, rejected past it', { timeout: 10000 }, () => {
  const input = { targetTotalRuntimeSec: 90 };
  const d = (rt) => ({ shapeBar: { totalRuntimeSec: rt } });

  // Over target: any growth is rejected (no +2s tolerance)
  const overGrow = judgeRewrite({ input, before: d(95), after: d(96) });
  assert.equal(overGrow.accepted, false);
  assert.equal(overGrow.reason, 'grew');
  assert.equal(overGrow.bySec, 1);

  const overGrow2 = judgeRewrite({ input, before: d(95), after: d(97) });
  assert.equal(overGrow2.accepted, false);
  assert.equal(overGrow2.reason, 'grew');
  assert.equal(overGrow2.bySec, 2);

  // Growth is fine while the film stays at or under target (a swap for a stronger moment); past target it is rejected
  assert.equal(judgeRewrite({ input, before: d(80), after: d(83) }).accepted, true);
  assert.equal(judgeRewrite({ input, before: d(80), after: d(90) }).accepted, true);
  const past = judgeRewrite({ input, before: d(80), after: d(91) });
  assert.equal(past.accepted, false); assert.equal(past.reason, 'grew'); assert.equal(past.bySec, 11);
  const atPlus2 = judgeRewrite({ input, before: d(90), after: d(92) });
  assert.equal(atPlus2.accepted, false); assert.equal(atPlus2.bySec, 2);

  // Equal or shorter runtime: accepted
  assert.equal(judgeRewrite({ input, before: d(90), after: d(90) }).accepted, true);
  assert.equal(judgeRewrite({ input, before: d(100), after: d(95) }).accepted, true);

  // Missing runtime on either side: does not reject on length
  assert.equal(judgeRewrite({ input, before: {}, after: d(95) }).accepted, true);
  assert.equal(judgeRewrite({ input, before: d(95), after: {} }).accepted, true);
});

test('judgeRewrite: gate errors increase rejected, equal or fewer accepted', { timeout: 10000 }, () => {
  const input = { targetTotalRuntimeSec: 90 };
  const d = (rt) => ({ shapeBar: { totalRuntimeSec: rt } });

  // Gate errors increase: rejected
  const gateUp = judgeRewrite({
    input,
    before: d(85),
    after: d(85),
    gateBefore: [{ severity: 'error', code: 'E1' }],
    gateAfter: [{ severity: 'error', code: 'E1' }, { severity: 'error', code: 'E2' }],
  });
  assert.equal(gateUp.accepted, false);
  assert.equal(gateUp.reason, 'gate');
  assert.equal(gateUp.errorsBefore, 1);
  assert.equal(gateUp.errorsAfter, 2);

  // Gate errors equal: accepted
  const gateSame = judgeRewrite({
    input,
    before: d(85),
    after: d(85),
    gateBefore: [{ severity: 'error', code: 'E1' }],
    gateAfter: [{ severity: 'error', code: 'E1' }],
  });
  assert.equal(gateSame.accepted, true);

  // Gate errors decreased: accepted
  const gateDown = judgeRewrite({
    input,
    before: d(85),
    after: d(85),
    gateBefore: [{ severity: 'error', code: 'E1' }, { severity: 'error', code: 'E2' }],
    gateAfter: [{ severity: 'error', code: 'E1' }],
  });
  assert.equal(gateDown.accepted, true);

  // Gate warnings only: not treated as errors
  const gateWarn = judgeRewrite({
    input,
    before: d(85),
    after: d(85),
    gateBefore: [],
    gateAfter: [{ severity: 'warning', code: 'W1' }],
  });
  assert.equal(gateWarn.accepted, true);
});

// ---- Loop-Level Tests with Mocked Model / runOnce ----

test('loop: quota line present with correct numbers when over target', { timeout: 10000 }, () => tmp(async (runs) => {
  let critiquePrompt = '';
  // Draft zero has runtime 100s, target 90s -> excess 10s.
  // good-stage-play.json has 10 shots. avg = 100 / 10 = 10s. N = ceil(10 / 10) = 1 shot.
  const m = new ScriptedModel([
    () => call(SUBMIT, titled('Draft zero', 100)),
    (msgs) => {
      critiquePrompt = text(msgs);
      return say('1. Trim the middle.\nVERDICT: REVISE');
    },
    () => call(SUBMIT, titled('Revision one', 90)),
  ]);

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'quota' })({
    agent: 'story-director',
    config: { model: 'isolated-scripted-model', reflectionRounds: 1 },
    input: { targetTotalRuntimeSec: 90 },
    attempt: 1,
  });

  assert.match(critiquePrompt, /Runtime: this draft 100s; target 90s: cut at least 10s \(about 1 shot\)\. Any added shot must be paid for by a cut\./);
  assert.equal(out.shapeBar.totalRuntimeSec, 90);
}));

test('loop: under-target wording injected when draft is at or under target', { timeout: 10000 }, () => tmp(async (runs) => {
  let critiquePrompt = '';
  const m = new ScriptedModel([
    () => call(SUBMIT, titled('Draft zero', 80)),
    (msgs) => {
      critiquePrompt = text(msgs);
      return say('1. Improve gesture in shot 2.\nVERDICT: REVISE');
    },
    () => call(SUBMIT, titled('Revision one', 80)),
  ]);

  await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'under' })({
    agent: 'story-director',
    config: { model: 'isolated-scripted-model', reflectionRounds: 1 },
    input: { targetTotalRuntimeSec: 90 },
    attempt: 1,
  });

  assert.match(critiquePrompt, /under target/);
  assert.match(critiquePrompt, /revision must not be longer/);
}));

test('loop: growth rejected and previous draft kept, subsequent round continues with kept draft', { timeout: 10000 }, () => tmp(async (runs) => {
  const roundCritiques = [];
  const m = new ScriptedModel([
    () => call(SUBMIT, titled('Draft zero', 100)),
    (msgs) => { roundCritiques.push(text(msgs)); return say('1. Cut length.\nVERDICT: REVISE'); },
    () => call(SUBMIT, titled('Revision one grew', 105)), // Round 1 grew 5s -> rejected!
    (msgs) => { roundCritiques.push(text(msgs)); return say('1. Cut length again.\nVERDICT: REVISE'); },
    () => call(SUBMIT, titled('Revision two clean', 90)), // Round 2 accepted
  ]);

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'reject-grow' })({
    agent: 'story-director',
    config: { model: 'isolated-scripted-model', reflectionRounds: 2 },
    input: { targetTotalRuntimeSec: 90 },
    attempt: 1,
  });

  const r = out[REFLECTION];
  assert.equal(r.roundsRun, 2);
  // Round 1 was rejected for growing 5s
  assert.equal(r.log[0].changed, false);
  assert.deepEqual(r.log[0].rejected, { reason: 'grew', bySec: 5 });
  // Round 2 critique saw the kept Draft zero (100s)
  assert.match(roundCritiques[1], /Draft zero/);
  assert.match(roundCritiques[1], /this draft 100s/);
  // Round 2 was accepted
  assert.equal(r.log[1].changed, true);
  assert.equal(out.masthead.title, 'Revision two clean');
  assert.equal(out.shapeBar.totalRuntimeSec, 90);
}));

test('loop: +2s tolerance allowed under target, but +1s rejected over target', { timeout: 10000 }, () => tmp(async (runs) => {
  // Test A: Under target +2s growth is accepted
  const mUnder = new ScriptedModel([
    () => call(SUBMIT, titled('Draft zero', 80)),
    () => say('1. Fix dialogue.\nVERDICT: REVISE'),
    () => call(SUBMIT, titled('Revision one', 82)), // +2s under target (90) -> allowed
  ]);
  const outUnder = await deepAgentInvoke({ createModel: async () => mUnder, runsRoot: runs, runId: 'tol-ok' })({
    agent: 'story-director',
    config: { model: 'isolated-scripted-model', reflectionRounds: 1 },
    input: { targetTotalRuntimeSec: 90 },
    attempt: 1,
  });
  assert.equal(outUnder[REFLECTION].log[0].changed, true);
  assert.equal(outUnder[REFLECTION].log[0].rejected, undefined);
  assert.equal(outUnder.shapeBar.totalRuntimeSec, 82);

  // Test B: Over target +1s growth is rejected
  const mOver = new ScriptedModel([
    () => call(SUBMIT, titled('Draft zero', 95)),
    () => say('1. Fix dialogue.\nVERDICT: REVISE'),
    () => call(SUBMIT, titled('Revision one', 96)), // +1s over target (90) -> rejected
  ]);
  const outOver = await deepAgentInvoke({ createModel: async () => mOver, runsRoot: runs, runId: 'tol-bad' })({
    agent: 'story-director',
    config: { model: 'isolated-scripted-model', reflectionRounds: 1 },
    input: { targetTotalRuntimeSec: 90 },
    attempt: 1,
  });
  assert.equal(outOver[REFLECTION].log[0].changed, false);
  assert.deepEqual(outOver[REFLECTION].log[0].rejected, { reason: 'grew', bySec: 1 });
  assert.equal(outOver.masthead.title, 'Draft zero');
  assert.equal(outOver.shapeBar.totalRuntimeSec, 95);
}));

test('loop: gate-error increase rejected and previous draft kept', { timeout: 10000 }, () => tmp(async (runs) => {
  const m = new ScriptedModel([
    () => call(SUBMIT, titled('Clean draft', 90)),
    () => say('1. Tweak something.\nVERDICT: REVISE'),
    () => call(SUBMIT, titled('Broken rewrite', 90)),
  ]);

  const gate = (o) => ({
    issues: o.masthead.title === 'Broken rewrite'
      ? [{ severity: 'error', code: 'BROKEN_RULE', message: 'Broken' }]
      : [],
  });

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'gate-reject' })({
    agent: 'story-director',
    config: { model: 'isolated-scripted-model', reflectionRounds: 1 },
    input: { targetTotalRuntimeSec: 90 },
    attempt: 1,
    gate,
  });

  const r = out[REFLECTION];
  assert.equal(r.log[0].changed, false);
  assert.deepEqual(r.log[0].rejected, { reason: 'gate', errorsBefore: 0, errorsAfter: 1 });
  assert.equal(out.masthead.title, 'Clean draft');
}));

test('loop: rejected round counts as used round and loop stops at rounds', { timeout: 10000 }, () => tmp(async (runs) => {
  const m = new ScriptedModel([
    () => call(SUBMIT, titled('Draft zero', 100)),
    () => say('1. Cut length.\nVERDICT: REVISE'),
    () => call(SUBMIT, titled('Revision one grew', 105)), // Rejected round 1
    () => say('1. Still too long.\nVERDICT: REVISE'),
    () => call(SUBMIT, titled('Revision two grew', 110)), // Rejected round 2
  ]);

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'stop-at-rounds' })({
    agent: 'story-director',
    config: { model: 'isolated-scripted-model', reflectionRounds: 2 },
    input: { targetTotalRuntimeSec: 90 },
    attempt: 1,
  });

  const r = out[REFLECTION];
  assert.equal(r.rounds, 2);
  assert.equal(r.roundsRun, 2);
  assert.equal(r.log.length, 2);
  assert.equal(r.log[0].rejected.reason, 'grew');
  assert.equal(r.log[1].rejected.reason, 'grew');
  //Kept the original draft after all rounds rejected
  assert.equal(out.masthead.title, 'Draft zero');
}));

test('loop: equal or shorter rewrite accepted', { timeout: 10000 }, () => tmp(async (runs) => {
  const m = new ScriptedModel([
    () => call(SUBMIT, titled('Draft zero', 100)),
    () => say('1. Shorten.\nVERDICT: REVISE'),
    () => call(SUBMIT, titled('Revision one', 90)),
  ]);

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'shorter-ok' })({
    agent: 'story-director',
    config: { model: 'isolated-scripted-model', reflectionRounds: 1 },
    input: { targetTotalRuntimeSec: 90 },
    attempt: 1,
  });

  const r = out[REFLECTION];
  assert.equal(r.log[0].changed, true);
  assert.equal(r.log[0].rejected, undefined);
  assert.equal(out.shapeBar.totalRuntimeSec, 90);
  assert.equal(out.masthead.title, 'Revision one');
}));

test('loop: early SHIP still works when clean draft is approved', { timeout: 10000 }, () => tmp(async (runs) => {
  const m = new ScriptedModel([
    () => call(SUBMIT, titled('Draft zero', 88)),
    () => say('R1 Fidelity: PASS\nR8 Length: PASS\nVERDICT: SHIP'),
  ]);

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'early-ship' })({
    agent: 'story-director',
    config: { model: 'isolated-scripted-model', reflectionRounds: 2 },
    input: { targetTotalRuntimeSec: 90 },
    attempt: 1,
    gate: () => ({ issues: [] }),
  });

  const r = out[REFLECTION];
  assert.equal(r.rounds, 2);
  assert.equal(r.roundsRun, 1);
  assert.equal(r.stoppedEarly, true);
  assert.equal(m.calls.length, 2, 'only draft + critique called, no rewrite called');
  assert.equal(out.masthead.title, 'Draft zero');
}));
