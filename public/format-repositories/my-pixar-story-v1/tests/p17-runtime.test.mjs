// P17 run 1: runtime wiring for SPEC 1, 5, 7, 13, 15. Invented fixtures only.
// No network, no providers, no real codex, no child processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialProject, taskFor, current, applyEvent } from '../runtime/workflow.mjs';
import { crewRoles, runCrewTask, prepareCrewTask } from '../runtime/crew.mjs';
import { Content, criteria, digest } from '../runtime/contracts.mjs';
import { loadStudio } from '../runtime/instructions.mjs';
import { sha } from '../runtime/media.mjs';
import { inputs, script, file, send, event, reviewed, approved, audioProject } from './helpers.mjs';
import { image } from './background-helpers.mjs';
import { keyframeProject, composition } from './shot-helpers.mjs';

// Hard safety: network calls prohibited
globalThis.fetch = () => { throw new Error('FETCH_PROHIBITED: Network calls are forbidden in p17-runtime.test.mjs.'); };

const T = { timeout: 20000 };
// Qualified fixtures bind the ISOLATED audio qualification identity, so the crew
// must carry that worker binding or qualified narration locks read as stale.
const crew = { workers: Object.keys(crewRoles).map(role => (role === 'audio-reviewer'
  ? { workerId: 'audio-reviewer', name: crewRoles[role].name, role, modelVersion: 'ISOLATED-audio-v1', capabilityVersion: 'ISOLATED-tools-v1', execution: 'host' }
  : { workerId: `host-${role}`, name: crewRoles[role].name, role, modelVersion: 'test-host', capabilityVersion: 'isolated-tools-v1', execution: 'host' })) };
const withCrew = p => ({ ...structuredClone(p), crew });
const blocker = kind => ({ kind, problem: 'home-0-wide cannot stage: the locked door is missing from the plate.', solution: 'Revise the intention to use the window side or approve a new angle.', steps: ['Confirm which wall the action needs.'] });

// ---- SPEC 1: composition-writer blocked path on keyframePrompt author ----

function keyframeAuthor() {
  const p = withCrew(keyframeProject());
  assert.equal(p.step, 'keyframePrompt');
  assert.equal(p.gate, 'author');
  assert.equal(taskFor(p).formatRole, 'composition-writer');
  return p;
}

test('P17 SPEC1: composition-writer planning-blocked accepted on keyframePrompt author', T, () => {
  const p = keyframeAuthor();
  const q = send(p, 'planning-blocked', { workerId: 'host-composition-writer', message: 'ISOLATED plate conflict.', blocker: blocker('locked-change') });
  assert.equal(q.gate, 'escalate');
  assert.equal(q.history.at(-1).blocker.kind, 'locked-change');
});

test('P17 SPEC1: composition-writer planning-blocked accepted on a keyframePrompt repair attempt', T, () => {
  let p = keyframeProject();
  p = reviewed(send(p, 'artifact', { workerId: 'composition-writer', content: composition(p) }), 'rejected');
  assert.equal(p.step, 'keyframePrompt');
  assert.equal(p.gate, 'author');
  const q = send(withCrew(p), 'planning-blocked', { workerId: 'host-composition-writer', message: 'ISOLATED repair needs a locked change.', blocker: blocker('locked-change') });
  assert.equal(q.gate, 'escalate');
});

test('P17 SPEC1: composition-writer non-locked-change kinds are rejected', T, () => {
  const p = keyframeAuthor();
  assert.throws(() => send(p, 'planning-blocked', { workerId: 'host-composition-writer', message: 'ISOLATED wrong kind.', blocker: blocker('missing-input') }), /PLANNING_BLOCKER_KIND/);
});

test('P17 SPEC1: runCrewTask lets composition-writer return planning-blocked; other authors still denied', T, async () => {
  const p = keyframeAuthor();
  const task = taskFor(p);
  const host = { runTask: async (t, { worker }) => ({ taskId: t.taskId, actor: 'agent', workerId: worker.workerId, action: 'planning-blocked', message: 'ISOLATED plate conflict.', blocker: blocker('locked-change') }) };
  const result = await runCrewTask(p, task, host);
  assert.equal(result.action, 'planning-blocked');
  assert.equal(applyEvent(p, result).gate, 'escalate');
  const q = withCrew(initialProject('p17-deny', inputs, { reviewMode: 'qualified' }));
  const writerTask = taskFor(q);
  assert.equal(writerTask.formatRole, 'script-writer');
  await assert.rejects(runCrewTask(q, writerTask, { runTask: async (t, { worker }) => ({ taskId: t.taskId, actor: 'agent', workerId: worker.workerId, action: 'planning-blocked', message: 'ISOLATED writer block.', blocker: blocker('missing-input') }) }), /CREW_PERMISSION_DENIED/);
});

test('P17 SPEC1: human resolve resumes keyframePrompt author with feedback', T, () => {
  let p = keyframeAuthor();
  p = send(p, 'planning-blocked', { workerId: 'host-composition-writer', message: 'ISOLATED plate conflict.', blocker: blocker('locked-change') });
  p = send(p, 'resolve', { message: 'ISOLATED human confirms the window side.' });
  assert.equal(p.step, 'keyframePrompt');
  assert.equal(p.gate, 'author');
  assert.equal(p.feedback.at(-1).message, 'ISOLATED human confirms the window side.');
});

// ---- SPEC 5: characterDigest in the characterPrompt packet ----

