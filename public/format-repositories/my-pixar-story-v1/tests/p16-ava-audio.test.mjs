// P16 run 1 scope D: Ava (audio-reviewer) is bound to an audio-capable model.
// Offline only: committed allowlist + mock fetcher, never a live model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStudio } from '../runtime/instructions.mjs';
import { OpenRouterHost, OPENROUTER_MAX_TOKENS, MUSE_MAX_TOKENS, modelTraits, AUDIO_CAPABLE_OPENROUTER_MODELS } from '../runtime/openrouter-host.mjs';

// Hard safety: network calls prohibited
globalThis.fetch = () => { throw new Error('FETCH_PROHIBITED: Network calls are forbidden in p16-ava-audio.test.mjs.'); };

const T = { timeout: 20000 };
const AVA_MODEL = loadStudio().config.agents['audio-reviewer'].model;

test("Ava's configured model is in the committed audio-capable allowlist", T, () => {
  assert.equal(loadStudio().config.agents['audio-reviewer'].backend, 'openrouter');
  assert.ok(AUDIO_CAPABLE_OPENROUTER_MODELS.includes(AVA_MODEL), `${AVA_MODEL} must be allowlisted for audio input`);
  assert.ok(modelTraits(AVA_MODEL).inputs.includes('audio'), 'Ava traits must include audio input');
  assert.ok(!modelTraits('meta/muse-spark-1.3-contributor').inputs.includes('audio'), 'Muse Spark must stay audio-incapable');
});

test('Ava model never inherits Muse-only production overrides', T, () => {
  assert.equal(modelTraits(AVA_MODEL).productionEffort, undefined);
  assert.equal(modelTraits(AVA_MODEL).maxTokens, undefined);
  const host = new OpenRouterHost({ cwd: '/tmp', fetcher: async () => { throw new Error('no network'); } });
  assert.equal(host.effortFor(AVA_MODEL), 'medium');
  assert.equal(host.maxTokensFor(AVA_MODEL), OPENROUTER_MAX_TOKENS);
  assert.ok(host.maxTokensFor(AVA_MODEL) < MUSE_MAX_TOKENS);
});

test('Ava request body is sane: medium effort, default cap, exact model', T, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p16-ava-body-'));
  try {
    const secretsPath = join(dir, 'secrets.env');
    await writeFile(secretsPath, 'OPENROUTER_API_KEY=test-key\n');
    const bodies = [];
    const host = new OpenRouterHost({ cwd: dir, secretsPath, fetcher: async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: AVA_MODEL, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }] }) }; } });
    await host.chat({ model: AVA_MODEL, messages: [{ role: 'user', content: 'ping' }], verify: true });
    assert.equal(bodies[0].model, AVA_MODEL);
    assert.ok(bodies[0].max_tokens <= 16 * 1024);
    assert.ok(!bodies[0].reasoning || bodies[0].reasoning.effort !== 'xhigh');
  } finally { await rm(dir, { recursive: true }); }
});
