// One full Story Director draft per story approach from the plan (up to 3), judged by the picker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { deepAgentInvoke, REFLECTION, STORY } from '../graph/deep-agent-node.mjs';
import { V2_MODELS } from '../config/models.mjs';
import { draftContext } from '../graph/best-of.mjs';
import { parseApproaches, critiqueMessages } from '../graph/story-beats.mjs';

class ScriptedModel extends BaseChatModel {
  constructor(handler) { super({}); this.modelName = 'isolated-scripted-model'; this.handler = handler; }
  getName() { return 'ChatOpenAI'; }
  _llmType() { return 'isolated-scripted-test'; }
  bindTools() { return this; }
  async _generate(messages) { return { generations: [{ text: '', message: await this.handler(messages) }] }; }
}
const call = (name, args) => new AIMessage({ content: '', tool_calls: [{ name, args, id: name + Math.random().toString(36).slice(2, 7), type: 'tool_call' }] });
const say = (t) => new AIMessage(t);
const textOf = (msgs) => msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
const titled = (t) => { const d = JSON.parse(readFileSync(new URL('./fixtures/good-stage-play.json', import.meta.url), 'utf8')); d.masthead.title = t; return d; };
const INPUT = { subject: 'Test family', answers: { finale: 'Always call me.' }, targetTotalRuntimeSec: 90 };
async function tmp(run) { const d = await mkdtemp(join(tmpdir(), 'wiggly-v2-approach-')); try { await run(d); } finally { await rm(d, { recursive: true, force: true }); } }

const PLAN3 = `1. Reveals: the porch light.
2. Two or three story approaches:
**Approach A: Thread.** The porch light left on, every night.
**Approach B: Memories.** Three rainy evenings.
- Approach C - Leaves out the move; only the calls.
3. Pick: A, because it is one thread.
Thesis: the light stays on.
Beat 1: the light.`;

test('parseApproaches: labels, text, stops at the pick, max 3, none', () => {
  const a = parseApproaches(PLAN3);
  assert.equal(a.length, 3);
  assert.equal(a[0].label, 'Approach A: Thread. The porch light left on, every night.');
  assert.deepEqual(parseApproaches('2. Two or three story approaches.\nA. Quiet\n- Thread: t\nB. Loud\n- Thread: u\n3. Pick one.\nA.').map((x) => x.label), ['A. Quiet', 'B. Loud']);
  assert.match(a[1].text, /rainy evenings/);
  assert.doesNotMatch(a[2].text, /Pick|Thesis/);
  assert.equal(parseApproaches(PLAN3, 2).length, 2);
  assert.deepEqual(parseApproaches('Thesis: T.\nBeat 1: x.'), []);
  const m = critiqueMessages(INPUT, PLAN3, 'SYS', a[1]);
  assert.match(m[1].content, /on this approach only: Approach B: Memories\./);
  assert.match(m[1].content, /Do not switch/);
});

const run = (plan, runId, judgeWinner, seen) => tmp(async (runs) => {
  const m = new ScriptedModel(async (msgs) => {
    const raw = textOf(msgs);
    const id = draftContext.getStore()?.draftId;
    if (id) { seen.drafts.push(id); seen.tasks[id] = raw; return call('submit_story_director', titled(`Draft ${id}`)); }
    if (raw.includes('Target total runtime:')) { seen.judge = raw; return say(`Better.\nWINNER: ${judgeWinner}`); }
    if (raw.includes('The beats to judge:')) {
      const which = (raw.match(/on this approach only: Approach ([ABC])/) ?? [])[1] ?? 'X';
      seen.critiques.push(which);
      return say(`1. ok\n## Rewritten beats\nThesis: thesis ${which}.\nBeat 1: story ${which}.`);
    }
    if (raw.includes('# Beats (story first')) { seen.plans += 1; return say(plan); }
    return say('SHIP\nVERDICT: SHIP');
  });
  const out = await deepAgentInvoke({ finalReview: false, createModel: async () => m, runsRoot: runs, runId })({
    agent: 'story-director', config: { ...V2_MODELS['story-director'], reflectionRounds: 1 }, input: INPUT, attempt: 1, gate: () => ({ issues: [] }),
  });
  seen.out = out;
  seen.filesExist = (out[STORY]?.files ?? []).every((f) => existsSync(join(runs, f)));
});

test('3 approaches -> one plan call, 3 critiques, 3 drafts, judge picks; winner story and thesis kept', { timeout: 20000 }, async () => {
  const seen = { drafts: [], tasks: {}, critiques: [], plans: 0 };
  await run(PLAN3, 'three', 'C', seen);
  assert.equal(seen.plans, 1);
  assert.deepEqual([...seen.critiques].sort(), ['A', 'B', 'C']);
  assert.deepEqual([...new Set(seen.drafts)].sort(), ['A', 'B', 'C']);
  assert.match(seen.tasks.A, /story A/); assert.match(seen.tasks.C, /story C/); assert.doesNotMatch(seen.tasks.C, /story A/);
  assert.match(seen.judge, /Draft A/); assert.match(seen.judge, /Draft C/);
  assert.equal(seen.out.masthead.title, 'Draft C');
  assert.equal(seen.out[REFLECTION].bestOf.winner, 'C');
  assert.equal(seen.out[STORY].approach, 'Approach C - Leaves out the move; only the calls.');
  assert.ok(seen.out[STORY].files.every((f) => f.includes('approach-C')));
  assert.ok(seen.filesExist);
  assert.equal(seen.out.finaleThesis, 'thesis C.');
});

test('2 approaches -> 2 drafts', { timeout: 20000 }, async () => {
  const seen = { drafts: [], tasks: {}, critiques: [], plans: 0 };
  await run(PLAN3.replace(/- Approach C[^\n]*\n/, ''), 'two', 'B', seen);
  assert.deepEqual([...new Set(seen.drafts)].sort(), ['A', 'B']);
  assert.equal(seen.out.masthead.title, 'Draft B');
});

test('plan with no approaches -> one story, two drafts of the same beats (old best-of)', { timeout: 20000 }, async () => {
  const seen = { drafts: [], tasks: {}, critiques: [], plans: 0 };
  await run('Thesis: T.\nBeat 1: plain.', 'none', 'A', seen);
  assert.deepEqual(seen.critiques, ['X']);
  assert.deepEqual([...new Set(seen.drafts)].sort(), ['A', 'B']);
  assert.match(seen.tasks.B, /story X/);
  assert.equal(seen.out[STORY].approach, undefined);
});
