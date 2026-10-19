import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { deepAgentInvoke, REFLECTION, revisionMessage } from '../graph/deep-agent-node.mjs';
import { parseFixShots, enforceScope, recomputeRuntime, formatScopedRevisionInstructions } from '../graph/scoped-rewrite.mjs';
import { validateStoryDirectorOutput } from '../crew/linter/check-stage-play.mjs';
import { normalizePrior } from '../graph/patch.mjs';
import { MAX_LINE_WORDS } from '../crew/linter/speech.mjs';

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
  const d = await mkdtemp(join(tmpdir(), 'wiggly-v2-sd-scoped-'));
  try { await run(d); } finally { await rm(d, { recursive: true, force: true }); }
}

const baseFixture = () => normalizePrior({ storyDirector: json('good-stage-play.json') }).storyDirector;
const ANS = json('good-answers.json');
const INPUT = {
  subject: ANS.subject,
  targetTotalRuntimeSec: 90,
  answers: ANS.answers,
};

test('fix-id parsing incl. ranges and unscoped items', { timeout: 10000 }, () => {
  const critique = `
R1 Fidelity: FAIL
- 1.2 "x" → original: "y"
R8 Length: FAIL

FIXES:
1. 3.4: restore "..." whole, split across 3.4-3.5
2. cut 2.1-2.2
3. part 1 shots 2 to 4: retime
4. cut 2.4-5
5. retime to <=90s by cuts
6. tighten pace to 2.5s per shot

VERDICT: REVISE
`;

  const shots = parseFixShots(critique);
  assert.ok(shots instanceof Set);

  // Single shot & range expanded
  assert.equal(shots.has('3.4'), true);
  assert.equal(shots.has('3.5'), true);
  assert.equal(shots.has('2.1'), true);
  assert.equal(shots.has('2.2'), true);

  // Part 1 shots 2 to 4
  assert.equal(shots.has('1.2'), true);
  assert.equal(shots.has('1.3'), true);
  assert.equal(shots.has('1.4'), true);

  // 2.4-5 expanded
  assert.equal(shots.has('2.4'), true);
  assert.equal(shots.has('2.5'), true);

  // Non-shot seconds not matched as shots
  assert.equal(shots.has('90'), false);
  assert.equal(shots.has('2.5'), true); // 2.5 from 2.4-5; check 90s is not parsed

  // Unscoped items
  assert.deepEqual(shots.unscopedFixes, [
    'retime to <=90s by cuts',
    'tighten pace to 2.5s per shot',
  ]);
});

test('unnamed shot changes reverted', { timeout: 10000 }, () => {
  const prev = {
    shapeBar: { totalRuntimeSec: 10 },
    segments: [{
      segmentId: 1,
      shots: [
        { shotNumber: 1, startSec: 0, endSec: 3, whatWeSee: 'Theo sits.' },
        { shotNumber: 2, startSec: 3, endSec: 6, whatWeSee: 'Gran enters.' },
        { shotNumber: 3, startSec: 6, endSec: 10, whatWeSee: 'They talk.' },
      ],
    }],
  };

  const next = {
    shapeBar: { totalRuntimeSec: 10 },
    segments: [{
      segmentId: 1,
      shots: [
        { shotNumber: 1, startSec: 0, endSec: 3, whatWeSee: 'Theo runs away.' }, // Changed unnamed!
        { shotNumber: 2, startSec: 3, endSec: 6, whatWeSee: 'Gran waves.' }, // Changed named!
        { shotNumber: 3, startSec: 6, endSec: 10, whatWeSee: 'They talk.' }, // Unchanged
      ],
    }],
  };

  const allowed = new Set(['1.2']);
  const enforced = enforceScope(prev, next, allowed);

  // 1.1 reverted
  assert.equal(enforced.segments[0].shots[0].whatWeSee, 'Theo sits.');
  // 1.2 kept
  assert.equal(enforced.segments[0].shots[1].whatWeSee, 'Gran waves.');
  // 1.3 kept
  assert.equal(enforced.segments[0].shots[2].whatWeSee, 'They talk.');
  // Reverted log
  assert.deepEqual(enforced.reverted, ['1.1']);
});

