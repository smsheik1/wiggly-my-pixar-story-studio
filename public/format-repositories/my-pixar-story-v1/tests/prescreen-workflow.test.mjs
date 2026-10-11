import test from 'node:test';
import assert from 'node:assert/strict';
import { taskFor, current, crewReviewEligible, criteriaFor } from '../runtime/workflow.mjs';
import { criteria, digest } from '../runtime/contracts.mjs';
import { send, reviewed, approved } from './helpers.mjs';
import { backgroundProject, registry, author, brief, prompt, image } from './background-helpers.mjs';
import { supervisedCharacters } from './supervised-helpers.mjs';
import { shotPlan } from './shot-helpers.mjs';
import { spendSummary } from '../runtime/budget.mjs';

function bgReview() {
  let p = supervisedCharacters();
  p = approved(reviewed(author(p, { ...registry, ...shotPlan }, 'shot-planner')));
  p = approved(reviewed(author(p, registry)));
  p = approved(reviewed(author(p, brief(p))));
  p = author(p, prompt(p), 'pixar-prompter');
  p = send(p, 'owner-review', { workerId: 'background-owner', artifactId: current(p).id, artifactDigest: current(p).digest, review: { decision: 'approved', perception: 'direct-text', checks: criteria[p.step].map((criterion) => ({ criterion, status: 'pass', evidence: 'ISOLATED', location: 'x', repair: '' })) } });
  p = send(p, 'review', { workerId: 'sage', artifactId: current(p).id, artifactDigest: current(p).digest, review: { decision: 'approved', perception: 'direct-text', checks: taskFor(p).criteria.map((criterion) => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED', repair: '' })) } });
  p = send(p, 'approve', { artifactId: current(p).id, artifactDigest: current(p).digest, message: 'ISOLATED prompt' });
  const promptText = current(p, `backgroundPrompt:${p.locationId}`).content.prompt;
  let q = send(p, 'plan', { workerId: 'planner', plan: { provider: 'meta-muse', operation: p.step, estimatedCostUsd: 0.05, parameters: { prompt: promptText } } });
  if (q.gate === 'authorize') { const j = q.jobs.at(-1); q = send(q, 'authorize', { jobId: j.id, artifactDigest: j.digest, message: 'ISOLATED auth' }); }
  const jj = q.jobs.at(-1);
  q = send(q, 'begin', { jobId: jj.id, artifactDigest: jj.digest });
  q = send(q, 'receipt', { jobId: jj.id, artifactDigest: jj.digest, result: { files: [5, 6, 7].map(image), prompt: promptText } });
  return q;
}

function enablePrescreen(p, opts = {}) {
  p = structuredClone(p);
  p.studio.config.prescreen = { enabled: true, provider: 'openrouter-decisions', model: 'openai/gpt-6-luna-decisions', steps: ['candidates', 'backgroundCandidates', 'backgroundAngle', 'keyframe'], passAbove: 0.9, failBelow: 0.4, maxPerArtifact: 1, estimatedCostUsdPerCall: 0.002, ...opts };
  p.studio.sha256 = digest({ config: p.studio.config, documents: p.studio.documents });
  p.budget = p.budget ?? { maxCostUsd: 0, reservations: [] };
  if ((p.budget.maxCostUsd ?? 0) < 1) p.budget.maxCostUsd = 100;
  return p;
}

function prescreenFixture(p, { model, verdict = 'pass', ranking = [2, 0, 1], missCriterion = null, failOne = false } = {}) {
  const a = current(p);
  const files = a.content.files;
  const crit = criteria[p.step] ?? criteria.backgroundCandidates;
  const cfgModel = model ?? p.studio.config.prescreen.model;
  const at = new Date().toISOString();
  const presFiles = files.map((f, idx) => {
    let checks = [...crit, 'no-text'].map((criterion) => ({ criterion, question: `Is ${criterion} good?`, probability: 0.95, status: 'pass' }));
    if (missCriterion && idx === 0) checks = checks.filter((c) => c.criterion !== missCriterion);
    if (failOne && idx === 0) checks[0] = { ...checks[0], probability: 0.1, status: 'fail' };
    let v = 'pass';
    if (checks.some((c) => c.status === 'fail')) v = 'fail';
    else if (checks.some((c) => c.status !== 'pass')) v = 'uncertain';
    return { index: idx, sha256: f.sha256, verdict: v, checks };
  });
  return { provider: 'openrouter-decisions', model: cfgModel, servedModel: cfgModel, verdict, files: presFiles, ranking, rankingConfidence: ranking ? 0.85 : null, thresholds: { passAbove: 0.9, failBelow: 0.4 }, usage: { requests: 1, inputTokens: 1000, costUsd: 0.001, estimatedCostUsd: 0.002 }, at };
}

test('1. prescreen disabled throws PRESCREEN_DISABLED', { timeout: 10000 }, () => {
  const p = bgReview();
  assert.equal(p.gate, 'review');
  const pre = prescreenFixture(p);
  assert.throws(() => send(p, 'prescreen', { actor: 'runtime', artifactId: current(p).id, artifactDigest: current(p).digest, message: 'Decisions prescreen', prescreen: pre }), /PRESCREEN_DISABLED/);
});

test('2. clear pass on backgroundCandidates goes human with ranking and crew-review pick locks', { timeout: 10000 }, () => {
  let p = enablePrescreen(bgReview());
  const pre = prescreenFixture(p, { verdict: 'pass', ranking: [2, 0, 1] });
  p = send(p, 'prescreen', { actor: 'runtime', artifactId: current(p).id, artifactDigest: current(p).digest, message: 'Decisions prescreen', prescreen: pre });
  assert.equal(p.gate, 'human');
  assert.equal(current(p).review.decision, 'approved');
  assert.deepEqual(current(p).review.recommendation.ranking, [2, 0, 1]);
  assert.equal(crewReviewEligible(p), true);
  const a = current(p);
  const loc = p.locationId;
  p = send(p, 'approve', { artifactId: a.id, artifactDigest: a.digest, message: 'ISOLATED pick', selection: 0, humanReview: { decision: 'approved', perception: 'crew-review', checks: [] } });
  assert.ok(p.artifacts.find((x) => x.key === `backgroundCandidates:${loc}` && x.approvedBy));
});

test('3. pass missing one criterion stays at review with prescreen visible', { timeout: 10000 }, () => {
  let p = enablePrescreen(bgReview());
  const miss = criteria.backgroundCandidates[0];
  const pre = prescreenFixture(p, { verdict: 'pass', ranking: [2, 0, 1], missCriterion: miss });
  p = send(p, 'prescreen', { actor: 'runtime', artifactId: current(p).id, artifactDigest: current(p).digest, message: 'Decisions prescreen', prescreen: pre });
  assert.equal(p.gate, 'review');
  assert.ok(current(p).prescreen);
  assert.ok(taskFor(p).prescreen);
});

test('4. fail stays review; Vera rejected routes to produce; second prescreen already recorded', { timeout: 10000 }, () => {
  let q = backgroundProject();
  q = approved(reviewed(author(q, registry)));
  q = approved(reviewed(author(q, brief(q))));
  q = author(q, prompt(q), 'pixar-prompter');
  q = send(q, 'owner-review', { workerId: 'background-owner', artifactId: current(q).id, artifactDigest: current(q).digest, review: { decision: 'approved', perception: 'direct-text', checks: criteria[q.step].map((criterion) => ({ criterion, status: 'pass', evidence: 'ISOLATED', location: 'x', repair: '' })) } });
  q = send(q, 'review', { workerId: 'sage', artifactId: current(q).id, artifactDigest: current(q).digest, review: { decision: 'approved', perception: 'direct-text', checks: taskFor(q).criteria.map((criterion) => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED', repair: '' })) } });
  q = send(q, 'approve', { artifactId: current(q).id, artifactDigest: current(q).digest, message: 'ISOLATED prompt' });
  const promptText = current(q, `backgroundPrompt:${q.locationId}`).content.prompt;
  let r = send(q, 'plan', { workerId: 'planner', plan: { provider: 'meta-muse', operation: q.step, estimatedCostUsd: 0.05, parameters: { prompt: promptText } } });
  if (r.gate === 'authorize') { const j = r.jobs.at(-1); r = send(r, 'authorize', { jobId: j.id, artifactDigest: j.digest, message: 'ISOLATED' }); }
  const jj = r.jobs.at(-1);
  r = send(r, 'begin', { jobId: jj.id, artifactDigest: jj.digest });
  r = send(r, 'receipt', { jobId: jj.id, artifactDigest: jj.digest, result: { files: [5, 6, 7].map(image), prompt: promptText } });
  let p = enablePrescreen(r);
  const pre = prescreenFixture(p, { verdict: 'fail', ranking: [0, 1, 2], failOne: true });
  p = send(p, 'prescreen', { actor: 'runtime', artifactId: current(p).id, artifactDigest: current(p).digest, message: 'Decisions prescreen', prescreen: pre });
  assert.equal(p.gate, 'review');
  const pre2 = prescreenFixture(p, { verdict: 'fail', ranking: [0, 1, 2], failOne: true });
  assert.throws(() => send(p, 'prescreen', { actor: 'runtime', artifactId: current(p).id, artifactDigest: current(p).digest, message: 'Decisions prescreen', prescreen: pre2 }), /PRESCREEN_ALREADY_RECORDED/);
  const a = current(p);
  p = send(p, 'review', { workerId: 'vera', artifactId: a.id, artifactDigest: a.digest, review: { decision: 'rejected', perception: 'direct-image', modelVersion: 'm', capabilityVersion: 'c', checks: criteria.backgroundCandidates.map((criterion, i) => ({ criterion, status: i === 0 ? 'fail' : 'pass', location: 'ISOLATED', evidence: 'ISOLATED', repair: i === 0 ? 'Fix.' : '' })), toolEvidence: a.content.files.map((f) => ({ tool: 'viewImage', sha256: f.sha256 })) } });
  assert.equal(p.gate, 'produce');
});

test('5. bad actor digest step and sha all throw PRESCREEN_*', { timeout: 10000 }, () => {
  const p = enablePrescreen(bgReview());
  const good = prescreenFixture(p);
  const a = current(p);
  assert.throws(() => send(p, 'prescreen', { actor: 'agent', workerId: 'x', artifactId: a.id, artifactDigest: a.digest, message: 'x', prescreen: good }));
  assert.throws(() => send(p, 'prescreen', { actor: 'human', artifactId: a.id, artifactDigest: a.digest, message: 'x', prescreen: good }));
  assert.throws(() => send(p, 'prescreen', { actor: 'runtime', artifactId: a.id, artifactDigest: '0'.repeat(64), message: 'x', prescreen: good }), /PRESCREEN/);
  const badSha = structuredClone(good);
  badSha.files[0].sha256 = 'f'.repeat(64);
  assert.throws(() => send(p, 'prescreen', { actor: 'runtime', artifactId: a.id, artifactDigest: a.digest, message: 'x', prescreen: badSha }), /PRESCREEN_FILES_MISMATCH/);
  const v = structuredClone(p);
  v.step = 'video';
  v.gate = 'review';
  assert.throws(() => send(v, 'prescreen', { actor: 'runtime', artifactId: a.id, artifactDigest: a.digest, message: 'x', prescreen: good }));
  const n = structuredClone(p);
  n.step = 'narration';
  n.gate = 'review';
  assert.throws(() => send(n, 'prescreen', { actor: 'runtime', artifactId: a.id, artifactDigest: a.digest, message: 'x', prescreen: good }), /PRESCREEN_STEP/);
});

test('6. cost reservation recorded; over-budget throws with no state change', { timeout: 10000 }, () => {
  let p = enablePrescreen(bgReview());
  const beforeRes = p.budget.reservations.length;
  const pre = prescreenFixture(p);
  p = send(p, 'prescreen', { actor: 'runtime', artifactId: current(p).id, artifactDigest: current(p).digest, message: 'Decisions prescreen', prescreen: pre });
  assert.equal(p.budget.reservations.length, beforeRes + 1);
  assert.match(p.budget.reservations.at(-1).id, /^prescreen:/);
  const q0 = enablePrescreen(bgReview());
  q0.budget.maxCostUsd = spendSummary(q0).totalReservedUsd;
  const snap = JSON.stringify(q0);
  const pre2 = prescreenFixture(q0);
  assert.throws(() => send(q0, 'prescreen', { actor: 'runtime', artifactId: current(q0).id, artifactDigest: current(q0).digest, message: 'Decisions prescreen', prescreen: pre2 }), /PROJECT_BUDGET_EXCEEDED/);
  assert.equal(JSON.stringify(q0), snap);
});

test('7. keyframe one-file clear pass goes human with no recommendation', { timeout: 10000 }, async () => {
  const { generated } = await import('./shot-helpers.mjs');
  let p = generated();
  p = enablePrescreen(p);
  const a = current(p);
  assert.equal(a.content.files.length, 1);
  const crit = criteria.keyframe;
  const pre = { provider: 'openrouter-decisions', model: p.studio.config.prescreen.model, servedModel: p.studio.config.prescreen.model, verdict: 'pass', files: [{ index: 0, sha256: a.content.files[0].sha256, verdict: 'pass', checks: [...crit, 'no-text'].map((criterion) => ({ criterion, question: `Is ${criterion} good?`, probability: 0.96, status: 'pass' })) }], ranking: null, rankingConfidence: null, thresholds: { passAbove: 0.9, failBelow: 0.4 }, usage: { requests: 1, inputTokens: 500, costUsd: 0.001, estimatedCostUsd: 0.002 }, at: new Date().toISOString() };
  p = send(p, 'prescreen', { actor: 'runtime', artifactId: a.id, artifactDigest: a.digest, message: 'Decisions prescreen', prescreen: pre });
  assert.equal(p.gate, 'human');
  assert.equal(current(p).review.decision, 'approved');
  assert.equal(current(p).review.recommendation, undefined);
});

test('8. configurable model accepted; mismatch throws PRESCREEN_MODEL_MISMATCH', { timeout: 10000 }, () => {
  let p = enablePrescreen(bgReview(), { model: 'cloudflare/clef-flash' });
  const pre = prescreenFixture(p, { model: 'cloudflare/clef-flash', verdict: 'pass', ranking: [1, 0, 2] });
  p = send(p, 'prescreen', { actor: 'runtime', artifactId: current(p).id, artifactDigest: current(p).digest, message: 'Decisions prescreen', prescreen: pre });
  assert.equal(p.gate, 'human');
  const q = enablePrescreen(bgReview(), { model: 'cloudflare/clef-flash' });
  const bad = prescreenFixture(q, { model: 'openai/gpt-6-luna-decisions' });
  assert.throws(() => send(q, 'prescreen', { actor: 'runtime', artifactId: current(q).id, artifactDigest: current(q).digest, message: 'Decisions prescreen', prescreen: bad }), /PRESCREEN_MODEL_MISMATCH/);
});
