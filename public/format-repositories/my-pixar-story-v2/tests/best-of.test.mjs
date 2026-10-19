// Tests for Story Director best-of-2 first drafts: parallel runs, gating,
// judging, tiebreaking, and single-draft fallbacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { deepAgentInvoke, REFLECTION } from '../graph/deep-agent-node.mjs';
import { V2_MODELS, loadPick } from '../config/models.mjs';
import {
  bestOfEnabled,
  pickDraft,
  judgeMessages,
  parseWinner,
  ownWordsShare,
  draftContext,
} from '../graph/best-of.mjs';

class ScriptedModel extends BaseChatModel {
  constructor(handler) {
    super({});
    this.modelName = 'isolated-scripted-model';
    this.handler = Array.isArray(handler) ? (msgs) => {
      const step = handler.shift();
      assert.ok(step, 'model called after expected termination');
      return step(msgs);
    } : handler;
    this.calls = [];
  }
  getName() { return 'ChatOpenAI'; }
  _llmType() { return 'isolated-scripted-test'; }
  bindTools() { return this; }
  async _generate(messages, options, runManager) {
    this.calls.push(messages);
    const msg = await this.handler(messages, options, runManager);
    return { generations: [{ text: '', message: msg }] };
  }
}

const call = (name, args) => new AIMessage({ content: '', tool_calls: [{ name, args, id: name + Math.random().toString(36).slice(2, 7), type: 'tool_call' }] });
const say = (t) => new AIMessage(t);
const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const FIX = { 'story-director': 'good-stage-play.json' };
const SUBMIT = 'submit_story_director';

const titled = (t, runtime = null) => {
  const d = json(FIX['story-director']);
  d.masthead.title = t;
  if (runtime != null) d.shapeBar.totalRuntimeSec = runtime;
  return d;
};

const withVerbatim = (t, kinds = []) => {
  const d = titled(t);
  let idx = 0;
  for (const seg of d.segments ?? []) {
    for (const shot of seg.shots ?? []) {
      for (const k of ['dialogue', 'narration']) {
        if (shot[k]?.line) {
          const kind = Array.isArray(kinds) ? (idx < kinds.length ? kinds[idx++] : 'paraphrase') : kinds;
          shot[k].source = { ...(shot[k].source || {}), kind };
        }
      }
    }
  }
  return d;
};

const textOf = (msgs) => msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
async function tmp(run) {
  const d = await mkdtemp(join(tmpdir(), 'wiggly-v2-best-of-'));
  try { await run(d); } finally { await rm(d, { recursive: true, force: true }); }
}

const INPUT = { subject: 'Test family', answers: { finale: 'Always call me.' }, targetTotalRuntimeSec: 90 };

test('PICK.md < 80 words and loads properly', { timeout: 10000 }, () => {
  const pick = loadPick('story-director');
  assert.ok(pick, 'loadPick(story-director) must return string');
  const words = pick.trim().split(/\s+/).filter(Boolean);
  assert.ok(words.length < 80, `PICK.md must be under 80 words, got ${words.length}`);
  assert.equal(loadPick('character-architect'), null);
});

test('WINNER parsing: standard, markdown bold, TIE, and unparseable garbage', { timeout: 10000 }, () => {
  assert.equal(parseWinner('Reasoning...\nWINNER: A'), 'A');
  assert.equal(parseWinner('Reasoning...\nWINNER: B'), 'B');
  assert.equal(parseWinner('Reasoning...\nWINNER: TIE'), 'TIE');
  assert.equal(parseWinner('Reasoning...\n**WINNER: A**'), 'A');
  assert.equal(parseWinner('Reasoning...\n**WINNER: B**'), 'B');
  assert.equal(parseWinner('No winner mentioned anywhere'), 'TIE');
  assert.equal(parseWinner(''), 'TIE');
});

test('ownWordsShare counts verbatim lines over total spoken lines', { timeout: 10000 }, () => {
  const allVerbatim = withVerbatim('All Verbatim', 'verbatim');
  assert.equal(ownWordsShare(allVerbatim), 1);
  const noneVerbatim = withVerbatim('None', 'paraphrase');
  assert.equal(ownWordsShare(noneVerbatim), 0);
  assert.equal(ownWordsShare({}), 0);
});

