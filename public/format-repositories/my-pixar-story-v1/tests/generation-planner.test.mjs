import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roleFor, crewRoles } from '../runtime/crew.mjs';
import { initialProject, taskFor } from '../runtime/workflow.mjs';
import { inputs, file, approved, reviewed, authored, send } from './helpers.mjs';

test("Max SKILL.md Muse image estimate matches studio.json configured rate", () => {
  const studioJson = JSON.parse(readFileSync(new URL('../studio.json', import.meta.url), 'utf8'));
  const skillText = readFileSync(new URL('../crew/max/SKILL.md', import.meta.url), 'utf8');
  const configuredRate = studioJson.generation.image.estimatedUnitCostUsd;

  const match = skillText.match(/Meta Muse images[^\n]*\$([0-9.]+)/);
  assert.ok(match, 'Meta Muse image dollar rate not found in Max SKILL.md');
  const skillRate = Number(match[1]);
  assert.equal(skillRate, configuredRate, `Muse rate in SKILL.md ($${skillRate}) differs from studio.json ($${configuredRate})`);
});

test("Max SKILL.md provider model ids match studio.json configured models", () => {
  const studioJson = JSON.parse(readFileSync(new URL('../studio.json', import.meta.url), 'utf8'));
  const skillText = readFileSync(new URL('../crew/max/SKILL.md', import.meta.url), 'utf8');

  // Verify Cartesia voice model bindings in Max's skill match studio.json
  const cartesiaModelMatches = [...skillText.matchAll(/"model":\s*"([^"]+)"/g)].map(m => m[1]);
  assert.ok(cartesiaModelMatches.length > 0, 'No model parameters found in Max SKILL.md');
  for (const modelId of cartesiaModelMatches) {
    assert.equal(
      modelId,
      studioJson.generation.voice.model,
      `Provider model in SKILL.md ("${modelId}") differs from studio.json voice model ("${studioJson.generation.voice.model}")`
    );
  }

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
