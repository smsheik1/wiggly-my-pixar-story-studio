// The target runtime is the maximum: RUNTIME_OVER_TARGET fires past target + 5s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateStoryDirectorOutput, runtimeTargetOf, RUNTIME_TOLERANCE_SEC } from '../crew/linter/check-stage-play.mjs';
import { parseStagePlay } from '../crew/story-director/schema.mjs';

const good = () => parseStagePlay(readFileSync(new URL('./fixtures/good-stage-play.json', import.meta.url), 'utf8'));
const total = (d) => d.segments.reduce((n, s) => n + s.shots.reduce((m, h) => Math.max(m, h.endSec), 0), 0);
const codes = (d, input) => validateStoryDirectorOutput(d, input).issues.filter((i) => i.severity === 'error').map((i) => i.code);

test('target: input.targetTotalRuntimeSec, else format.targetTotalSeconds, else 90', () => {
  assert.equal(runtimeTargetOf({}), 90); assert.equal(runtimeTargetOf({ format: { targetTotalSeconds: 60 } }), 60);
  assert.equal(runtimeTargetOf({ targetTotalRuntimeSec: 45, format: { targetTotalSeconds: 60 } }), 45); assert.equal(RUNTIME_TOLERANCE_SEC, 5);
});

test('over target + 5s fails; at target + 5s passes', () => {
  const d = good(), t = total(d);
  assert.ok(codes(d, { targetTotalRuntimeSec: t - 6 }).includes('RUNTIME_OVER_TARGET'));
  assert.ok(!codes(d, { targetTotalRuntimeSec: t - 5 }).includes('RUNTIME_OVER_TARGET'));
  assert.ok(!codes(d, {}).includes('RUNTIME_OVER_TARGET') || t > 95);
});
