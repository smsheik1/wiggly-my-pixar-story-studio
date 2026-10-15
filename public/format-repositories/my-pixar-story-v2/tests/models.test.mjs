import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { V2_MODELS } from '../config/models.mjs';

const agents = readdirSync(new URL('../crew/', import.meta.url), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
test('every v2 crew agent has a model entry', () => {
  assert.ok(agents.length >= 6);
  for (const a of agents) assert.ok(V2_MODELS[a], `missing model entry for ${a}`);
});
test('story director: OpenRouter Muse Spark 1.3 contributor at max', () => {
  assert.deepEqual([V2_MODELS['story-director'].provider, V2_MODELS['story-director'].model, V2_MODELS['story-director'].effort],
    ['openrouter', 'meta/muse-spark-1.3-contributor', 'max']);
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