test('unnamed deletion restored', { timeout: 10000 }, () => {
  const prev = {
    shapeBar: { totalRuntimeSec: 9 },
    segments: [{
      segmentId: 1,
      shots: [
        { shotNumber: 1, startSec: 0, endSec: 3, whatWeSee: 'Shot 1' },
        { shotNumber: 2, startSec: 3, endSec: 6, whatWeSee: 'Shot 2' },
        { shotNumber: 3, startSec: 6, endSec: 9, whatWeSee: 'Shot 3' },
      ],
    }],
  };

  const next = {
    shapeBar: { totalRuntimeSec: 6 },
    segments: [{
      segmentId: 1,
      shots: [
        { shotNumber: 2, startSec: 3, endSec: 6, whatWeSee: 'Shot 2 revised' },
      ], // Shot 1 and Shot 3 deleted!
    }],
  };

  const allowed = new Set(['1.2']);
  const enforced = enforceScope(prev, next, allowed);

  // Both unnamed deleted shots are restored in their original relative positions
  assert.equal(enforced.segments[0].shots.length, 3);
  assert.equal(enforced.segments[0].shots[0].shotNumber, 1);
  assert.equal(enforced.segments[0].shots[0].whatWeSee, 'Shot 1');
  assert.equal(enforced.segments[0].shots[1].shotNumber, 2);
  assert.equal(enforced.segments[0].shots[1].whatWeSee, 'Shot 2 revised');
  assert.equal(enforced.segments[0].shots[2].shotNumber, 3);
  assert.equal(enforced.segments[0].shots[2].whatWeSee, 'Shot 3');

  assert.deepEqual(enforced.reverted.sort(), ['1.1', '1.3']);
});

test('named shot cut accepted', { timeout: 10000 }, () => {
  const prev = {
    shapeBar: { totalRuntimeSec: 9 },
    segments: [{
      segmentId: 1,
      shots: [
        { shotNumber: 1, startSec: 0, endSec: 3, whatWeSee: 'Shot 1' },
        { shotNumber: 2, startSec: 3, endSec: 6, whatWeSee: 'Shot 2' },
        { shotNumber: 3, startSec: 6, endSec: 9, whatWeSee: 'Shot 3' },
      ],
    }],
  };

  const next = {
    shapeBar: { totalRuntimeSec: 6 },
    segments: [{
      segmentId: 1,
      shots: [
        { shotNumber: 1, startSec: 0, endSec: 3, whatWeSee: 'Shot 1' },
        { shotNumber: 3, startSec: 3, endSec: 6, whatWeSee: 'Shot 3' },
      ], // Shot 2 cut!
    }],
  };

  const allowed = new Set(['1.2']);
  const enforced = enforceScope(prev, next, allowed);

  // Shot 2 was named, so its deletion is accepted
  assert.equal(enforced.segments[0].shots.length, 2);
  assert.deepEqual(enforced.segments[0].shots.map((s) => s.shotNumber), [1, 3]);
  assert.deepEqual(enforced.reverted, []);
});

