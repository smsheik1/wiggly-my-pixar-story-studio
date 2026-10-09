import test from 'node:test';
import assert from 'node:assert/strict';
import { current, countsTowardAttemptCap } from '../runtime/workflow.mjs';
import { send } from './helpers.mjs';
import { image } from './background-helpers.mjs';
import { promptLocked, generated } from './shot-helpers.mjs';

function keyframePlan(p) {
  return { provider: 'meta-muse', operation: 'keyframe', estimatedCostUsd: 0.05, parameters: { prompt: current(p, `keyframePrompt:${p.shotId}`).content.prompt } };
}
function keyframeResult(p) {
  return { files: [image(20)], prompt: current(p, `keyframePrompt:${p.shotId}`).content.prompt };
}
function failJob(p, outcome) {
  p = send(p, 'plan', { plan: keyframePlan(p) });
  let j = p.jobs.at(-1);
  p = send(p, 'authorize', { jobId: j.id, artifactDigest: j.digest, message: 'ISOLATED TEST request authorization' });
  j = p.jobs.at(-1);
  p = send(p, 'begin', { jobId: j.id, artifactDigest: j.digest });
  j = p.jobs.at(-1);
  p = send(p, 'provider-error', { jobId: j.id, artifactDigest: j.digest, message: 'ISOLATED provider failure' });
  j = p.jobs.find(x => x.id === j.id);
  return send(p, 'reconcile', { jobId: j.id, artifactDigest: j.digest, message: 'ISOLATED confirmed provider outcome', result: { outcome } });
}
function deliverJob(p) {
  p = send(p, 'plan', { plan: keyframePlan(p) });
  let j = p.jobs.at(-1);
  p = send(p, 'authorize', { jobId: j.id, artifactDigest: j.digest, message: 'ISOLATED TEST request authorization' });
  j = p.jobs.at(-1);
  p = send(p, 'begin', { jobId: j.id, artifactDigest: j.digest });
  j = p.jobs.at(-1);
  return send(p, 'receipt', { jobId: j.id, artifactDigest: j.digest, result: keyframeResult(p) });
}
function revisePrompt(p) {
  const a = current(p);
  p = send(p, 'changes', { artifactId: a.id, artifactDigest: a.digest, message: 'ISOLATED TEST revise prompt direction' });
  return promptLocked(p);
}

test('provider-failed confirmed-no-result jobs do not block a revised keyframe plan', () => {
  let p = promptLocked();
  p = failJob(p, 'confirmed-no-result');
  p = failJob(p, 'confirmed-no-result');
  assert.equal(p.jobs.filter(j => j.status === 'failed').length, 2);
  p = deliverJob(p);
  assert.equal(p.jobs.at(-1).status, 'ready');
  p = revisePrompt(p);
  const before = p.jobs.length;
  p = send(p, 'plan', { plan: keyframePlan(p) });
  assert.equal(p.jobs.length, before + 1);
  assert.equal(p.gate, 'authorize');
});

test('three delivered keyframe jobs still hit the attempt cap', () => {
  let p = promptLocked();
  for (let i = 0; i < 3; i++) {
    p = generated(p);
    const a = current(p);
    p = send(p, 'changes', { artifactId: a.id, artifactDigest: a.digest, message: 'ISOLATED TEST adjust pose' });
    p = promptLocked(p);
  }
  assert.throws(() => generated(p), /ATTEMPT_LIMIT/);
});

test('no-evidence no-result and unusable-result jobs still count toward the cap', () => {
  let p = promptLocked();
  p = failJob(p, 'confirmed-no-result');
  const noEvidenceId = p.jobs.at(-1).id;
  p.history = p.history.filter(h => !(h.action === 'provider-error' && h.jobId === noEvidenceId));
  p = failJob(p, 'confirmed-unusable-result');
  p = deliverJob(p);
  p = revisePrompt(p);
  assert.throws(() => send(p, 'plan', { plan: keyframePlan(p) }), /ATTEMPT_LIMIT/);
});

test('countsTowardAttemptCap unit: uncertain and ready count, only evidenced no-result without delivery is excluded', () => {
  const p = { history: [{ action: 'provider-error', jobId: 'job-1' }] };
  assert.equal(countsTowardAttemptCap(p, { status: 'uncertain', id: 'job-9' }), true);
  assert.equal(countsTowardAttemptCap(p, { status: 'ready', id: 'job-9' }), true);
  assert.equal(countsTowardAttemptCap(p, { status: 'failed', id: 'job-1', reconciliation: { outcome: 'confirmed-no-result' } }), false);
  assert.equal(countsTowardAttemptCap({ history: [] }, { status: 'failed', id: 'job-1', reconciliation: { outcome: 'confirmed-no-result' } }), true);
  assert.equal(countsTowardAttemptCap(p, { status: 'failed', id: 'job-1', reconciliation: { outcome: 'confirmed-unusable-result' } }), true);
  assert.equal(countsTowardAttemptCap(p, { status: 'failed', id: 'job-1', reconciliation: { outcome: 'confirmed-no-result' }, result: { files: [] } }), true);
});
