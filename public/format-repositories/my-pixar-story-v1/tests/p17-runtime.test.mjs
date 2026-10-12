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

