import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initialProject, taskFor, current, pickOnly, gateConfig, dependencies, revisionImpact, characterPromptRecipeSha256 } from '../runtime/workflow.mjs';
import { StudioConfig, loadStudio } from '../runtime/instructions.mjs';
import { spendSummary } from '../runtime/budget.mjs';
import { generationEstimate } from '../runtime/providers.mjs';
import { openWorkflow } from '../runtime/workflow.mjs';
import { criteria, digest } from '../runtime/contracts.mjs';
import { inputs, questionnaire, send, reviewed, approved, file } from './helpers.mjs';
import { backgroundProject, registry, author, brief, prompt, image } from './background-helpers.mjs';
import { supervisedAudio, supervisedCharacters, supervisedBackgrounds, confirmed } from './supervised-helpers.mjs';
import { shotPlan } from './shot-helpers.mjs';
import { producerUpdate } from '../runtime/presentation.mjs';

function legacyBackgroundsLocked() {
  let p = supervisedCharacters();
  p = approved(reviewed(author(p, { ...registry, ...shotPlan }, 'shot-planner')));
  p = approved(reviewed(author(p, registry)));
  return p;
}
function passReview(p, workerId = 'sage') {
  const a = current(p);
  return send(p, 'review', { workerId, artifactId: a.id, artifactDigest: a.digest, review: { decision: 'approved', perception: 'direct-text', checks: taskFor(p).criteria.map((criterion) => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED', repair: '' })) } });
}
function toProduceBackgroundCandidates() {
  let p = legacyBackgroundsLocked();
  p.gatePolicy = 'pick-only';
  p = author(p, brief(p));
  p = passReview(p, 'sage');
  p = author(p, prompt(p), 'pixar-prompter');
  p = send(p, 'owner-review', { workerId: 'background-owner', artifactId: current(p).id, artifactDigest: current(p).digest, review: { decision: 'approved', perception: 'direct-text', checks: criteria[p.step].map((criterion) => ({ criterion, status: 'pass', evidence: 'ISOLATED', location: 'x', repair: '' })) } });
  p = passReview(p, 'sage');
  assert.equal(p.step, 'backgroundCandidates');
  assert.equal(p.gate, 'produce');
  return p;
}

test('1. legacy backgroundBrief still needs human approval', { timeout: 10000 }, () => {
  let p = backgroundProject();
  p = approved(reviewed(author(p, registry)));
  p = author(p, brief(p));
  const a = current(p);
  p = send(p, 'review', { workerId: 'sage', artifactId: a.id, artifactDigest: a.digest, review: { decision: 'approved', perception: 'direct-text', checks: taskFor(p).criteria.map((criterion) => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED', repair: '' })) } });
  assert.equal(p.gate, 'human');
});

test('2. pick-only backgroundBrief auto-locks after Sage approval', { timeout: 10000 }, () => {
  let p = legacyBackgroundsLocked();
  p.gatePolicy = 'pick-only';
  p = author(p, brief(p));
  assert.equal(p.gate, 'review');
  const a0 = current(p);
  p = send(p, 'review', { workerId: 'sage', artifactId: a0.id, artifactDigest: a0.digest, review: { decision: 'approved', perception: 'direct-text', checks: taskFor(p).criteria.map((criterion) => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED', repair: '' })) } });
  const b = p.artifacts.findLast((x) => x.key.startsWith('backgroundBrief'));
  assert.match(b.approvedBy.message, /^AUTO-LOCK/);
  assert.ok(p.history.some((h) => h.action === 'auto-lock' && h.actor === 'runtime' && h.artifactId === b.id));
  // The auto-lock is the latest recorded result (after the review), with a unique sequence, so the operator sees it.
  const last = p.history.at(-1), prev = p.history.at(-2);
  assert.equal(last.action, 'auto-lock'); assert.equal(prev.action, 'review'); assert.ok(last.sequence > prev.sequence);
  assert.match(producerUpdate({ project: p, pending: taskFor(p) }).completion.message, /locked after .*review; no approval needed from you/);
  assert.equal(p.step, 'backgroundPrompt');
  assert.notEqual(p.gate, 'human');
});

test('3. pick-only backgroundPrompt needs owner then auto-locks; non-owner still rejected', { timeout: 10000 }, () => {
  let p = legacyBackgroundsLocked();
  p.gatePolicy = 'pick-only';
  p = author(p, brief(p));
  p = passReview(p, 'sage');
  assert.equal(p.step, 'backgroundPrompt');
  p = author(p, prompt(p), 'pixar-prompter');
  assert.equal(p.gate, 'owner-review');
  assert.throws(() => send(p, 'owner-review', { workerId: 'sage', artifactId: current(p).id, artifactDigest: current(p).digest, review: { decision: 'approved', perception: 'direct-text', checks: criteria[p.step].map((criterion) => ({ criterion, status: 'pass', evidence: 'ISOLATED', location: 'x', repair: '' })) } }), /original owner check/);
  p = send(p, 'owner-review', { workerId: 'background-owner', artifactId: current(p).id, artifactDigest: current(p).digest, review: { decision: 'approved', perception: 'direct-text', checks: criteria[p.step].map((criterion) => ({ criterion, status: 'pass', evidence: 'ISOLATED', location: 'x', repair: '' })) } });
  assert.equal(p.gate, 'review');
  const a0 = current(p);
  p = send(p, 'review', { workerId: 'sage', artifactId: a0.id, artifactDigest: a0.digest, review: { decision: 'approved', perception: 'direct-text', checks: taskFor(p).criteria.map((criterion) => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED', repair: '' })) } });
  assert.match(p.artifacts.findLast((x) => x.key.startsWith('backgroundPrompt')).approvedBy.message, /^AUTO-LOCK/);
  assert.equal(p.step, 'backgroundCandidates');
  assert.equal(p.gate, 'produce');
});

test('4. provisional never auto-locks; rejected behaves as legacy', { timeout: 10000 }, () => {
  let p = legacyBackgroundsLocked();
  p.gatePolicy = 'pick-only';
  p = author(p, brief(p));
  const a0 = current(p);
  const prov = send(p, 'review', { workerId: 'sage', artifactId: a0.id, artifactDigest: a0.digest, review: { decision: 'provisional', perception: 'direct-text', checks: taskFor(p).criteria.map((criterion, i) => ({ criterion, status: i === 0 ? 'inconclusive' : 'pass', location: 'ISOLATED', evidence: 'ISOLATED', repair: '' })) } });
  assert.equal(prov.gate, 'human');
  let q = legacyBackgroundsLocked();
  q.gatePolicy = 'pick-only';
  q = author(q, brief(q));
  const b0 = current(q);
  const rej = send(q, 'review', { workerId: 'sage', artifactId: b0.id, artifactDigest: b0.digest, review: { decision: 'rejected', perception: 'direct-text', checks: taskFor(q).criteria.map((criterion, i) => ({ criterion, status: i === 0 ? 'fail' : 'pass', location: 'ISOLATED', evidence: 'ISOLATED', repair: i === 0 ? 'Fix it.' : '' })) } });
  assert.equal(rej.gate, 'author');
});

test('5. pick-only backgroundCandidates agy $0 auto-authorizes', { timeout: 10000 }, () => {
  let p = toProduceBackgroundCandidates();
  const promptText = current(p, `backgroundPrompt:${p.locationId}`).content.prompt;
  p = send(p, 'plan', { workerId: 'planner', plan: { provider: 'agy', operation: 'backgroundCandidates', estimatedCostUsd: 0, parameters: { prompt: promptText } } });
  const j = p.jobs.at(-1);
  assert.equal(j.status, 'authorized');
  assert.equal(p.gate, 'collect');
  assert.match(j.authorization.message, /^AUTO-AUTHORIZED/);
});

test('6. over-budget image plan stays planned without throwing', { timeout: 10000 }, () => {
  let p = toProduceBackgroundCandidates();
  const beforeReservations = JSON.stringify(p.budget.reservations);
  p.budget.maxCostUsd = spendSummary(p).totalReservedUsd;
  const promptText = current(p, `backgroundPrompt:${p.locationId}`).content.prompt;
  p = send(p, 'plan', { workerId: 'planner', plan: { provider: 'meta-muse', operation: 'backgroundCandidates', estimatedCostUsd: 0.05, parameters: { prompt: promptText } } });
  const j = p.jobs.at(-1);
  assert.equal(j.status, 'planned');
  assert.equal(p.gate, 'authorize');
  assert.equal(JSON.stringify(p.budget.reservations), beforeReservations);
});

test('7. attempt cap still enforced under pick-only', { timeout: 10000 }, () => {
  let p = toProduceBackgroundCandidates();
  const deps = JSON.parse(JSON.stringify(dependencies(p)));
  const key = `backgroundCandidates:${p.locationId}`;
  for (let i = 0; i < 3; i++) {
    p.jobs.push({ id: `job-fake-${i}`, key, plan: { provider: 'agy', operation: 'backgroundCandidates', estimatedCostUsd: 0, parameters: { prompt: 'x' } }, request: {}, dependencies: deps, digest: `fake-${i}`, status: 'failed' });
  }
  const promptText = current(p, `backgroundPrompt:${p.locationId}`).content.prompt;
  assert.throws(() => send(p, 'plan', { workerId: 'planner', plan: { provider: 'agy', operation: 'backgroundCandidates', estimatedCostUsd: 0, parameters: { prompt: promptText } } }), /ATTEMPT_LIMIT/);
});

test('8. video never auto-authorizes; schema rejects video', { timeout: 10000 }, async () => {
  const cfg = loadStudio().config;
  assert.throws(() => StudioConfig.parse({ ...cfg, gates: { defaultPolicy: 'pick-only', autoLockSteps: cfg.gates.autoLockSteps, autoAuthorizeOperations: ['video'] } }));
  assert.throws(() => StudioConfig.parse({ ...cfg, gates: { defaultPolicy: 'pick-only', autoLockSteps: cfg.gates.autoLockSteps, autoAuthorizeOperations: ['clone'] } }));
  let p = legacyBackgroundsLocked();
  p.gatePolicy = 'pick-only';
  assert.ok(!gateConfig(p).autoAuthorizeOperations.includes('video'));
});

test('9. media still needs human pick after Vera approval', { timeout: 10000 }, () => {
  let p = toProduceBackgroundCandidates();
  const promptText = current(p, `backgroundPrompt:${p.locationId}`).content.prompt;
  p = send(p, 'plan', { workerId: 'planner', plan: { provider: 'agy', operation: 'backgroundCandidates', estimatedCostUsd: 0, parameters: { prompt: promptText } } });
  p = send(p, 'begin', { jobId: p.jobs.at(-1).id, artifactDigest: p.jobs.at(-1).digest });
  p = send(p, 'receipt', { jobId: p.jobs.at(-1).id, artifactDigest: p.jobs.at(-1).digest, result: { files: [5, 6, 7].map(image), prompt: promptText } });
  assert.equal(p.gate, 'review');
  const a = current(p);
  p = send(p, 'review', { workerId: 'vera', artifactId: a.id, artifactDigest: a.digest, review: { decision: 'approved', perception: 'direct-image', modelVersion: 'm', capabilityVersion: 'c', checks: criteria.backgroundCandidates.map((criterion) => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED Vera pass' })), recommendation: { selection: 1, ranking: [1, 0, 2], reason: 'ISOLATED best.' }, toolEvidence: a.content.files.map((f) => ({ tool: 'viewImage', sha256: f.sha256 })) } });
  assert.equal(p.gate, 'human');
  p = send(p, 'approve', { artifactId: a.id, artifactDigest: a.digest, message: 'ISOLATED pick', selection: 1, humanReview: { decision: 'approved', perception: 'crew-review', checks: [] } });
  assert.ok(current(p, `backgroundCandidates:${p.locationId}`).approvedBy);
});

test('10. characterPrompt auto-locks, candidates auto-authorizes, pick stays human', { timeout: 10000 }, () => {
  let p = supervisedAudio();
  p.budget = { maxCostUsd: 100, reservations: [] };
  p.gatePolicy = 'pick-only';
  p = confirmed(p);
  p = send(p, 'artifact', { workerId: 'cast-owner', content: { characters: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', important: true, references: [image(1)], notes: 'ISOLATED' }] } });
  const r0 = current(p);
  p = send(p, 'review', { workerId: 'sage', artifactId: r0.id, artifactDigest: r0.digest, review: { decision: 'approved', perception: 'direct-text', checks: taskFor(p).criteria.map((criterion) => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED', repair: '' })) } });
  assert.equal(p.gate, 'human');
  p = send(p, 'approve', { artifactId: current(p).id, artifactDigest: current(p).digest, message: 'ISOLATED roster' });
  const cast = current(p, 'roster').content.characters[0];
  p.characterId = 'alex';
  p = send(p, 'artifact', { workerId: 'cast-owner', content: { prompt: 'character', characterDigest: digest(cast), referenceHashes: cast.references.map((f) => f.sha256), recipeSha256: characterPromptRecipeSha256 } });
  const cp = current(p);
  p = send(p, 'review', { workerId: 'sage', artifactId: cp.id, artifactDigest: cp.digest, review: { decision: 'approved', perception: 'direct-text', checks: taskFor(p).criteria.map((criterion) => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED', repair: '' })) } });
  assert.match(p.artifacts.findLast((x) => x.key === 'characterPrompt:alex').approvedBy.message, /^AUTO-LOCK/);
  assert.equal(p.step, 'candidates');
  p = send(p, 'plan', { workerId: 'planner', plan: { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, parameters: { prompt: 'character' } } });
  assert.equal(p.jobs.at(-1).status, 'authorized');
  assert.equal(p.gate, 'collect');
});

test('11. keyframePrompt auto-locks and keyframe auto-authorizes', { timeout: 10000 }, async () => {
  const { composition } = await import('./shot-helpers.mjs');
  let p = supervisedBackgrounds();
  p.gatePolicy = 'pick-only';
  p = author(p, shotPlan);
  p = passReview(p, 'sage');
  assert.match(p.artifacts.findLast((x) => x.key === 'shots').approvedBy.message, /^AUTO-LOCK/);
  assert.equal(p.step, 'keyframePrompt');
  p = author(p, composition(p), 'composition-writer');
  const a = current(p);
  p = send(p, 'review', { workerId: 'sage', artifactId: a.id, artifactDigest: a.digest, review: { decision: 'approved', perception: 'direct-text', checks: taskFor(p).criteria.map((criterion) => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED', repair: '' })) } });
  assert.match(p.artifacts.findLast((x) => x.key.startsWith('keyframePrompt')).approvedBy.message, /^AUTO-LOCK/);
  assert.equal(p.step, 'keyframe');
  assert.equal(p.gate, 'produce');
  const kp = current(p, `keyframePrompt:${p.shotId}`).content.prompt;
  p = send(p, 'plan', { workerId: 'planner', plan: { provider: 'agy', operation: 'keyframe', estimatedCostUsd: 0, parameters: { prompt: kp } } });
  assert.equal(p.jobs.at(-1).status, 'authorized');
  assert.match(p.jobs.at(-1).authorization.message, /^AUTO-AUTHORIZED/);
});

test('12. backgrounds registry auto-locks', { timeout: 10000 }, () => {
  let p = supervisedCharacters();
  p = approved(reviewed(author(p, { ...registry, ...shotPlan }, 'shot-planner')));
  p.gatePolicy = 'pick-only';
  p = author(p, registry);
  const a = current(p);
  p = send(p, 'review', { workerId: 'sage', artifactId: a.id, artifactDigest: a.digest, review: { decision: 'approved', perception: 'direct-text', checks: taskFor(p).criteria.map((criterion) => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED', repair: '' })) } });
  assert.match(p.artifacts.findLast((x) => x.key === 'backgrounds').approvedBy.message, /^AUTO-LOCK/);
});

test('13. answers script roster stay human; shots auto-locks', { timeout: 10000 }, () => {
  let p = initialProject('pick-only-13', inputs, { reviewMode: 'supervised', workflowRevision: 3, gatePolicy: 'pick-only' });
  p = send(p, 'artifact', { workerId: 'w', content: questionnaire(p) });
  const a0 = current(p);
  p = send(p, 'review', { workerId: 'sage', artifactId: a0.id, artifactDigest: a0.digest, review: { decision: 'approved', perception: 'direct-text', checks: taskFor(p).criteria.map((criterion) => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED', repair: '' })) } });
  assert.equal(p.gate, 'human');
  let q = supervisedBackgrounds();
  q.gatePolicy = 'pick-only';
  q.step = 'shots';
  q.gate = 'author';
  q = author(q, shotPlan);
  const s = current(q);
  q = send(q, 'review', { workerId: 'sage', artifactId: s.id, artifactDigest: s.digest, review: { decision: 'approved', perception: 'direct-text', checks: taskFor(q).criteria.map((criterion) => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED', repair: '' })) } });
  assert.match(q.artifacts.findLast((x) => x.key === 'shots').approvedBy.message, /^AUTO-LOCK/);
  let r = supervisedBackgrounds();
  r.gatePolicy = 'pick-only';
  r.step = 'shots';
  r.gate = 'author';
  r = author(r, shotPlan);
  const t0 = current(r);
  const prov = send(r, 'review', { workerId: 'sage', artifactId: t0.id, artifactDigest: t0.digest, review: { decision: 'provisional', perception: 'direct-text', checks: taskFor(r).criteria.map((criterion, i) => ({ criterion, status: i === 0 ? 'inconclusive' : 'pass', location: 'ISOLATED', evidence: 'ISOLATED', repair: '' })) } });
  assert.equal(prov.gate, 'human');
});

test('13b. narration and audition auto-authorize within budget; clone never', { timeout: 10000 }, () => {
  let p = supervisedAudio();
  p.budget = { maxCostUsd: 100, reservations: [] };
  p.gatePolicy = 'pick-only';
  p.step = 'audition';
  p.gate = 'produce';
  const est = generationEstimate(p).estimatedCostUsd;
  p = send(p, 'plan', { workerId: 'planner', plan: { provider: 'cartesia', operation: 'audition', estimatedCostUsd: est, parameters: {} } });
  assert.equal(p.jobs.at(-1).status, 'authorized');
  assert.match(p.jobs.at(-1).authorization.message, /^AUTO-AUTHORIZED/);
  assert.equal(p.gate, 'collect');
  let q = supervisedAudio();
  q.budget = { maxCostUsd: 100, reservations: [] };
  q.gatePolicy = 'pick-only';
  q.step = 'audition';
  q.gate = 'produce';
  const est2 = generationEstimate(q).estimatedCostUsd;
  q = send(q, 'plan', { workerId: 'planner', plan: { provider: 'cartesia', operation: 'audition', estimatedCostUsd: est2, parameters: {} } });
  assert.equal(q.jobs.at(-1).status, 'authorized');
  assert.throws(() => send(q, 'plan', { workerId: 'planner', plan: { provider: 'cartesia', operation: 'clone', estimatedCostUsd: 0.1, parameters: {} } }));
});

test('13c. narration regeneration auto-authorizes within budget', { timeout: 10000 }, () => {
  let p = supervisedAudio();
  p.budget = { maxCostUsd: 100, reservations: [] };
  p.gatePolicy = 'pick-only';
  p.step = 'narration';
  p.gate = 'produce';
  const est = generationEstimate(p, 'narration').estimatedCostUsd;
  p = send(p, 'plan', { workerId: 'planner', plan: { provider: 'cartesia', operation: 'narration', estimatedCostUsd: est, parameters: {} } });
  assert.equal(p.jobs.at(-1).status, 'authorized');
});

test('14. human changes reopens prompt and re-authored prompt auto-locks again', { timeout: 10000 }, () => {
  let p = toProduceBackgroundCandidates();
  const promptText = current(p, `backgroundPrompt:${p.locationId}`).content.prompt;
  p = send(p, 'plan', { workerId: 'planner', plan: { provider: 'agy', operation: 'backgroundCandidates', estimatedCostUsd: 0, parameters: { prompt: promptText } } });
  p = send(p, 'begin', { jobId: p.jobs.at(-1).id, artifactDigest: p.jobs.at(-1).digest });
  p = send(p, 'receipt', { jobId: p.jobs.at(-1).id, artifactDigest: p.jobs.at(-1).digest, result: { files: [5, 6, 7].map(image), prompt: promptText } });
  const cand = current(p);
  const impact = revisionImpact(p, cand.id);
  p = send(p, 'changes', { artifactId: cand.id, artifactDigest: cand.digest, message: 'ISOLATED human change', impactDigest: impact.impactDigest });
  assert.equal(p.step, 'backgroundBrief');
  p = author(p, brief(p));
  p = passReview(p, 'sage');
  assert.match(p.artifacts.findLast((x) => x.key.startsWith('backgroundBrief')).approvedBy.message, /^AUTO-LOCK/);
  assert.equal(p.step, 'backgroundPrompt');
  p = author(p, prompt(p), 'pixar-prompter');
  p = send(p, 'owner-review', { workerId: 'background-owner', artifactId: current(p).id, artifactDigest: current(p).digest, review: { decision: 'approved', perception: 'direct-text', checks: criteria[p.step].map((criterion) => ({ criterion, status: 'pass', evidence: 'ISOLATED', location: 'x', repair: '' })) } });
  p = passReview(p, 'sage');
  assert.match(p.artifacts.findLast((x) => x.key.startsWith('backgroundPrompt')).approvedBy.message, /^AUTO-LOCK/);
});

test('15. StudioConfig rejects bad gates; old snapshot without gates stays per-step', { timeout: 10000 }, () => {
  const cfg = loadStudio().config;
  assert.throws(() => StudioConfig.parse({ ...cfg, gates: { defaultPolicy: 'pick-only', autoLockSteps: ['script'], autoAuthorizeOperations: cfg.gates.autoAuthorizeOperations } }));
  assert.throws(() => StudioConfig.parse({ ...cfg, gates: { defaultPolicy: 'pick-only', autoLockSteps: cfg.gates.autoLockSteps, autoAuthorizeOperations: ['clone'] } }));
  assert.throws(() => StudioConfig.parse({ ...cfg, gates: { defaultPolicy: 'pick-only', autoLockSteps: cfg.gates.autoLockSteps, autoAuthorizeOperations: ['video'] } }));
  let p = initialProject('old-snap', inputs, { reviewMode: 'supervised', workflowRevision: 3 });
  delete p.studio.config.gates;
  p.studio.sha256 = digest({ config: p.studio.config, documents: p.studio.documents });
  p.gatePolicy = 'pick-only';
  assert.equal(pickOnly(p), true);
  assert.equal(gateConfig(p), undefined);
});

test('16. runner init records pick-only by default and per-step on request', { timeout: 30000 }, async (t) => {
  const kitRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const runner = join(kitRoot, 'runner.mjs');
  const example = join(kitRoot, 'examples', 'parent.json');
  const dir1 = await mkdtemp(join(tmpdir(), 'pick-only-init-'));
  t.after(async () => { await rm(dir1, { recursive: true, force: true }); });
  const r1 = spawnSync(process.execPath, [runner, 'init', example, '--run', dir1], { encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL' });
  assert.equal(r1.status, 0, r1.stderr);
  const w1 = openWorkflow(join(dir1, 'checkpoints.sqlite'));
  try {
    const s1 = await w1.status('project');
    assert.equal(s1.project.gatePolicy, 'pick-only');
  } finally { w1.close(); }
  const dir2 = await mkdtemp(join(tmpdir(), 'pick-only-init-'));
  t.after(async () => { await rm(dir2, { recursive: true, force: true }); });
  const r2 = spawnSync(process.execPath, [runner, 'init', example, '--run', dir2, '--gates', 'per-step'], { encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL' });
  assert.equal(r2.status, 0, r2.stderr);
  const w2 = openWorkflow(join(dir2, 'checkpoints.sqlite'));
  try {
    const s2 = await w2.status('project');
    assert.equal(s2.project.gatePolicy, 'per-step');
  } finally { w2.close(); }
});
