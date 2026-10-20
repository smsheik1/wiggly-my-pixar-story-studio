// The final review blocks: a failed fidelity/writing check (R1, R2) triggers a repair of the lines it names, then another
// review; still failing when the repairs run out -> STORY_REJECTED. Scripted model only: zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { deepAgentInvoke, REFLECTION, storyRejection, blockingFails, finalRepairCap } from '../graph/deep-agent-node.mjs';

class ScriptedModel extends BaseChatModel {
  constructor(handler) { super({}); this.modelName = 'isolated-scripted-model'; this.handler = handler; }
  getName() { return 'ChatOpenAI'; }
  _llmType() { return 'isolated-scripted-test'; }
  bindTools() { return this; }
  async _generate(messages) { return { generations: [{ text: '', message: await this.handler(messages) }] }; }
}
const call = (args) => new AIMessage({ content: '', tool_calls: [{ name: 'submit_story_director', args, id: 's' + Math.random().toString(36).slice(2, 7), type: 'tool_call' }] });
const say = (t) => new AIMessage(t);
const text = (msgs) => msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
const play = (line) => { const d = JSON.parse(readFileSync(new URL('./fixtures/good-stage-play.json', import.meta.url), 'utf8')); d.segments[1].shots[0].narration.line = line; return d; };
const INPUT = { subject: 'Test family', targetTotalRuntimeSec: 60, answers: JSON.parse(readFileSync(new URL('./fixtures/good-answers.json', import.meta.url), 'utf8')).answers };
async function tmp(run) { const d = await mkdtemp(join(tmpdir(), 'wiggly-final-repair-')); try { return await run(d); } finally { await rm(d, { recursive: true, force: true }); } }

const PASS = 'S1 Core: 4\nS2 Specific: 4\nS3 Turn: 4\nS4 Feel: 4\nR1 Fidelity: PASS\nR2 Invented details: PASS\nFIXES:\n(none)\nVERDICT: SHIP';
const FAIL_R1 = 'S1 Core: 4\nS2 Specific: 3\nS3 Turn: 4\nS4 Feel: 4\n**R1 Fidelity:** FAIL\n- 2.1 "{First job, nights, two buses.}" reads like a list of specs\nR2 Invented details: PASS\nFIXES:\n1. 2.1: say it as one spoken sentence.\nVERDICT: REVISE';
const ROUND = 'S1 Core: 4\nS2 Specific: 3\nS3 Turn: 4\nS4 Feel: 4\nR1 Fidelity: PASS\nFIXES:\n1. 2.1: tighten the line.\nVERDICT: REVISE';

test('blockingFails: R1 and R2 FAIL (markdown too), not other checks; cap defaults to 1', () => {
  assert.deepEqual(blockingFails(FAIL_R1), ['R1']);
  assert.deepEqual(blockingFails('R2 Invented details: FAIL\nR6 Finale: FAIL'), ['R2']);
  assert.deepEqual(blockingFails(PASS), []);
  assert.equal(finalRepairCap({}), 1); assert.equal(finalRepairCap({ finalRepairs: 0 }), 0);
});

test('storyRejection: a final review with R1 FAIL rejects with the evidence; a round whose fixes were applied does not', () => {
  const r = storyRejection([{ round: 3, finalReview: true, critique: FAIL_R1 }]);
  assert.equal(r.code, 'STORY_REJECTED'); assert.deepEqual(r.blockingFails, ['R1']); assert.match(r.message, /reads like a list of specs/);
  assert.equal(storyRejection([{ round: 1, critique: FAIL_R1, changed: true }]), null);
  assert.equal(storyRejection([{ round: 1, critique: FAIL_R1, changed: false }]).code, 'STORY_REJECTED');
});

const run = (finals, config = {}) => tmp(async (runs) => {
  const kinds = []; const q = [...finals];
  const m = new ScriptedModel(async (msgs) => {
    const sys = String(msgs[0]?.content ?? ''), all = text(msgs), last = msgs.at(-1);
    if ((last?.getType?.() ?? last?._getType?.()) === 'tool') return say('Done.');
    if (/reviewing your own draft/.test(sys)) { const k = kinds.includes('rewrite') ? 'final' : 'critique'; kinds.push(k); return say(k === 'critique' ? ROUND : q.shift()); }
    if (/Revise your story-director draft/.test(all)) { kinds.push(kinds.filter((k) => k === 'final').length ? 'repair' : 'rewrite'); return call(play(`{I took two buses to my first job, take ${kinds.length}.}`)); }
    kinds.push('draft'); return call(play('{First job, nights, two buses.}'));
  });
  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'fr', storyBeats: false })({
    agent: 'story-director', config: { model: 'x', reflectionRounds: 1, coldRead: false, ...config }, input: INPUT, attempt: 1, gate: () => ({ issues: [] }),
  });
  return { kinds, refl: out[REFLECTION] };
});

test('final review R1 FAIL -> one targeted repair -> reviewed again; PASS ships without STORY_REJECTED', { timeout: 20000 }, async () => {
  const { kinds, refl } = await run([FAIL_R1, PASS]);
  assert.deepEqual(kinds, ['draft', 'critique', 'rewrite', 'final', 'repair', 'final']);
  assert.ok(refl.log.some((e) => e.finalRepair && e.changed && e.blockingFails[0] === 'R1'));
  assert.equal(refl.storyRejection, undefined);
});

test('still failing after the repairs run out -> STORY_REJECTED', { timeout: 20000 }, async () => {
  const { kinds, refl } = await run([FAIL_R1, FAIL_R1]);
  assert.deepEqual(kinds, ['draft', 'critique', 'rewrite', 'final', 'repair', 'final']);
  assert.equal(refl.storyRejection.code, 'STORY_REJECTED'); assert.deepEqual(refl.storyRejection.blockingFails, ['R1']);
  const none = await run([FAIL_R1], { finalRepairs: 0 });
  assert.deepEqual(none.kinds, ['draft', 'critique', 'rewrite', 'final']); assert.equal(none.refl.storyRejection.code, 'STORY_REJECTED');
});
