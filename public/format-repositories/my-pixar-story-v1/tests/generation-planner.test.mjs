import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roleFor, crewRoles } from '../runtime/crew.mjs';
import { initialProject, taskFor } from '../runtime/workflow.mjs';
import { requestDescriptor } from '../runtime/providers.mjs';
import { requireBudget, spendSummary } from '../runtime/budget.mjs';
import { imageUnitCostFor } from '../runtime/instructions.mjs';
import { inputs, file, approved, reviewed, authored, send } from './helpers.mjs';

test("Max SKILL.md Muse image estimate matches studio.json configured rate", () => {
  const studioJson = JSON.parse(readFileSync(new URL('../studio.json', import.meta.url), 'utf8'));
  const skillText = readFileSync(new URL('../crew/max/SKILL.md', import.meta.url), 'utf8');
  const configuredRate = studioJson.generation.image.metaMuseEstimatedUnitCostUsd ?? studioJson.generation.image.estimatedUnitCostUsd;

  const match = skillText.match(/\$([0-9.]+) for meta-muse/);
  assert.ok(match, 'Meta Muse image dollar rate not found in Max SKILL.md');
  const skillRate = Number(match[1]);
  assert.equal(skillRate, configuredRate, `Muse rate in SKILL.md ($${skillRate}) differs from studio.json ($${configuredRate})`);

  assert.equal(studioJson.generation.image.agyEstimatedUnitCostUsd, 0, 'agy rate must be $0 in studio.json');
  assert.match(skillText, /\$0 for agy/, 'agy $0 rate not found in Max SKILL.md');
});

test('agy images cost $0 end to end while meta-muse costs $0.01 per image', () => {
  const studioJson = JSON.parse(readFileSync(new URL('../studio.json', import.meta.url), 'utf8'));
  assert.equal(studioJson.generation.image.agyEstimatedUnitCostUsd, 0);
  assert.equal(studioJson.generation.image.metaMuseEstimatedUnitCostUsd ?? studioJson.generation.image.estimatedUnitCostUsd, 0.01);
  const p = initialProject('image-costs', inputs, { reviewMode: 'supervised' });
  p.characterId = 'alex';
  p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [{ path: '/isolated-test/ref.png', sha256: file().sha256, bytes: 100, width: 1600, height: 900 }] }] } });
  assert.equal(imageUnitCostFor(p, 'agy'), 0);
  assert.equal(imageUnitCostFor(p, 'meta-muse'), 0.01);
  // plan estimate + cost check: agy $0 passes, muse needs $0.01 x n (n=3 candidates)
  const agyReq = requestDescriptor(p, { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, parameters: { prompt: 'ISOLATED sheet prompt' } });
  assert.equal(agyReq.n, 3);
  assert.equal(agyReq.estimatedUnitCostUsd, 0);
  const museReq = requestDescriptor(p, { provider: 'meta-muse', operation: 'candidates', estimatedCostUsd: 0.03, parameters: { prompt: 'ISOLATED sheet prompt' } });
  assert.equal(museReq.n, 3);
  assert.throws(() => requestDescriptor(p, { provider: 'meta-muse', operation: 'candidates', estimatedCostUsd: 0.02, parameters: { prompt: 'ISOLATED sheet prompt' } }), /every requested image/);
  // budget/spend accounting: $0 needs no budget, $0.03 exceeds the default zero budget
  requireBudget(p, 0);
  assert.throws(() => requireBudget(p, 0.03), /PROJECT_BUDGET_EXCEEDED/);
  // job record: an authorized agy job reserves $0
  p.jobs.push({ id: 'job-1', key: 'candidates:alex', plan: { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, parameters: { prompt: 'ISOLATED sheet prompt' } }, request: agyReq, dependencies: [], digest: 'isolated-cost', status: 'authorized', authorization: { message: 'ISOLATED', at: new Date().toISOString() } });
  assert.equal(spendSummary(p).generationReservedUsd, 0);
  assert.equal(spendSummary(p).totalReservedUsd, 0);
});

