// Per-call usage log: every OpenRouter streaming call writes one calls.jsonl line; zero network (fake fetch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observingFetch } from '../graph/deep-agent-node.mjs';
import { configureCallLog, stepOf, summarizeCalls } from '../graph/call-log.mjs';
import { draftContext } from '../graph/best-of.mjs';

const SSE = [
  'data: {"id":"gen-123","provider":"Anthropic","choices":[{"delta":{"reasoning":"thinking"}}]}',
  'data: {"id":"gen-123","choices":[{"delta":{"content":"Hello"}}]}',
  'data: {"id":"gen-123","choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":300,"completion_tokens_details":{"reasoning_tokens":200},"prompt_tokens_details":{"cached_tokens":0},"cost":0.00042}}',
  'data: [DONE]', ''].join('\n\n');
const fake = async () => new Response(SSE, { headers: { 'content-type': 'text/event-stream' } });
const req = (system, user = 'x', extra = {}) => ({ method: 'POST', body: JSON.stringify({ model: 'anthropic/claude-haiku-5.5', reasoning: { effort: 'high' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], authorization: 'never logged', ...extra }) });

test('stepOf names the pipeline step from the request', () => {
  assert.equal(stepOf({ messages: [{ role: 'system', content: '# Beats (story first)' }] }), 'plan');
  assert.equal(stepOf({ messages: [{ role: 'system', content: '# Critique and rewrite the beats' }] }), 'beats-critique');
  assert.equal(stepOf({ messages: [{ role: 'system', content: 'You are reviewing your own draft' }] }), 'review');
  assert.equal(stepOf({ messages: [{ role: 'system', content: '# Pick Winner' }] }), 'best-of-judge');
  assert.equal(draftContext.run({ draftId: 'B' }, () => stepOf({ messages: [{ role: 'system', content: 'You are the Wiggly v2 story-director.' }, { role: 'user', content: 'go' }] })), 'draft B');
  assert.equal(stepOf({ messages: [{ role: 'system', content: 'You are the Wiggly v2 story-director.' }, { role: 'user', content: 'Revise your story-director draft (revision round 1 of 2).' }] }), 'rewrite');
});

test('every streamed call logs step, model, effort, times, TTFT, tokens, cost and generation id; body passes through; summary per step', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wiggly-calls-'));
  try {
    const file = join(dir, 'calls.jsonl');
    configureCallLog(file);
    const f = observingFetch('story-director', fake, () => {});
    for (const sys of ['# Beats (story first)', 'You are reviewing your own draft', 'You are reviewing your own draft']) {
      const res = await f('https://openrouter.ai/api/v1/chat/completions', req(sys));
      assert.equal(await res.text(), SSE);
    }
    configureCallLog(null);
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    const c = lines[0];
    assert.equal(c.step, 'plan'); assert.equal(c.model, 'anthropic/claude-haiku-5.5'); assert.equal(c.effort, 'high');
    assert.equal(c.promptTokens, 1200); assert.equal(c.completionTokens, 300); assert.equal(c.reasoningTokens, 200);
    assert.equal(c.costUsd, 0.00042); assert.equal(c.generationId, 'gen-123'); assert.equal(c.provider, 'Anthropic');
    assert.ok(Number.isFinite(c.ttftMs) && c.start && c.end && Number.isFinite(c.seconds));
    assert.ok(!JSON.stringify(lines).includes('never logged'), 'no request body or keys in the log');
    const sum = summarizeCalls(file);
    const review = sum.find((s) => s.step === 'review');
    assert.equal(review.calls, 2); assert.equal(review.promptTokens, 2400); assert.equal(review.costUsd, 0.00084);
  } finally { configureCallLog(null); await rm(dir, { recursive: true, force: true }); }
});

test('off by default: no file, the call still works', async () => {
  const res = await observingFetch('story-director', fake, () => {})('u', req('# Beats'));
  assert.equal(await res.text(), SSE);
});
