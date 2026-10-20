// r5-dry4: long Story Director calls were cut mid-stream ("Network connection lost") and each drop failed the whole
// attempt. Now one dropped call is retried on its own (up to 2 times), the escalation says what really happened, and
// the heartbeat sees reasoning chunks and provider keepalives. Scripted models and fake fetch only: zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { deepAgentInvoke, REFLECTION, withCallRetry, CALL_RETRIES, sseActivity, observingFetch } from '../graph/deep-agent-node.mjs';
import { isStreamDrop, FATAL_CODE } from '../graph/provider-errors.mjs';
import { escalationReason } from '../graph/graph.mjs';
import { createLiveness, noteStreamActivity } from '../graph/liveness.mjs';

class ScriptedModel extends BaseChatModel {
  constructor(script) { super({}); this.modelName = 'isolated-scripted-model'; this.script = script; this.calls = []; }
  getName() { return 'ChatOpenAI'; }
  _llmType() { return 'isolated-scripted-test'; }
  bindTools() { return this; }
  async _generate(messages) { this.calls.push(messages); const step = this.script.shift(); assert.ok(step, 'model called after expected termination'); return { generations: [{ text: '', message: step(messages) }] }; }
}
const call = (name, args) => new AIMessage({ content: '', tool_calls: [{ name, args, id: name + Math.random().toString(36).slice(2, 7), type: 'tool_call' }] });
const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const drop = () => { throw new Error('Network connection lost.'); };
async function tmp(run) { const d = await mkdtemp(join(tmpdir(), 'wiggly-v2-drop-')); try { await run(d); } finally { await rm(d, { recursive: true, force: true }); } }
const SD = { model: 'isolated-scripted-model' };
const fast = { delayMs: 1 };