test("Max SKILL.md provider model ids match studio.json configured models", () => {
  const studioJson = JSON.parse(readFileSync(new URL('../studio.json', import.meta.url), 'utf8'));
  const skillText = readFileSync(new URL('../crew/max/SKILL.md', import.meta.url), 'utf8');

  // The approved skill carries no model ids: model/cartesiaVersion must equal
  // the studio's pinned values, so the planner leaves them out.
  assert.doesNotMatch(skillText, /"model":\s*"/, 'Max SKILL.md must not pin provider model ids');
  assert.match(skillText, /must equal the studio's pinned values, so leave them out/, 'Max SKILL.md must defer model ids to the studio pinned values');

  assert.equal(
    skillText.includes('sonic-preview'),
    false,
    'Max SKILL.md must not reference stale "sonic-preview"'
  );
});

test('failed generation job recovery routes re-planning to generation-planner', () => {
  const crew = {
    workers: Object.keys(crewRoles).map(role => ({
      workerId: `host-${role}`,
      name: crewRoles[role].name,
      role,
      modelVersion: 'isolated-test-host',
      capabilityVersion: 'isolated-tools-v1',
      execution: 'host',
    })),
  };

  let p = approved(reviewed(authored(initialProject('recovery-routing', inputs, { reviewMode: 'qualified' }))));
  p = send(p, 'configure-crew', { actor: 'human', message: 'ISOLATED crew configuration', crew });
  p = send(p, 'artifact', { actor: 'human', workerId: 'human', content: { files: [file()], consent: true, language: 'en' } });

  assert.equal(p.step, 'clone');
  assert.equal(p.gate, 'produce');
  assert.equal(roleFor(p), 'generation-planner');

  const max = p.crew.workers.find(w => w.role === 'generation-planner');
  const writer = p.crew.workers.find(w => w.role === 'script-writer');

  p = send(p, 'plan', { workerId: max.workerId, plan: { provider: 'cartesia', operation: 'clone', estimatedCostUsd: 0.1, parameters: {} } });
  let job = p.jobs[0];
  p = send(p, 'authorize', { jobId: job.id, artifactDigest: job.digest, message: 'ISOLATED authorize' });
  job = p.jobs[0];
  p = send(p, 'begin', { jobId: job.id, artifactDigest: job.digest });
  job = p.jobs[0];
  p = send(p, 'provider-error', { jobId: job.id, artifactDigest: job.digest, message: 'Provider timeout; outcome uncertain' });
  assert.equal(p.gate, 'escalate');
  assert.equal(p.jobs[0].status, 'uncertain');

  p = send(p, 'reconcile', {
    jobId: job.id,
    artifactDigest: job.digest,
    message: 'Confirmed provider failure; re-plan generation.',
    result: { outcome: 'confirmed-no-result' },
  });

  assert.equal(p.jobs[0].status, 'failed');
  assert.equal(p.gate, 'produce');
  assert.equal(roleFor(p), 'generation-planner');

  const task = taskFor(p);
  assert.equal(task.formatRole, 'generation-planner');
  assert.equal(task.crewWorker.role, 'generation-planner');
  assert.equal(task.crewWorker.name, 'Max');

  assert.throws(
    () => send(p, 'plan', { workerId: writer.workerId, plan: { provider: 'cartesia', operation: 'clone', estimatedCostUsd: 0.1, parameters: {} } }),
    /CREW_PERMISSION_DENIED/
  );

  p = send(p, 'plan', { workerId: max.workerId, plan: { provider: 'cartesia', operation: 'clone', estimatedCostUsd: 0.1, parameters: {} } });
  assert.equal(p.jobs.length, 2);
  assert.equal(p.jobs[0].status, 'failed');
  assert.equal(p.jobs[1].status, 'planned');
  assert.equal(p.gate, 'authorize');
});
