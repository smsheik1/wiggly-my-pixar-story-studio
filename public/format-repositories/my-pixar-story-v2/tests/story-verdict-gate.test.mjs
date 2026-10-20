// The Story Director's final review gates the run: STRUCTURAL or any story score <= 2 fails the gate (STORY_REJECTED),
// so the node retries / escalates and downstream agents never run. Fake invoke only: zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGraph } from '../graph/graph.mjs';
import { REFLECTION, storyRejection } from '../graph/deep-agent-node.mjs';
import { GOOD_ANSWERS } from './fixtures/good-answers.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const FIX = { 'story-director': 'good-stage-play.json', 'character-architect': 'good-master-renders.json', 'location-scout': 'good-location-plates.json', 'seedance-compiler': 'good-seedance-prompts.json' };
const initial = () => ({ inputs: { subject: 'Shaz', answers: GOOD_ANSWERS, targetTotalRuntimeSec: 60, settingSeed: 'suburban home' }, approvedAssets: json('good-approved-assets.json') });

const STRUCTURAL = 'S1 Core: 1\nS2 Specific: 1\nS3 Turn: 1\nS4 Feel: 1\nThe story itself does not work: no moment the film exists for.\nVERDICT: STRUCTURAL';
const SHIP = 'S1 Core: 4\nS2 Specific: 5\nS3 Turn: 4\nS4 Feel: 4\nVERDICT: SHIP';
const REVISE_2 = 'S1 Core: 4\nS2 Specific: 4\nS3 Turn: 2\nS4 Feel: 4\n1. Shot 2.3: flat line.\nVERDICT: REVISE';

/** Story Director returns the good fixture with a reflection log whose last critique is `critique`. */
function invokeWith(critique) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req.agent);
    const o = json(FIX[req.agent]);
    if (req.agent === 'story-director') {
      const log = [{ round: 1, critique }];
      const rejection = storyRejection(log);
      Object.defineProperty(o, REFLECTION, { value: { rounds: 1, roundsRun: 1, stoppedEarly: false, ...(rejection ? { storyRejection: rejection } : {}), log }, enumerable: false });
    }
    return o;
  };
  fn.calls = calls;
  return fn;
}

test('storyRejection: STRUCTURAL and score <= 2 reject with scores and reason; SHIP with all >= 4 does not', () => {
  const r = storyRejection([{ round: 1, critique: SHIP }, { round: 2, critique: STRUCTURAL }]);
  assert.equal(r.code, 'STORY_REJECTED'); assert.equal(r.severity, 'error'); assert.equal(r.verdict, 'STRUCTURAL');
  assert.deepEqual(Object.values(r.scores), [1, 1, 1, 1]);
  assert.match(r.message, /=1/); assert.match(r.message, /story itself does not work/);
  assert.equal(storyRejection([{ round: 1, critique: STRUCTURAL }, { round: 2, critique: SHIP }]), null, 'the last review decides');
  assert.equal(storyRejection([{ round: 1, critique: REVISE_2 }]).verdict, 'REVISE');
  assert.equal(storyRejection([]), null);
});

test('graph: a STRUCTURAL final review fails the gate, the node escalates, downstream agents never run', async () => {
  const invoke = invokeWith(STRUCTURAL);
  const s = await buildGraph({ invoke }).invoke(initial());
  assert.notEqual(s.status, 'done');
  assert.ok(s.gateIssues['story-director'].some((i) => i.code === 'STORY_REJECTED'));
  assert.ok(invoke.calls.every((a) => a === 'story-director'), invoke.calls.join(','));
  assert.ok(invoke.calls.length > 1, 'the existing retry applied');
});

test('graph: a SHIP final review with every story score >= 4 passes and the pipeline finishes', async () => {
  const invoke = invokeWith(SHIP);
  const s = await buildGraph({ invoke }).invoke(initial());
  assert.equal(s.status, 'done', JSON.stringify(s.escalations));
  assert.ok(!s.gateIssues['story-director'].some((i) => i.code === 'STORY_REJECTED'));
  assert.deepEqual([...new Set(invoke.calls)].sort(), ['character-architect', 'location-scout', 'seedance-compiler', 'story-director']);
});

test('graph: a REVISE final review with a story score of 2 fails the gate', async () => {
  const invoke = invokeWith(REVISE_2);
  const s = await buildGraph({ invoke }).invoke(initial());
  assert.notEqual(s.status, 'done');
  assert.ok(s.gateIssues['story-director'].some((i) => i.code === 'STORY_REJECTED' && /S|Turn|=2/.test(i.message)));
  assert.ok(invoke.calls.every((a) => a === 'story-director'));
});

// Real review loop, scripted model: the draft returned is the one the last review judged.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { deepAgentInvoke } from '../graph/deep-agent-node.mjs';

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
const SUBMIT = 'submit_story_director';
const submit = (args) => new AIMessage({ content: '', tool_calls: [{ name: SUBMIT, args, id: 's' + Math.random().toString(36).slice(2, 7), type: 'tool_call' }] });
const titled = (t) => { const d = json(FIX['story-director']); d.masthead.title = t; return d; };
const seen = (msgs) => msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
async function runLoop(script) {
  const dir = await mkdtemp(join(tmpdir(), 'wiggly-v2-final-review-'));
  try {
    const m = new ScriptedModel(script);
    const out = await deepAgentInvoke({ storyBeats: false, createModel: async () => m, runsRoot: dir, runId: 'fr' })({
      agent: 'story-director', config: { model: 'isolated-scripted-model', reflectionRounds: 1 }, input: { subject: 'Test family', answers: { finale: 'I want her to know she can always call me.' } }, gate: () => ({ issues: [] }) });
    return { out, m, refl: out[REFLECTION] };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('final rewrite gets reviewed: one extra critique judges the returned draft; STRUCTURAL there rejects the story', async () => {
  let finalSaw = '';
  const { out, m, refl } = await runLoop([
    () => submit(titled('Draft zero')),
    () => new AIMessage(REVISE_2.replace('S3 Turn: 2', 'S3 Turn: 3')),
    () => submit(titled('Revision one')),
    (msgs) => { finalSaw = seen(msgs); return new AIMessage(STRUCTURAL); },
  ]);
  assert.equal(out.masthead.title, 'Revision one');
  assert.equal(m.calls.length, 4, 'draft + critique + rewrite + one final review');
  assert.match(finalSaw, /Revision one/, 'the final review judged the returned draft');
  assert.ok(refl.log.at(-1).finalReview);
  assert.equal(refl.storyRejection?.code, 'STORY_REJECTED');
});

test('final review SHIP on the rewritten draft passes', async () => {
  const { m, refl } = await runLoop([
    () => submit(titled('Draft zero')),
    () => new AIMessage(STRUCTURAL.replace('STRUCTURAL', 'REVISE').replace(/: 1/g, ': 3')),
    () => submit(titled('Revision one')),
    () => new AIMessage(SHIP),
  ]);
  assert.equal(m.calls.length, 4);
  assert.equal(refl.storyRejection, undefined);
});

test('SHIP early stop on an unchanged draft makes no extra review call', async () => {
  const { out, m, refl } = await runLoop([
    () => submit(titled('Draft zero')),
    () => new AIMessage(SHIP),
  ]);
  assert.equal(out.masthead.title, 'Draft zero');
  assert.equal(m.calls.length, 2, 'draft + critique only');
  assert.ok(refl.stoppedEarly); assert.ok(!refl.log.some((e) => e.finalReview));
  assert.equal(refl.storyRejection, undefined);
});