test('adjacent insertion allowed', { timeout: 10000 }, () => {
  const prev = {
    shapeBar: { totalRuntimeSec: 9 },
    segments: [{
      segmentId: 1,
      shots: [
        { shotNumber: 1, startSec: 0, endSec: 3, whatWeSee: 'Shot 1' },
        { shotNumber: 2, startSec: 3, endSec: 6, whatWeSee: 'Shot 2' },
        { shotNumber: 3, startSec: 6, endSec: 9, whatWeSee: 'Shot 3' },
      ],
    }],
  };

  // Case A: Insertion adjacent to named shot 1.2
  const nextAdjacent = {
    shapeBar: { totalRuntimeSec: 12 },
    segments: [{
      segmentId: 1,
      shots: [
        { shotNumber: 1, startSec: 0, endSec: 3, whatWeSee: 'Shot 1' },
        { shotNumber: 2, startSec: 3, endSec: 6, whatWeSee: 'Shot 2' },
        { shotNumber: 4, startSec: 6, endSec: 9, whatWeSee: 'New adjacent shot' },
        { shotNumber: 3, startSec: 9, endSec: 12, whatWeSee: 'Shot 3' },
      ],
    }],
  };

  const enforcedA = enforceScope(prev, nextAdjacent, new Set(['1.2']));
  assert.equal(enforcedA.segments[0].shots.length, 4);
  assert.equal(enforcedA.segments[0].shots[2].shotNumber, 4);
  assert.deepEqual(enforcedA.reverted, []);

  // Case B: Insertion NOT adjacent to named shot (named shot is 1.3, but shot 4 is inserted between 1.1 and 1.2)
  const nextNotAdjacent = {
    shapeBar: { totalRuntimeSec: 12 },
    segments: [{
      segmentId: 1,
      shots: [
        { shotNumber: 1, startSec: 0, endSec: 3, whatWeSee: 'Shot 1' },
        { shotNumber: 4, startSec: 3, endSec: 6, whatWeSee: 'Non-adjacent insertion' },
        { shotNumber: 2, startSec: 6, endSec: 9, whatWeSee: 'Shot 2' },
        { shotNumber: 3, startSec: 9, endSec: 12, whatWeSee: 'Shot 3' },
      ],
    }],
  };

  const enforcedB = enforceScope(prev, nextNotAdjacent, new Set(['1.3']));
  // Shot 4 is dropped
  assert.equal(enforcedB.segments[0].shots.length, 3);
  assert.deepEqual(enforcedB.segments[0].shots.map((s) => s.shotNumber), [1, 2, 3]);
  assert.deepEqual(enforcedB.reverted, ['1.4']);
});

test('no scoped fixes -> rewrite skipped', { timeout: 10000 }, () => tmp(async (runs) => {
  const draft0 = baseFixture();
  draft0.masthead.title = 'Draft zero';

  const m = new ScriptedModel([
    () => call(SUBMIT, draft0),
    () => say('FIXES:\n1. retime to <=90s by cuts\n2. tighten pacing\n\nVERDICT: REVISE'),
  ]);

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'no-scoped' })({
    agent: 'story-director',
    config: { model: 'isolated-scripted-model', reflectionRounds: 1 },
    input: INPUT,
    attempt: 1,
    gate: () => ({ issues: [] }),
  });

  // Only draft and critique called; rewrite was skipped!
  assert.equal(m.calls.length, 2);
  const r = out[REFLECTION];
  assert.equal(r.roundsRun, 1);
  assert.equal(r.log[0].skipped, 'no scoped fixes');
  assert.equal(r.log[0].changed, false);
  assert.deepEqual(r.log[0].unscopedFixes, ['retime to <=90s by cuts', 'tighten pacing']);
  assert.equal(out.masthead.title, 'Draft zero');
}));

test('revision message lists allowed shots and the split-long-sentence rule', { timeout: 10000 }, () => {
  const msg = revisionMessage({
    agent: 'story-director',
    draft: { title: 'Test' },
    critique: 'FIXES:\n1. 2.1-2.2: cut\nVERDICT: REVISE',
    round: 1,
    rounds: 2,
    allowedShots: new Set(['2.1', '2.2']),
  });

  assert.match(msg, /Allowed shots to change: 2\.1, 2\.2/);
  assert.match(msg, /Every shot outside this allowed set is frozen and must not change/);
  assert.match(msg, new RegExp(`per-line word cap \\(${MAX_LINE_WORDS} words\\)`));
  assert.match(msg, /split across consecutive lines or shots, never left long/);
});