test('flag off, other agents, and patch mode: single draft', { timeout: 10000 }, () => {
  // story-director has bestOfDrafts: 2 in V2_MODELS
  assert.equal(bestOfEnabled('story-director', V2_MODELS['story-director']), true);
  // flag off via config
  assert.equal(bestOfEnabled('story-director', { ...V2_MODELS['story-director'], bestOfDrafts: 1 }), false);
  assert.equal(bestOfEnabled('story-director', { model: 'isolated-scripted-model', reflectionRounds: 2 }), false);
  // other agents are off
  for (const a of ['character-architect', 'location-scout', 'seedance-compiler', 'vera', 'linter']) {
    assert.equal(bestOfEnabled(a, V2_MODELS[a]), false, `${a} must not have best-of enabled`);
  }
  // patch mode (scope or task set) skips best-of
  assert.equal(bestOfEnabled('story-director', V2_MODELS['story-director'], { scope: 'part 1' }), false);
  assert.equal(bestOfEnabled('story-director', V2_MODELS['story-director'], { task: 'Patch task' }), false);
  // reflection rounds = 0 skips best-of
  assert.equal(bestOfEnabled('story-director', V2_MODELS['story-director'], { rounds: 0 }), false);
});

test('two drafts run in parallel (both started before either resolves)', { timeout: 10000 }, () => tmp(async (runs) => {
  let startedA = false;
  let startedB = false;
  let deferredA;
  let deferredB;
  const pA = new Promise((resolve) => { deferredA = resolve; });
  const pB = new Promise((resolve) => { deferredB = resolve; });
  let callCount = 0;

  const m = new ScriptedModel(async (msgs) => {
    const raw = textOf(msgs);
    const draftId = draftContext.getStore()?.draftId;
    if (draftId === 'A') {
      startedA = true;
      await pA;
      return call(SUBMIT, titled('Draft A'));
    }
    if (draftId === 'B') {
      startedB = true;
      await pB;
      return call(SUBMIT, titled('Draft B'));
    }
    if (raw.includes('Target total runtime:')) {
      return say('Draft A is more focused.\nWINNER: A');
    }
    return say('SHIP\nVERDICT: SHIP');
  });

  const runPromise = deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'par' })({
    agent: 'story-director',
    config: { ...V2_MODELS['story-director'], reflectionRounds: 1 },
    input: INPUT,
    attempt: 1,
    gate: () => ({ issues: [] }),
  });

  for (let i = 0; i < 50; i++) {
    if (startedA && startedB) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(startedA, 'Draft A should have started');
  assert.ok(startedB, 'Draft B should have started');

  deferredA();
  deferredB();

  const out = await runPromise;
  assert.equal(out.masthead.title, 'Draft A');

  const dir = join(runs, 'par_attempt-1', 'story-director', 'reflection');
  assert.ok(existsSync(join(dir, 'draft-A.json')), 'draft-A.json must exist');
  assert.ok(existsSync(join(dir, 'draft-B.json')), 'draft-B.json must exist');
  assert.ok(existsSync(join(dir, 'draft-0.json')), 'draft-0.json must exist');
}));

test('one fails gate -> other wins, no judge call', { timeout: 10000 }, () => tmp(async (runs) => {
  let judgeCalled = false;
  const m = new ScriptedModel(async (msgs) => {
    const raw = textOf(msgs);
    const draftId = draftContext.getStore()?.draftId;
    if (draftId === 'A') return call(SUBMIT, titled('Draft A'));
    if (draftId === 'B') return call(SUBMIT, titled('Draft B'));
    if (raw.includes('Target total runtime:')) {
      judgeCalled = true;
      return say('WINNER: A');
    }
    return say('SHIP\nVERDICT: SHIP');
  });

  // Draft A fails gate with error, Draft B passes gate
  const gate = (draft) => {
    if (draft.masthead?.title === 'Draft A') {
      return { issues: [{ severity: 'error', message: 'Draft A has fatal plot hole', path: 'segments.0' }] };
    }
    return { issues: [] };
  };

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'gate-one' })({
    agent: 'story-director',
    config: { ...V2_MODELS['story-director'], reflectionRounds: 1 },
    input: INPUT,
    attempt: 1,
    gate,
  });

  assert.equal(judgeCalled, false, 'Judge should NOT be called when one draft fails gate');
  assert.equal(out.masthead.title, 'Draft B', 'Draft B should win when Draft A fails gate');
  const r = out[REFLECTION];
  assert.equal(r.bestOf.winner, 'B');
  assert.equal(r.bestOf.judged, false);
  assert.equal(r.bestOf.reason, 'gate');
  assert.equal(r.bestOf.drafts[0].gateErrors, 1);
  assert.equal(r.bestOf.drafts[1].gateErrors, 0);
}));

