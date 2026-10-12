// P16 run 1 scopes B + planning half of 6: Sam and Beau may return planning-blocked
// on their author gates (incl. repairs); other authors still cannot. Invented
// fixtures only. No network, no providers, no real codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import { current, taskFor } from '../runtime/workflow.mjs';
import { crewRoles, runCrewTask } from '../runtime/crew.mjs';
import { reviewed, approved, send, event } from './helpers.mjs';
import { author, backgroundProject, registry } from './background-helpers.mjs';
import { supervisedCharacters, supervisedBackgrounds } from './supervised-helpers.mjs';
import { shotPatch } from './shot-helpers.mjs';

// Hard safety: network calls prohibited
globalThis.fetch = () => { throw new Error('FETCH_PROHIBITED: Network calls are forbidden in p16-planning-blocked.test.mjs.'); };

const T = { timeout: 20000 };
const crew = { workers: Object.keys(crewRoles).map(role => ({ workerId: `host-${role}`, name: crewRoles[role].name, role, modelVersion: 'test-host', capabilityVersion: 'isolated-tools-v1', execution: 'host' })) };
const withCrew = p => ({ ...structuredClone(p), crew });
const blocker = (kind, problem) => ({ kind, problem: problem ?? 'home-0-wide cannot stage: the locked door is missing from the plate.', solution: 'Revise the intention to use the window side or approve a new angle.', steps: ['Confirm which wall the action needs.'], beats: [1] });
const blocked = (p, workerId, b, message = 'ISOLATED evidenced blocker.') => send(p, 'planning-blocked', { workerId, message, blocker: b ?? blocker('plate-conflict') });

test('Sam planning-blocked is accepted on shotIntentions author gate', T, () => {
  const p = withCrew(supervisedCharacters());
  assert.equal(p.step, 'shotIntentions');
  const q = blocked(p, 'host-shot-planner', blocker('missing-input', 'Need the fact the script never states: whose bicycle this is.'));
  assert.equal(q.gate, 'escalate');
  assert.equal(q.history.at(-1).blocker.kind, 'missing-input');
});

test('Sam planning-blocked is accepted on shots author gate', T, () => {
  const p = withCrew(supervisedBackgrounds());
  assert.equal(p.step, 'shots');
  const q = blocked(p, 'host-shot-planner', blocker('plate-conflict'));
  assert.equal(q.gate, 'escalate');
});

test('Sam planning-blocked is accepted on a shots repair attempt', T, () => {
  let p = supervisedBackgrounds();
  p = reviewed(author(p, shotPatch(), 'shot-planner'), 'rejected');
  assert.equal(p.gate, 'author');
  p = withCrew(p);
  const q = blocked(p, 'host-shot-planner', blocker('locked-change', 'Repair needs locked shotIntentions home-0-wide camera changed.'));
  assert.equal(q.gate, 'escalate');
});

test('Beau planning-blocked is accepted on backgrounds author gate', T, () => {
  const p = withCrew(backgroundProject());
  assert.equal(p.step, 'backgrounds');
  assert.equal(p.gate, 'author');
  const q = blocked(p, 'host-background-product-owner', blocker('locked-change', 'Registry location home misses the locked lean-to the script needs.'));
  assert.equal(q.gate, 'escalate');
});

test('runCrewTask lets Sam return planning-blocked on an author gate', T, async () => {
  const p = withCrew(supervisedCharacters());
  const task = taskFor(p);
  assert.equal(task.formatRole, 'shot-planner');
  const host = { runTask: async (t, { worker }) => ({ taskId: t.taskId, actor: 'agent', workerId: worker.workerId, action: 'planning-blocked', message: 'ISOLATED plate conflict.', blocker: blocker('plate-conflict') }) };
  const result = await runCrewTask(p, task, host);
  assert.equal(result.action, 'planning-blocked');
  assert.equal(result.blocker.kind, 'plate-conflict');
});

test('another authoring role still gets CREW_PERMISSION_DENIED', T, async () => {
  const p = withCrew(supervisedCharacters());
  assert.throws(() => blocked(p, 'host-script-writer', blocker('plate-conflict')), /CREW_PERMISSION_DENIED/);
  const { initialProject } = await import('../runtime/workflow.mjs');
  const { inputs } = await import('./helpers.mjs');
  const q = withCrew((await import('../runtime/workflow.mjs')).initialProject('p16-deny', inputs, { workflowRevision: 2 }));
  const task = taskFor(q);
  assert.equal(task.formatRole, 'script-writer');
  const host = { runTask: async (t, { worker }) => ({ taskId: t.taskId, actor: 'agent', workerId: worker.workerId, action: 'planning-blocked', message: 'ISOLATED writer block.', blocker: blocker('missing-input') }) };
  await assert.rejects(runCrewTask(q, task, host), /CREW_PERMISSION_DENIED/);
});

test('bad blocker shapes are rejected: unknown kind, missing problem', T, () => {
  const p = withCrew(supervisedBackgrounds());
  assert.throws(() => blocked(p, 'host-shot-planner', { ...blocker('plate-conflict'), kind: 'teleporter' }), /Invalid option/);
  const { problem: _dropped, ...noProblem } = blocker('plate-conflict');
  assert.throws(() => blocked(p, 'host-shot-planner', noProblem), /Invalid input/);
});

test('human resolve resumes Sam and Beau at their author gate', T, () => {
  let s = blocked(withCrew(supervisedBackgrounds()), 'host-shot-planner', blocker('plate-conflict'));
  s = send(s, 'resolve', { message: 'ISOLATED human picks the window side.' });
  assert.equal(s.step, 'shots');
  assert.equal(s.gate, 'author');
  let b = blocked(withCrew(backgroundProject()), 'host-background-product-owner', blocker('locked-change', 'Registry location home misses the locked lean-to.'));
  b = send(b, 'resolve', { message: 'ISOLATED human confirms the lean-to.' });
  assert.equal(b.step, 'backgrounds');
  assert.equal(b.gate, 'author');
});

test("narration editing-infeasible special case is unchanged", T, async () => {
  const { audioProject } = await import('./helpers.mjs');
  const p = withCrew(audioProject());
  p.step = 'narration';
  p.gate = 'author';
  assert.throws(() => blocked(p, 'host-voice-director', blocker('plate-conflict')), /AUDIO_EDIT_INVESTIGATION_REQUIRED/);
});
