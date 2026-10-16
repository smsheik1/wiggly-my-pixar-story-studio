import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { V2_MODELS } from '../config/models.mjs';

const agents = readdirSync(new URL('../crew/', import.meta.url), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
test('every v2 crew agent has a model entry', () => {
  assert.ok(agents.length >= 6);
  for (const a of agents) assert.ok(V2_MODELS[a], `missing model entry for ${a}`);
});
test('story director: OpenRouter Muse Spark 1.3 contributor at xhigh', () => {
  assert.deepEqual([V2_MODELS['story-director'].provider, V2_MODELS['story-director'].model, V2_MODELS['story-director'].effort],
    ['openrouter', 'meta/muse-spark-1.3-contributor', 'xhigh']);
});
test('every image step is Nano Banana 2.1 via Google Flow', () => {
  let n = 0;
  for (const [a, cfg] of Object.entries(V2_MODELS)) for (const [k, img] of Object.entries(cfg.imageSteps ?? {})) {
    n++; assert.equal(img.model, 'nano-banana-2.1', `${a}.${k}`); assert.equal(img.provider, 'google-flow', `${a}.${k}`);
  }
  assert.ok(n >= 3);
  for (const k of ['storyboard', 'character', 'location']) assert.ok(Object.values(V2_MODELS).some(c => c.imageSteps?.[k]), k);
});
test('video: Seedance 2.5 480p, not yet enabled', () => {
  const v = V2_MODELS['seedance-compiler'].video;
  assert.equal(v.model, 'bytedance/seedance-2.5'); assert.equal(v.resolution, '480p'); assert.equal(v.enabled, false);
});
import { loadSkill } from '../config/models.mjs';
test('downstreamAgents and maxTokens', () => {
  assert.deepEqual(V2_MODELS['story-director'].downstreamAgents, ['character-architect', 'location-scout']);
  for (const [a, c] of Object.entries(V2_MODELS)) {
    assert.ok(Array.isArray(c.downstreamAgents), a);
    for (const d of c.downstreamAgents) assert.ok(V2_MODELS[d], `${a} -> unknown ${d}`);
    assert.ok(Number.isInteger(c.maxTokens), a);
    if (c.kind === 'llm') assert.ok(c.maxTokens > 0, a);
  }
});
test('loadSkill reads role.md and throws clearly when missing', () => {
  assert.match(loadSkill('story-director'), /Story Director/);
  assert.throws(() => loadSkill('nobody'), /unknown v2 agent "nobody"/);
});
test('character architect: muse xhigh, Nano Banana sheets, feeds vera + compiler, contract files exist', async () => {
  const c = V2_MODELS['character-architect'];
  assert.deepEqual([c.provider, c.model, c.effort], ['openrouter', 'meta/muse-spark-1.3-contributor', 'xhigh']);
  assert.equal(c.imageSteps.character.model, 'nano-banana-2.1');
  assert.ok(c.downstreamAgents.includes('seedance-compiler') && c.downstreamAgents.includes('vera'));
  assert.deepEqual(c.targetEngines, { masterRender: 'nano-banana-2.1', modelSheet: 'nano-banana-2.1' });
  const { existsSync } = await import('node:fs');
  for (const f of Object.values(c.contract)) assert.ok(existsSync(new URL('../' + f, import.meta.url)), f);
});
test('location scout: muse xhigh, Nano Banana plates, parallel with CA, feeds compiler, contract files exist', async () => {
  const c = V2_MODELS['location-scout'];
  assert.deepEqual([c.provider, c.model, c.effort], ['openrouter', 'meta/muse-spark-1.3-contributor', 'xhigh']);
  assert.equal(c.imageSteps.location.model, 'nano-banana-2.1');
  assert.deepEqual(c.targetEngines, { plate: 'nano-banana-2.1' });
  assert.ok(c.downstreamAgents.includes('seedance-compiler'));
  assert.deepEqual(c.parallelWith, ['character-architect']);
  const { existsSync } = await import('node:fs');
  for (const f of Object.values(c.contract)) assert.ok(existsSync(new URL('../' + f, import.meta.url)), f);
});
test('location scout: Gemini role label, 32000 tokens (8192 truncated xhigh reasoning), loadLocationScoutSkill', async () => {
  const { loadLocationScoutSkill } = await import('../config/models.mjs');
  const c = V2_MODELS['location-scout'];
  assert.equal(c.role, 'Location Scout & Environment Plate Architect'); assert.equal(c.maxTokens, 32000);
  assert.deepEqual(c.downstreamAgents, ['vera', 'seedance-compiler']);
  assert.match(loadLocationScoutSkill(), /Location Scout & Environment Plate Architect/);
});
test('seedance compiler: muse xhigh, Seedance 2.5 480p disabled, upstream CA + LS, downstream vera, contract files exist', async () => {
  const c = V2_MODELS['seedance-compiler'];
  assert.deepEqual([c.provider, c.model, c.effort], ['openrouter', 'meta/muse-spark-1.3-contributor', 'xhigh']);
  assert.deepEqual([c.video.model, c.video.resolution, c.video.enabled], ['bytedance/seedance-2.5', '480p', false]);
  assert.deepEqual(c.targetEngines, { video: 'seedance-2.5' }); assert.equal(c.segmentMaxSec, 30); assert.equal(c.continuation, 'extend');
  assert.deepEqual(c.upstreamAgents, ['character-architect', 'location-scout']);
  assert.ok(c.downstreamAgents.includes('vera'));
  for (const u of c.upstreamAgents) assert.ok(V2_MODELS[u].downstreamAgents.includes('seedance-compiler'), u);
  const { existsSync } = await import('node:fs');
  for (const f of Object.values(c.contract)) assert.ok(existsSync(new URL('../' + f, import.meta.url)), f);
  assert.match(loadSkill('seedance-compiler'), /Seedance Compiler/);
});