test('both pass -> judge called, messages contain both scripts and no answer string from input', { timeout: 10000 }, () => tmp(async (runs) => {
  const SECRET_ANSWER = 'XYZZY_SECRET_ANSWER_STRING_12345';
  let judgeMessagesSeen = null;

  const m = new ScriptedModel(async (msgs) => {
    const raw = textOf(msgs);
    const draftId = draftContext.getStore()?.draftId;
    if (draftId === 'A') return call(SUBMIT, titled('Draft Alpha'));
    if (draftId === 'B') return call(SUBMIT, titled('Draft Beta'));
    if (raw.includes('Target total runtime:')) {
      judgeMessagesSeen = textOf(msgs);
      return say('Draft Beta has better referents.\nWINNER: B');
    }
    return say('SHIP\nVERDICT: SHIP');
  });

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'both-pass' })({
    agent: 'story-director',
    config: { ...V2_MODELS['story-director'], reflectionRounds: 1 },
    input: { ...INPUT, answers: { deepSecret: SECRET_ANSWER }, targetTotalRuntimeSec: 90 },
    attempt: 1,
    gate: () => ({ issues: [] }),
  });

  assert.ok(judgeMessagesSeen, 'Judge must have been called');
  assert.match(judgeMessagesSeen, /Draft Alpha/);
  assert.match(judgeMessagesSeen, /Draft Beta/);
  assert.match(judgeMessagesSeen, /Target total runtime: 90s/);
  assert.ok(!judgeMessagesSeen.includes(SECRET_ANSWER), 'Judge messages must not leak answer strings from input');
  assert.equal(out.masthead.title, 'Draft Beta');

  const r = out[REFLECTION];
  assert.equal(r.bestOf.winner, 'B');
  assert.equal(r.bestOf.judged, true);
  assert.equal(r.bestOf.reason, 'judge');
  assert.ok(r.bestOf.judgeReplyFile.endsWith('judge-reply.md'));

  const dir = join(runs, 'both-pass_attempt-1', 'story-director', 'reflection');
  assert.ok(existsSync(join(dir, 'judge-reply.md')));
  const replyContent = await readFile(join(dir, 'judge-reply.md'), 'utf8');
  assert.match(replyContent, /WINNER: B/);
}));

test('warnings ignored: warning does not count as gate error', { timeout: 10000 }, () => tmp(async (runs) => {
  let judgeCalled = false;
  const m = new ScriptedModel(async (msgs) => {
    const raw = textOf(msgs);
    const draftId = draftContext.getStore()?.draftId;
    if (draftId === 'A') return call(SUBMIT, titled('Draft A'));
    if (draftId === 'B') return call(SUBMIT, titled('Draft B'));
    if (raw.includes('Target total runtime:')) {
      judgeCalled = true;
      return say('WINNER: A');
    }
    return say('SHIP\nVERDICT: SHIP');
  });

  const gate = () => ({
    issues: [
      { severity: 'warning', code: 'PROP_INVENTED_DETAIL', message: 'prop detail warning' },
      { severity: 'warning', code: 'CONNECTIVE_LINES_HIGH', message: 'too many connective lines' },
    ],
  });

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'warn-ok' })({
    agent: 'story-director',
    config: { ...V2_MODELS['story-director'], reflectionRounds: 1 },
    input: INPUT,
    attempt: 1,
    gate,
  });

  assert.equal(judgeCalled, true, 'Warnings must not fail gate; judge should be called');
  assert.equal(out.masthead.title, 'Draft A');
  assert.equal(out[REFLECTION].bestOf.drafts[0].gateErrors, 0);
  assert.equal(out[REFLECTION].bestOf.drafts[1].gateErrors, 0);
}));