test('reproduce the evidence (rewrite drops 3 unnamed verbatim lines -> they come back)', { timeout: 10000 }, () => tmp(async (runs) => {
  const draft0 = baseFixture();
  // Shots 1.2, 1.3, 1.4 have verbatim lines in good-stage-play.json
  const line1 = draft0.segments[0].shots[1].dialogue.line;
  const line2 = draft0.segments[0].shots[2].dialogue.line;
  const line3 = draft0.segments[0].shots[3].dialogue.line;

  // Rewrite where 2.1 is changed, but verbatim lines are dropped from shots 1.2, 1.3, 1.4
  const rewriteBad = structuredClone(draft0);
  delete rewriteBad.segments[0].shots[1].dialogue;
  delete rewriteBad.segments[0].shots[2].dialogue;
  delete rewriteBad.segments[0].shots[3].dialogue;
  rewriteBad.segments[1].shots[0].whatWeSee = 'Modified shot 2.1 framing.';

  const m = new ScriptedModel([
    () => call(SUBMIT, draft0),
    () => say('FIXES:\n1. 2.1: modify shot framing\n2. retime to <=90s by cuts\n\nVERDICT: REVISE'),
    () => call(SUBMIT, rewriteBad),
  ]);

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'evidence-repro' })({
    agent: 'story-director',
    config: { model: 'isolated-scripted-model', reflectionRounds: 1 },
    input: INPUT,
    attempt: 1,
    gate: () => ({ issues: [] }),
  });

  const r = out[REFLECTION];
  assert.equal(r.roundsRun, 1);
  // All 3 unnamed modified shots were restored!
  assert.deepEqual(r.log[0].reverted.sort(), ['1.2', '1.3', '1.4']);
  assert.equal(out.segments[0].shots[1].dialogue.line, line1);
  assert.equal(out.segments[0].shots[2].dialogue.line, line2);
  assert.equal(out.segments[0].shots[3].dialogue.line, line3);
}));

test('a 22-word restored line -> gate error -> rewrite rejected and previous passing draft kept', { timeout: 10000 }, () => tmp(async (runs) => {
  const draft0 = baseFixture();
  draft0.masthead.title = 'Passing draft zero';

  // Rewrite restores a 22-word line in allowed shot 1.2 (over the 18-word cap)
  const rewriteWithLongLine = structuredClone(draft0);
  rewriteWithLongLine.masthead.title = 'Rewrite with 22-word line';
  rewriteWithLongLine.segments[0].shots[1].dialogue = {
    speaker: '@Shaz',
    line: '{One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two.}',
    isVoiceover: false,
    isOffCamera: false,
    source: { answer: 'scene1Childhood.memory', kind: 'verbatim' },
  };

  const m = new ScriptedModel([
    () => call(SUBMIT, draft0),
    () => say('FIXES:\n1. 1.2: restore the sentence whole\n\nVERDICT: REVISE'),
    () => call(SUBMIT, rewriteWithLongLine),
  ]);

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'word-cap-reject' })({
    agent: 'story-director',
    config: { model: 'isolated-scripted-model', reflectionRounds: 1 },
    input: INPUT,
    attempt: 1,
    gate: (d) => validateStoryDirectorOutput(d, INPUT),
  });

  const r = out[REFLECTION];
  assert.equal(r.roundsRun, 1);
  // Rewrite rejected by the gate guard
  assert.equal(r.log[0].changed, false);
  assert.equal(r.log[0].rejected.reason, 'gate');
  assert.equal(r.log[0].rejected.errorsBefore, 0);
  assert.ok(r.log[0].rejected.errorsAfter > 0);
  // Previous passing draft kept!
  assert.equal(out.masthead.title, 'Passing draft zero');
}));