function characterPromptAuthor() {
  let p = audioProject();
  p.artifacts.push({ id: 'roster@1', key: 'roster', kind: 'roster', version: 1, digest: 'r', content: { characters: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', important: true, references: [image(1)], notes: 'ISOLATED photo-bound persona' }] }, dependencies: [], valid: true, authoredBy: 'cast-owner' });
  p.step = 'roster'; p.gate = 'review';
  p = approved(reviewed(p));
  p.step = 'characterPrompt'; p.gate = 'author'; p.characterId = 'alex';
  return p;
}

test('P17 SPEC5: packet characterDigest equals the gate-accepted digest and passes binding', T, async () => {
  const p = characterPromptAuthor();
  const task = taskFor(p);
  const cast = current(p, 'roster').content.characters.find(c => c.id === 'alex');
  assert.equal(task.characterDigest, digest(cast));
  await prepareCrewTask(p, task);
  const content = { prompt: 'ISOLATED exact-copy sheet prompt', characterDigest: task.characterDigest, referenceHashes: cast.references.map(f => f.sha256), recipeSha256: task.recipe.sha256 };
  const q = send(p, 'artifact', { workerId: 'cast-owner', content });
  assert.equal(q.gate, 'review');
});

test('P17 SPEC5: a tampered characterDigest still fails CHARACTER_PROMPT_BINDING', T, () => {
  const p = characterPromptAuthor();
  const task = taskFor(p);
  const cast = current(p, 'roster').content.characters.find(c => c.id === 'alex');
  const content = { prompt: 'ISOLATED exact-copy sheet prompt', characterDigest: '0'.repeat(64), referenceHashes: cast.references.map(f => f.sha256), recipeSha256: task.recipe.sha256 };
  assert.throws(() => send(p, 'artifact', { workerId: 'cast-owner', content }), /CHARACTER_PROMPT_BINDING_REQUIRED/);
});

// ---- SPEC 7: photoInventory in the roster packet ----

const still = n => ({ path: `/isolated-test/intake-${n}.png`, sha256: String(50 + n).padStart(64, '0'), bytes: 100, width: 1600, height: 900 });

test('P17 SPEC7: intake-photos records stills with labels and the roster packet carries them whole', T, async () => {
  let p = audioProject();
  assert.equal(p.step, 'roster');
  p = send(p, 'intake-photos', { actor: 'human', photoInventory: [{ ...still(1), label: 'Alex' }, { ...still(2), label: 'Bob' }], message: 'ISOLATED maker intake photos' });
  assert.deepEqual(p.photoInventory, [{ ...still(1), label: 'Alex' }, { ...still(2), label: 'Bob' }]);
  assert.equal(p.feedback.at(-1).key, 'roster');
  const task = taskFor(p);
  assert.deepEqual(task.photoInventory, [{ ...still(1), label: 'Alex' }, { ...still(2), label: 'Bob' }]);
  await prepareCrewTask(p, task);
});

test('P17 SPEC7: roster packet photoInventory is an empty array when there are no photos', T, async () => {
  const p = audioProject();
  const task = taskFor(p);
  assert.deepEqual(task.photoInventory, []);
  await prepareCrewTask(p, task);
});

test('P17 SPEC7: rev<4 falls back to the script intake inventory with character-name labels', T, () => {
  const p = audioProject();
  assert.ok(p.workflowRevision < 4);
  current(p, 'script').intakeConfirmation = { voiceConsent: true, characters: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', minor: false, photoRights: true, references: [still(3)], likeness: 'reference', decisionNotes: 'ISOLATED' }], resolvedFindings: [] };
  assert.deepEqual(taskFor({ ...p, step: 'roster', gate: 'author' }).photoInventory, [{ ...still(3), label: 'Alex' }]);
});

test('P17 SPEC7: intake-photos rejects non-stills, missing messages and duplicates', T, () => {
  const p = audioProject();
  const audio = { path: '/isolated-test/hum.wav', sha256: 'b'.repeat(64), bytes: 100, durationSeconds: 5 };
  assert.throws(() => send(p, 'intake-photos', { actor: 'human', photoInventory: [{ ...audio, label: 'Alex' }], message: 'ISOLATED non-still' }), /measured still/);
  assert.throws(() => send(p, 'intake-photos', { actor: 'human', photoInventory: [{ ...still(4), label: 'Alex' }] }), /--message/);
  const q = send(p, 'intake-photos', { actor: 'human', photoInventory: [{ ...still(4), label: 'Alex' }], message: 'ISOLATED first' });
  assert.throws(() => send(q, 'intake-photos', { actor: 'human', photoInventory: [{ ...still(4), label: 'Alex again' }], message: 'ISOLATED dupe' }), /INTAKE_PHOTO_DUPLICATE/);
});

test('P17 SPEC7: intake-photos is locked once the roster is approved', T, () => {
  const p = audioProject();
  p.artifacts.push({ id: 'roster@1', key: 'roster', kind: 'roster', version: 1, digest: 'r', content: { characters: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', important: true, references: [still(5)], notes: 'ISOLATED' }] }, dependencies: [], valid: true, authoredBy: 'human', approvedBy: { message: 'ISOLATED', at: new Date().toISOString() } });
  assert.throws(() => send(p, 'intake-photos', { actor: 'human', photoInventory: [{ ...still(6), label: 'Alex' }], message: 'ISOLATED too late' }), /INTAKE_PHOTOS_LOCKED/);
});

