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
const initial = () => ({ inputs: { subject: 'Shaz', answers: GOOD_ANSWERS, settingSeed: 'suburban home' }, approvedAssets: json('good-approved-assets.json') });

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
