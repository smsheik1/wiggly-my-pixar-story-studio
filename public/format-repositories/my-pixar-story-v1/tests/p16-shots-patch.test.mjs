// P16 run 1 scope A: supervised Phase 2 `shots` is a staging patch merged into the
// locked intentions. Invented fixtures only. No network, no providers, no real codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import { current, taskFor } from '../runtime/workflow.mjs';
import { digest } from '../runtime/contracts.mjs';
import { buildWorkerPacket } from '../runtime/crew.mjs';
import { reviewed, approved } from './helpers.mjs';
import { author } from './background-helpers.mjs';
import { shotsProject } from './shot-helpers.mjs';
import { supervisedBackgrounds } from './supervised-helpers.mjs';
import { shotPlan } from './shot-helpers.mjs';

// Hard safety: network calls prohibited
globalThis.fetch = () => { throw new Error('FETCH_PROHIBITED: Network calls are forbidden in p16-shots-patch.test.mjs.'); };

const T = { timeout: 20000 };
const worker = { workerId: 'w-sam', name: 'Sam', role: 'shot-planner', modelVersion: 'm1', capabilityVersion: 'c1', execution: 'host' };
const patchFrom = (p, staging) => ({ shots: current(p, 'shotIntentions').content.shots.map(s => ({ id: s.id, staging: staging ?? `Staged ${s.id} against the locked plate.`, continuityNotes: `Continuity for ${s.id}.` })) });

test('valid patch merges into the locked intentions and stores a full shots artifact', T, () => {
  const p = supervisedBackgrounds();
  assert.equal(p.step, 'shots');
  const q = approved(reviewed(author(p, patchFrom(p), 'shot-planner')));
  assert.equal(q.step, 'keyframePrompt');
  const merged = current(q, 'shots').content.shots, intents = current(q, 'shotIntentions').content.shots;
  assert.equal(merged.length, intents.length);
  for (const [i, shot] of merged.entries()) {
    for (const key of ['id', 'sceneId', 'locationId', 'angleId', 'beat', 'startSeconds', 'durationSeconds', 'characterIds', 'camera', 'action']) assert.deepEqual(shot[key], intents[i][key], key);
    assert.match(shot.staging, /Staged/);
  }
  assert.ok(current(q, 'shots').dependencies.includes(current(q, 'shotIntentions').id));
});

test('wrong count is rejected with SHOTS_PATCH_COUNT', T, () => {
  const p = supervisedBackgrounds(), patch = patchFrom(p);
  assert.throws(() => author(p, { shots: patch.shots.slice(1) }, 'shot-planner'), /SHOTS_PATCH_COUNT/);
});

test('wrong order is rejected with SHOTS_PATCH_ORDER', T, () => {
  const p = supervisedBackgrounds(), patch = patchFrom(p);
  assert.throws(() => author(p, { shots: [...patch.shots.slice(1), patch.shots[0]] }, 'shot-planner'), /SHOTS_PATCH_ORDER/);
});

test('unknown id is rejected with SHOTS_PATCH_UNKNOWN_ID', T, () => {
  const p = supervisedBackgrounds(), patch = patchFrom(p);
  const bad = patch.shots.map(s => ({ ...s }));
  bad[0] = { ...bad[0], id: 'nope-not-a-shot' };
  assert.throws(() => author(p, { shots: bad }, 'shot-planner'), /SHOTS_PATCH_UNKNOWN_ID/);
});

test('extra fields are rejected with SHOTS_PATCH_EXTRA_FIELD', T, () => {
  const p = supervisedBackgrounds();
  assert.throws(() => author(p, structuredClone(shotPlan), 'shot-planner'), /SHOTS_PATCH_EXTRA_FIELD/);
  const patch = patchFrom(p), bad = patch.shots.map(s => ({ ...s, camera: 'Invented camera move.' }));
  assert.throws(() => author(p, { shots: bad }, 'shot-planner'), /SHOTS_PATCH_EXTRA_FIELD/);
});

test('merged artifact digest is stable: the same patch twice gives the same digest', T, () => {
  const a = supervisedBackgrounds(), b = supervisedBackgrounds();
  const pa = approved(reviewed(author(a, patchFrom(a, 'Same staging words.'), 'shot-planner')));
  const pb = approved(reviewed(author(b, patchFrom(b, 'Same staging words.'), 'shot-planner')));
  assert.equal(current(pa, 'shots').digest, current(pb, 'shots').digest);
  assert.equal(current(pa, 'shots').digest, digest(current(pa, 'shots').content));
});

test('non-supervised mode still accepts the full shots object', T, () => {
  const p = shotsProject();
  assert.equal(p.step, 'shots');
  assert.equal(p.reviewMode, 'qualified');
  const q = author(p, structuredClone(shotPlan), 'shot-planner');
  assert.equal(q.gate, 'review');
  assert.equal(current(q, 'shots').content.shots.length, shotPlan.shots.length);
  assert.equal(current(q, 'shots').content.shots[0].action, shotPlan.shots[0].action);
});

test('the worker packet sends Sam the patch schema for supervised shots', T, () => {
  const p = supervisedBackgrounds();
  const packet = JSON.parse(buildWorkerPacket(taskFor(p), worker));
  assert.deepEqual(Object.keys(packet.contentSchema.properties.shots.items.properties).sort(), ['continuityNotes', 'id', 'staging']);
  assert.ok(!('sceneId' in packet.contentSchema.properties.shots.items.properties));
  const q = supervisedBackgrounds();
  q.reviewMode = 'qualified';
  const full = JSON.parse(buildWorkerPacket(taskFor(q), worker));
  assert.ok('sceneId' in full.contentSchema.properties.shots.items.properties);
});