test('stream drops are recognised; timeouts, aborts, key limits and gate problems are not', () => {
  for (const m of ['Network connection lost.', 'terminated', 'read ECONNRESET', 'socket hang up', 'fetch failed', '502 Bad Gateway', 'other side closed']) assert.ok(isStreamDrop(new Error(m)), m);
  assert.ok(isStreamDrop(Object.assign(new Error('terminated'), { cause: { code: 'UND_ERR_SOCKET' } })));
  assert.ok(!isStreamDrop(Object.assign(new Error('model call timed out (no activity for 900s)'), { code: 'MODEL_TIMEOUT' })));
  assert.ok(!isStreamDrop(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  assert.ok(!isStreamDrop(Object.assign(new Error('403 Key limit exceeded'), { status: 403 })));
  assert.ok(!isStreamDrop({ code: FATAL_CODE, message: 'Network connection lost' }));
  assert.ok(!isStreamDrop(new Error('SUBMISSION REJECTED: segments.0 required')));
});

test('withCallRetry: retries only the dropped call, at most CALL_RETRIES times; other errors throw at once', async () => {
  assert.equal(CALL_RETRIES, 2);
  let n = 0; const seen = [];
  assert.equal(await withCallRetry(async () => { if (n++ < 2) drop(); return 'ok'; }, { ...fast, onRetry: (_e, k) => seen.push(k) }), 'ok');
  assert.deepEqual(seen, [1, 2]); assert.equal(n, 3);
  n = 0; await assert.rejects(withCallRetry(async () => { n++; drop(); }, fast), /Network connection lost/); assert.equal(n, 3, '1 call + 2 retries, then the error goes up');
  n = 0; await assert.rejects(withCallRetry(async () => { n++; throw new Error('bad schema'); }, fast), /bad schema/); assert.equal(n, 1);
  const ac = new AbortController(); ac.abort(new Error('stopped'));
  n = 0; await assert.rejects(withCallRetry(async () => { n++; drop(); }, { ...fast, signal: ac.signal })); assert.equal(n, 1, 'no retry once the run is aborted');
});

test('deep agent run: a draft call that drops is retried in place; the attempt does not fail or restart', () => tmp(async (runs) => {
  const m = new ScriptedModel([drop, drop, () => call('submit_story_director', json('good-stage-play.json'))]);
  const out = await deepAgentInvoke({ finalReview: false, createModel: async () => m, runsRoot: runs, runId: 'drop', callRetry: fast })({ agent: 'story-director', config: { ...SD, reflectionRounds: 0 }, input: {}, attempt: 1 });
  assert.equal(m.calls.length, 3, 'same run: 2 dropped calls + the one that submitted');
  assert.equal(out.masthead.title, json('good-stage-play.json').masthead.title);
}));

test('deep agent run: three drops in a row still fail that attempt (the node retry/escalation then applies)', () => tmp(async (runs) => {
  const m = new ScriptedModel([drop, drop, drop]);
  await assert.rejects(deepAgentInvoke({ finalReview: false, createModel: async () => m, runsRoot: runs, runId: 'drop3', callRetry: fast })({ agent: 'story-director', config: { ...SD, reflectionRounds: 0 }, input: {}, attempt: 1 }), /Network connection lost/);
  assert.equal(m.calls.length, 3);
}));

test('review round: a dropped critique call is retried; the round goes on', () => tmp(async (runs) => {
  const d = json('good-stage-play.json');
  const m = new ScriptedModel([() => call('submit_story_director', d), drop, () => new AIMessage('R1 Fidelity: PASS\nFIXES:\n\nVERDICT: SHIP')]);
  const out = await deepAgentInvoke({ finalReview: false, createModel: async () => m, runsRoot: runs, runId: 'cdrop', callRetry: fast })({ agent: 'story-director', config: { ...SD, reflectionRounds: 1 }, input: {}, attempt: 1, gate: () => ({ issues: [] }) });
  assert.equal(m.calls.length, 3); assert.equal(out[REFLECTION].log[0].verdict, 'SHIP');
}));

test('escalation: a network drop is not reported as a gate failure', () => {
  assert.equal(escalationReason([{ severity: 'error', code: 'PRESENT_NEVER_SEEN', message: 'x' }], 3), 'failed the gate 3 times');
  assert.match(escalationReason([{ severity: 'error', code: 'AGENT_RUN_FAILED', message: 'model call failed: Network connection lost.' }], 3), /kept dropping \(network\/stream error\) on all 3 attempts; not a gate failure/);
  assert.match(escalationReason([{ severity: 'error', code: 'MODEL_TIMEOUT', message: 'model call failed: timed out' }], 3), /^model call failed on all 3 attempts; not a gate failure/);
});

test('heartbeat: keepalives and reasoning deltas in the raw stream are counted; a thinking call does not look stalled', async () => {
  assert.deepEqual(sseActivity(': OPENROUTER PROCESSING\n\n: OPENROUTER PROCESSING\ndata: {"choices":[{"delta":{"reasoning":"Let me plan"}}]}\ndata: {"choices":[{"delta":{"content":"Hi"}}]}\n'), { keepalives: 2, reasoning: 1 });
  assert.deepEqual(sseActivity('data: {"choices":[{"delta":{"reasoning":null,"content":"x"}}]}\n'), { keepalives: 0, reasoning: 0 });
  // observingFetch passes the body through untouched and reports what it saw
  const body = ': OPENROUTER PROCESSING\n\ndata: {"choices":[{"delta":{"reasoning":"hmm"}}]}\n\ndata: [DONE]\n\n';
  const seen = [];
  const f = observingFetch('story-director', async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }), (a, x) => seen.push([a, x]));
  assert.equal(await (await f('u', {})).text(), body);
  assert.deepEqual(seen, [['story-director', { keepalives: 1, reasoning: 1 }]]);
  const plain = observingFetch('x', async () => new Response('{"a":1}', { headers: { 'content-type': 'application/json' } }), () => assert.fail('json is not observed'));
  assert.equal(await (await plain('u')).text(), '{"a":1}');
  // liveness: reasoning counts as activity (phase thinking); keepalives show the provider is alive without faking tokens
  let t = 0; const L = createLiveness({ now: () => t, stallMs: 90_000 });
  const e = L.begin('story-director', 1);
  t = 120_000; noteStreamActivity('story-director', { keepalives: 3 });
  assert.equal(e.tokens, 0); assert.equal(e.lastActivity, 0, 'keepalives alone are not model output');
  assert.match(L.line(e), /provider alive 0s ago/); assert.ok(!/STALLED/.test(L.line(e)), 'provider still alive: not flagged as stalled');
  t = 150_000; noteStreamActivity('story-director', { reasoning: 40 });
  assert.equal(e.phase, 'thinking'); assert.equal(e.lastActivity, 150_000); assert.match(L.line(e), /40 reasoning chunks/);
  t = 400_000; assert.match(L.line(e), /STALLED\?/, 'no keepalive and no output for minutes: stalled');
  noteStreamActivity('location-scout', { reasoning: 5 }); assert.equal(e.reasoningChunks, 40, 'other agents do not count');
  L.end('story-director', 1);
});
