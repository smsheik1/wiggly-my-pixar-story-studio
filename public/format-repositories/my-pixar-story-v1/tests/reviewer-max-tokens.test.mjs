import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterHost, REVIEWER_VERDICT_MAX_TOKENS, OPENROUTER_MAX_TOKENS } from '../runtime/openrouter-host.mjs';
test('Ava on Gemini gets a verdict budget above the host default', () => {
  const host = new OpenRouterHost({ cwd: process.cwd(), secretsPath: '/nonexistent' });
  assert.ok(REVIEWER_VERDICT_MAX_TOKENS > OPENROUTER_MAX_TOKENS);
  assert.equal(host.maxTokensFor('google/gemini-3.8-flash'), REVIEWER_VERDICT_MAX_TOKENS);
});