test('patch mode unaffected: scope already set, scoped rewrite is skipped', { timeout: 10000 }, () => tmp(async (runs) => {
  const prior = baseFixture();
  const fixed = structuredClone(prior);
  fixed.segments[0].shots[1].dialogue.line = '{New dialogue line.}';

  const m = new ScriptedModel([
    () => call(SUBMIT, prior),
    () => say('FIXES:\n1. 1.2: use the answer sentence whole.\nVERDICT: REVISE'),
    () => call(SUBMIT, fixed),
  ]);

  const patchInput = {
    subject: 'Test family',
    answers: INPUT.answers,
    patch: { target: 'shot:1.2', note: 'fix line', currentOutput: prior },
  };

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'pm-unaffected' })({
    agent: 'story-director',
    config: { model: 'isolated-scripted-model', reflectionRounds: 1 },
    input: patchInput,
    attempt: 1,
    scope: 'PATCH MODE: this review is scoped to target shot:1.2 only.',
    gate: () => ({ issues: [] }),
  });

  const r = out[REFLECTION];
  assert.equal(r.roundsRun, 1);
  assert.equal(r.log[0].changed, true);
  // Scoped rewrite skip was not triggered
  assert.equal(r.log[0].skipped, undefined);
  assert.equal(out.segments[0].shots[1].dialogue.line, '{New dialogue line.}');
}));

test('recomputeRuntime updates shapeBar after reverts', { timeout: 10000 }, () => {
  const draft = {
    shapeBar: {
      totalRuntimeSec: 100,
      parts: [{ durationSec: 100 }],
    },
    segments: [{
      segmentId: 1,
      shots: [
        { shotNumber: 1, startSec: 0, endSec: 10 },
        { shotNumber: 2, startSec: 10, endSec: 25 },
      ],
    }],
  };

  recomputeRuntime(draft);
  assert.equal(draft.shapeBar.totalRuntimeSec, 25);
  assert.equal(draft.shapeBar.parts[0].durationSec, 25);
});

test('a round can never replace a gate-passing draft with a failing one; node output is best accepted draft', { timeout: 10000 }, () => tmp(async (runs) => {
  const draft0 = baseFixture();
  draft0.masthead.title = 'Passing Draft 0';

  // Round 1 rewrite fails gate
  const rewriteBad = structuredClone(draft0);
  rewriteBad.masthead.title = 'Failing Rewrite 1';

  // Round 2 rewrite passes gate
  const rewriteGood = structuredClone(draft0);
  rewriteGood.masthead.title = 'Passing Rewrite 2';
  rewriteGood.segments[0].shots[1].dialogue.line = '{A scientist. Not even kidding.}';

  const m = new ScriptedModel([
    () => call(SUBMIT, draft0),
    () => say('FIXES:\n1. 1.2: revise line\n\nVERDICT: REVISE'),
    () => call(SUBMIT, rewriteBad), // Rejected!
    () => say('FIXES:\n1. 1.2: revise line properly\n\nVERDICT: REVISE'),
    () => call(SUBMIT, rewriteGood), // Accepted!
  ]);

  const gate = (d) => ({
    issues: d.masthead.title === 'Failing Rewrite 1'
      ? [{ severity: 'error', code: 'TEST_GATE_FAIL', message: 'Gate failed' }]
      : [],
  });

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'gate-guard-best' })({
    agent: 'story-director',
    config: { model: 'isolated-scripted-model', reflectionRounds: 2 },
    input: INPUT,
    attempt: 1,
    gate,
  });

  const r = out[REFLECTION];
  assert.equal(r.roundsRun, 2);
  // Round 1 rejected
  assert.equal(r.log[0].changed, false);
  assert.equal(r.log[0].rejected.reason, 'gate');
  // Round 2 accepted
  assert.equal(r.log[1].changed, true);
  // Output is the best accepted draft (Passing Rewrite 2, not Draft 0 and not Failing Rewrite 1)
  assert.equal(out.masthead.title, 'Passing Rewrite 2');
}));