test('both fail -> draft A proceeds and existing retry still works', { timeout: 10000 }, () => tmp(async (runs) => {
  let judgeCalled = false;
  const seenCritique = [];
  const m = new ScriptedModel(async (msgs) => {
    const raw = textOf(msgs);
    const draftId = draftContext.getStore()?.draftId;
    if (draftId === 'A') return call(SUBMIT, titled('Draft A'));
    if (draftId === 'B') return call(SUBMIT, titled('Draft B'));
    if (raw.includes('Target total runtime:')) {
      judgeCalled = true;
      return say('WINNER: A');
    }
    if (raw.includes('The script to read')) {
      return say('1. Setup & payoff: PASS');
    }
    if (raw.includes('review round 1')) {
      seenCritique.push(raw);
      return say('1. Fix plot hole.\nVERDICT: REVISE');
    }
    if (raw.includes('revision round 1')) {
      return call(SUBMIT, titled('Revision One'));
    }
    return say('SHIP\nVERDICT: SHIP');
  });

  const gate = (d) => {
    if (d.masthead.title === 'Revision One') return { issues: [] };
    return { issues: [{ severity: 'error', message: 'plot error', path: 'segments.0' }] };
  };

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'both-fail' })({
    agent: 'story-director',
    config: { ...V2_MODELS['story-director'], reflectionRounds: 1 },
    input: INPUT,
    attempt: 1,
    gate,
  });

  assert.equal(judgeCalled, false, 'Judge should NOT be called when both fail gate');
  assert.equal(out.masthead.title, 'Revision One');
  assert.equal(out[REFLECTION].bestOf.winner, 'A');
  assert.equal(out[REFLECTION].bestOf.reason, 'both-failed');
  assert.equal(out[REFLECTION].bestOf.judged, false);
  assert.equal(seenCritique.length, 1);
  assert.match(seenCritique[0], /Draft A/);
}));

test('TIE/garbage -> own-words tiebreak (higher verbatim share wins)', async () => {
  const draftA = withVerbatim('A', ['verbatim', 'verbatim', 'verbatim', 'connective']);
  const draftB = withVerbatim('B', ['verbatim', 'paraphrase', 'paraphrase', 'connective']);

  const fakeModel = {
    invoke: async () => say('WINNER: TIE'),
  };

  const res = await pickDraft({
    draftA,
    draftB,
    gate: () => ({ issues: [] }),
    model: fakeModel,
    input: INPUT,
    agent: 'story-director',
  });

  assert.equal(res.winner, 'A');
  assert.equal(res.bestOf.reason, 'own-words');
  assert.equal(res.bestOf.judged, true);
});

test('TIE/garbage -> tiebreak by fewer runtime seconds when own-words match', async () => {
  const draftA = withVerbatim('A', ['verbatim', 'connective']);
  draftA.shapeBar.totalRuntimeSec = 95;
  const draftB = withVerbatim('B', ['verbatim', 'connective']);
  draftB.shapeBar.totalRuntimeSec = 88;

  const fakeModel = {
    invoke: async () => say('Could not decide.\nWINNER: UNKNOWN'),
  };

  const res = await pickDraft({
    draftA,
    draftB,
    gate: () => ({ issues: [] }),
    model: fakeModel,
    input: INPUT,
    agent: 'story-director',
  });

  assert.equal(res.winner, 'B');
  assert.equal(res.bestOf.reason, 'runtime');
});

test('TIE/garbage -> fallback to A when own-words and runtime are equal', async () => {
  const draftA = withVerbatim('A', ['verbatim', 'connective']);
  draftA.shapeBar.totalRuntimeSec = 90;
  const draftB = withVerbatim('B', ['verbatim', 'connective']);
  draftB.shapeBar.totalRuntimeSec = 90;

  const fakeModel = {
    invoke: async () => { throw new Error('Temporary judge failure'); },
  };

  const res = await pickDraft({
    draftA,
    draftB,
    gate: () => ({ issues: [] }),
    model: fakeModel,
    input: INPUT,
    agent: 'story-director',
  });

  assert.equal(res.winner, 'A');
  assert.equal(res.bestOf.reason, 'fallback');
});

test('flag off: single draft run unchanged', { timeout: 10000 }, () => tmp(async (runs) => {
  let calls = 0;
  const m = new ScriptedModel(async () => {
    calls++;
    return call(SUBMIT, titled('Single Draft'));
  });

  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'flag-off' })({
    agent: 'story-director',
    config: { ...V2_MODELS['story-director'], bestOfDrafts: 1, reflectionRounds: 0 },
    input: INPUT,
    attempt: 1,
  });

  assert.equal(calls, 1, 'Single draft only when bestOfDrafts: 1');
  assert.equal(out.masthead.title, 'Single Draft');
  assert.equal(out[REFLECTION], undefined);
}));
