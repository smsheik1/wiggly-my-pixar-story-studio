import test from 'node:test';
import assert from 'node:assert/strict';
import { current, taskFor, applyEvent } from '../runtime/workflow.mjs';
import { crewRoles } from '../runtime/crew.mjs';
import { criteria } from '../runtime/contracts.mjs';
import { send, approved, reviewed } from './helpers.mjs';
import { backgroundProject, registry, author, brief, prompt } from './background-helpers.mjs';

// A prompt at owner-review whose brief author ('background-owner') was later
// replaced by an explicit crew rebind: the background-product-owner role is now
// bound to 'beau-rebound'. In real runs the history records the author's role.
function rebound(ids = {}) {
  let p = approved(reviewed(author(backgroundProject(), registry)));
  p = approved(reviewed(author(p, brief(p))));
  p = author(p, prompt(p), 'pixar-prompter');
  assert.equal(p.gate, 'owner-review');
  p = structuredClone(p);
  const b = current(p, `backgroundBrief:${p.locationId}`);
  p.history.findLast(h => h.action === 'artifact' && h.artifactId === b.id).worker = { workerId: 'background-owner', name: 'Beau', role: 'background-product-owner' };
  const id = role => ids[role] ?? ({ 'background-product-owner': 'beau-rebound', 'pixar-prompter': 'pixar-prompter', 'text-reviewer': 'sage' }[role] ?? `w-${role}`);
  p.crew = { workers: Object.keys(crewRoles).map(role => ({ workerId: id(role), name: crewRoles[role].name, role, modelVersion: 'm', capabilityVersion: 'c', execution: 'host' })) };
  return p;
}
const verdict = (p, workerId, action) => { const a = current(p); return send(p, action, { workerId, artifactId: a.id, artifactDigest: a.digest, review: { decision: 'approved', perception: 'direct-text', modelVersion: 'm', capabilityVersion: 'c', checks: criteria[p.step].map(criterion => ({ criterion, status: 'pass', evidence: 'Isolated evidenced fixture "An empty stylised 3D room".', location: 'prompt', repair: '' })) } }); };

test('after a crew rebind the worker now bound to the brief author role passes the owner check, and the packet names it', () => {
  const p = rebound();
  assert.equal(taskFor(p).ownerWorkerId, 'beau-rebound');
  const q = verdict(p, 'beau-rebound', 'owner-review');
  assert.equal(q.gate, 'review'); assert.equal(current(q).ownerReview.decision, 'approved');
});

test('an unrelated worker still cannot pass the owner check after a rebind', () => {
  const p = rebound();
  for (const other of ['sage', 'pixar-prompter', 'background-owner']) assert.throws(() => verdict(p, other, 'owner-review'), /CREW_PERMISSION_DENIED|original owner check/);
  // Gate level, independent of crew assignment: the owner is the role's bound worker only.
  const q = rebound({ 'background-product-owner': 'imposter' });
  q.history.findLast(h => h.action === 'artifact' && h.artifactId === current(q, `backgroundBrief:${q.locationId}`).id).worker.role = 'cast-designer';
  assert.throws(() => verdict(q, 'imposter', 'owner-review'), /original owner check/);
});

test('1. gate alone rejects the original author as independent reviewer', { timeout: 10000 }, () => {
  const p = verdict(rebound(), 'beau-rebound', 'owner-review');
  assert.equal(p.gate, 'review');
  const q = structuredClone(p);
  const textWorker = q.crew.workers.find((w) => w.role === 'text-reviewer');
  textWorker.workerId = 'background-owner';
  assert.throws(() => verdict(q, 'background-owner', 'review'), /original owner check followed by a distinct independent reviewer/);
});

test('2. gate alone rejects rebound owner when brief history has no recorded role', { timeout: 10000 }, () => {
  const p = rebound();
  const b = current(p, `backgroundBrief:${p.locationId}`);
  const h = p.history.findLast((x) => x.action === 'artifact' && x.artifactId === b.id);
  delete h.worker;
  p.crew = { workers: Object.keys(crewRoles).map((role) => ({ workerId: role === 'background-product-owner' ? 'beau-rebound' : role === 'pixar-prompter' ? 'pixar-prompter' : role === 'text-reviewer' ? 'sage' : `w-${role}`, name: crewRoles[role].name, role, modelVersion: 'm', capabilityVersion: 'c', execution: 'host' })) };
  assert.throws(() => verdict(p, 'beau-rebound', 'owner-review'), /original owner check/);
});

test('owner and independent reviewer must still be distinct workers after a rebind', () => {
  // The crew contract already forbids one worker holding two roles; the gate still refuses the rebound owner as reviewer.
  assert.throws(() => verdict(rebound({ 'text-reviewer': 'beau-rebound' }), 'beau-rebound', 'owner-review'), /distinct host worker/);
  const p = verdict(rebound(), 'beau-rebound', 'owner-review');
  assert.equal(p.gate, 'review');
  assert.throws(() => verdict(p, 'beau-rebound', 'review'), /CREW_PERMISSION_DENIED|distinct/);
  const ok = verdict(verdict(rebound(), 'beau-rebound', 'owner-review'), 'sage', 'review');
  assert.equal(ok.gate, 'human');
});
