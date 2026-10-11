import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenRouterHost, DEFAULT_OPENROUTER_MODEL, OPENROUTER_MAX_CONTINUATIONS } from '../runtime/openrouter-host.mjs';

const secretsFor = async (dir, key = 'ISOLATED-OPENROUTER-KEY') => {
  const p = join(dir, 'secrets.env');
  await writeFile(p, `OPENROUTER_API_KEY=${key}\n`);
  return p;
};
const scriptTask = { step: 'script', taskId: 'isolated-task', actor: 'agent', gate: 'author', workflowRevision: 2 };
const scriptEvent = { taskId: 'isolated-task', actor: 'agent', workerId: 'openrouter:text-reviewer:test', action: 'artifact', content: { beats: [] } };
const workerFor = cap => ({ workerId: 'openrouter:text-reviewer:test', name: 'Sage', role: 'text-reviewer', modelVersion: DEFAULT_OPENROUTER_MODEL, capabilityVersion: cap, backend: 'openrouter' });
const okChoice = (model, content, finish = 'stop', extra = {}) => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => ({ model, usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 }, choices: [{ finish_reason: finish, ...extra, message: { role: 'assistant', content } }] }),
});

test('1. truncated once continues, stitches, runTask parses Event, usage counts both', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'or-cont-1-'));
  try {
    const secretsPath = await secretsFor(dir);
    const full = JSON.stringify({ eventJson: JSON.stringify(scriptEvent) });
    const half = full.slice(0, Math.floor(full.length / 2));
    const rest = full.slice(half.length);
    const bodies = [];
    const ends = [];
    let n = 0;
    const host = new OpenRouterHost({ cwd: dir, secretsPath, tracer: { turn: () => ({ end: o => ends.push(o) }), tool: () => ({ end() {} }) }, fetcher: async (url, init) => {
      bodies.push(JSON.parse(init.body)); n++;
      if (n === 1) return okChoice(DEFAULT_OPENROUTER_MODEL, half, 'length');
      return okChoice(DEFAULT_OPENROUTER_MODEL, rest, 'stop');
    } });
    const worker = workerFor(await host.profile());
    const event = await host.runTask(scriptTask, { worker, callTool: async () => { throw new Error('no tools needed'); } });
    assert.equal(event.action, 'artifact');
    assert.equal(n, 2);
    assert.equal(bodies.length, 2);
    const second = bodies[1];
    const msgs = second.messages;
    assert.ok(msgs.some(m => m.role === 'assistant' && m.content === half), '2nd body keeps the partial assistant content');
    assert.ok(msgs.some(m => m.role === 'user' && /cut off by the output limit|Continue EXACTLY/.test(String(m.content))), '2nd body has the continue instruction');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].usage.requests, 2, 'usage counted for both requests');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('2. reasoning ate the budget (empty content) still continues and succeeds', { timeout: 20000 }, async () => {
  for (const empty of ['', null]) {
    const dir = await mkdtemp(join(tmpdir(), 'or-cont-2-'));
    try {
      const secretsPath = await secretsFor(dir);
      const full = JSON.stringify({ eventJson: JSON.stringify(scriptEvent) });
      let n = 0;
      const bodies = [];
      const host = new OpenRouterHost({ cwd: dir, secretsPath, fetcher: async (url, init) => {
        bodies.push(JSON.parse(init.body)); n++;
        if (n === 1) return okChoice(DEFAULT_OPENROUTER_MODEL, empty, 'length');
        return okChoice(DEFAULT_OPENROUTER_MODEL, full, 'stop');
      } });
      const worker = workerFor(await host.profile());
      const event = await host.runTask(scriptTask, { worker, callTool: async () => { throw new Error('no tools'); } });
      assert.equal(event.action, 'artifact', `empty=${JSON.stringify(empty)}`);
      assert.equal(n, 2);
      assert.ok(bodies[1].messages.some(m => m.role === 'user' && /empty|cut off/i.test(String(m.content))));
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('3. truncated 3 times rejects OUTPUT_TRUNCATED, never JSON errors, exact request count', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'or-cont-3-'));
  try {
    const secretsPath = await secretsFor(dir);
    let n = 0;
    const host = new OpenRouterHost({ cwd: dir, secretsPath, fetcher: async () => {
      n++;
      return okChoice(DEFAULT_OPENROUTER_MODEL, '{"eventJson":"partial', 'length');
    } });
    const worker = workerFor(await host.profile());
    await assert.rejects(host.runTask(scriptTask, { worker, callTool: async () => {} }), e => {
      assert.match(e.message, /OUTPUT_TRUNCATED/);
      assert.doesNotMatch(e.message, /not valid JSON|Unexpected token|SyntaxError/);
      assert.equal(e.outputTruncated, true);
      return true;
    });
    assert.equal(n, 1 + OPENROUTER_MAX_CONTINUATIONS);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('4. native_finish_reason MAX_TOKENS with null finish_reason is truncation', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'or-cont-4-'));
  try {
    const secretsPath = await secretsFor(dir);
    const full = JSON.stringify({ eventJson: JSON.stringify(scriptEvent) });
    const half = full.slice(0, Math.floor(full.length / 2));
    const rest = full.slice(half.length);
    let n = 0;
    const host = new OpenRouterHost({ cwd: dir, secretsPath, fetcher: async () => {
      n++;
      if (n === 1) return okChoice(DEFAULT_OPENROUTER_MODEL, half, null, { native_finish_reason: 'MAX_TOKENS' });
      return okChoice(DEFAULT_OPENROUTER_MODEL, rest, 'stop');
    } });
    const msg = await host.chat({ model: DEFAULT_OPENROUTER_MODEL, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(msg.content, half + rest);
    assert.equal(n, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('5. non-truncated turn is byte-identical to the previous shape (max_tokens per model)', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'or-cont-5-'));
  try {
    const secretsPath = await secretsFor(dir);
    for (const [model, maxTokens] of [['meta/muse-spark-1.3-contributor', 32000], ['deepseek/deepseek-v4.1-flash', 16000]]) {
      const bodies = [];
      const host = new OpenRouterHost({ cwd: dir, secretsPath, fetcher: async (url, init) => {
        bodies.push(JSON.parse(init.body));
        return okChoice(model, JSON.stringify({ eventJson: JSON.stringify(scriptEvent) }), 'stop');
      } });
      await host.chat({ model, messages: [{ role: 'user', content: 'hi' }], tools: host.toolDefinition() });
      assert.equal(bodies.length, 1);
      const body = bodies[0];
      assert.equal(body.max_tokens, maxTokens, model);
      assert.equal(body.model, model);
      assert.equal(body.response_format.type, 'json_schema');
      assert.equal(body.provider.require_parameters, true);
      assert.deepEqual(body.provider.max_price, { prompt: 0.3, completion: 1.2 });
      assert.ok(body.reasoning && (body.reasoning.effort || body.reasoning.enabled !== undefined));
      // No continuation markers on a normal turn.
      assert.ok(!JSON.stringify(body.messages).includes('cut off by the output limit'));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('6. cassette round trip records a truncated+continued turn; replay matches with no network', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'or-cont-6-'));
  try {
    const secretsPath = await secretsFor(dir);
    const full = JSON.stringify({ eventJson: JSON.stringify(scriptEvent) });
    const half = full.slice(0, Math.floor(full.length / 2));
    const rest = full.slice(half.length);
    const { Cassette, recordingFetcher, replayFetcher } = await import('../runtime/cassette.mjs');
    const { recorderFetcher } = await import('../evaluation/dept-evals.mjs');
    // Record with the cassette recordingFetcher around a fake network.
    let n = 0;
    const fakeNet = async () => {
      n++;
      const content = n === 1 ? half : rest;
      const finish = n === 1 ? 'length' : 'stop';
      return new Response(JSON.stringify({ model: DEFAULT_OPENROUTER_MODEL, usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 }, choices: [{ finish_reason: finish, message: { role: 'assistant', content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const cassetteDir = join(dir, 'cas');
    const cassette = await Cassette.create(cassetteDir, { type: 'header', version: 1 }, { secrets: [] });
    const host1 = new OpenRouterHost({ cwd: dir, secretsPath, fetcher: recordingFetcher(cassette, 'openrouter', fakeNet) });
    const worker = workerFor(await host1.profile());
    const event1 = await host1.runTask(scriptTask, { worker, callTool: async () => { throw new Error('no tools'); } });
    assert.equal(event1.action, 'artifact');
    assert.equal(n, 2);
    // Replay with no network: any fetch call throws.
    const play = await Cassette.open(cassetteDir, { secrets: [] });
    const noNet = async () => { throw new Error('network must not be used in replay'); };
    void noNet;
    const host2 = new OpenRouterHost({ cwd: dir, secretsPath, fetcher: replayFetcher(play, 'openrouter') });
    const worker2 = workerFor(await host2.profile());
    // profileOverride not needed: same code path, same bodies.
    const event2 = await host2.runTask(scriptTask, { worker: worker2, callTool: async () => { throw new Error('no tools'); } });
    assert.deepEqual(event2, event1);
    play.assertFullyConsumed();
    // dept-evals recorderFetcher records one entry per request including continuations.
    const entries = [];
    let m = 0;
    const fake2 = async () => {
      m++;
      const content = m === 1 ? half : rest;
      const finish = m === 1 ? 'length' : 'stop';
      return new Response(JSON.stringify({ model: DEFAULT_OPENROUTER_MODEL, usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 }, choices: [{ finish_reason: finish, message: { role: 'assistant', content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const host3 = new OpenRouterHost({ cwd: dir, secretsPath, fetcher: recorderFetcher(fake2, entries) });
    const event3 = await host3.runTask(scriptTask, { worker: workerFor(await host3.profile()), callTool: async () => { throw new Error('no tools'); } });
    assert.equal(event3.action, 'artifact');
    assert.equal(entries.length, 2, 'one recording entry per request including the continuation');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('7. truncated tool_calls are never executed; continuation recovers as text', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'or-cont-7-'));
  try {
    const secretsPath = await secretsFor(dir);
    const full = JSON.stringify({ eventJson: JSON.stringify(scriptEvent) });
    let n = 0;
    const bodies = [];
    const host = new OpenRouterHost({ cwd: dir, secretsPath, fetcher: async (url, init) => {
      bodies.push(JSON.parse(init.body)); n++;
      if (n === 1) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: DEFAULT_OPENROUTER_MODEL, usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0001 }, choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '', tool_calls: [{ id: 'partial-1', type: 'function', function: { name: 'wiggly_tool', arguments: '{"name":"readAsset",' } }] } }] }) };
      }
      return okChoice(DEFAULT_OPENROUTER_MODEL, full, 'stop');
    } });
    let toolRan = false;
    const worker = workerFor(await host.profile());
    const event = await host.runTask(scriptTask, { worker, callTool: async () => { toolRan = true; throw new Error('must not run partial tools'); } });
    assert.equal(event.action, 'artifact');
    assert.equal(toolRan, false, 'partial tool_calls are dropped, never executed');
    assert.equal(n, 2);
    assert.ok(bodies[1].messages.some(m => m.role === 'user' && /cut off|empty/i.test(String(m.content))));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
