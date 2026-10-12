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

// ---- SPEC 13: start-audio-edit refreshes Nora, audioHolds stays required ----

test('P17 SPEC13: start-audio-edit refreshes nora plus ava and the audio rubric, not eli', T, () => {
  let p = audioProject();
  p.step = 'narration'; p.gate = 'review';
  const a = current(p); delete a.approvedBy; delete a.review;
  p = reviewed(p, 'rejected');
  assert.equal(p.step, 'narration');
  assert.ok(['author', 'escalate'].includes(p.gate));
  const kit = loadStudio();
  for (const path of ['crew/nora/SKILL.md', 'crew/eli/SKILL.md']) {
    p.studio.documents[path] = { content: 'ISOLATED stale pinned skill', sha256: sha('ISOLATED stale pinned skill') };
  }
  p.studio.sha256 = digest({ config: p.studio.config, documents: p.studio.documents });
  const enabled = applyEvent(p, event(p, 'start-audio-edit', { actor: 'human', message: 'ISOLATED enable the voice editor.' }));
  assert.deepEqual(enabled.studio.documents['crew/nora/SKILL.md'], kit.documents['crew/nora/SKILL.md']);
  assert.deepEqual(enabled.studio.documents['crew/ava/SKILL.md'], kit.documents['crew/ava/SKILL.md']);
  assert.deepEqual(enabled.studio.documents['evaluation/rubrics/audio.md'], kit.documents['evaluation/rubrics/audio.md']);
  assert.equal(enabled.studio.documents['crew/eli/SKILL.md'].content, 'ISOLATED stale pinned skill');
  assert.ok(enabled.studio.config.agents['voice-director'].tools.includes('renderAudioEdit'));
});

test('P17 SPEC13: editPlan.audioHolds stays required and is documented as renderer-ignored review notes', T, () => {
  const base = { clips: [0, 1, 2, 3].map(n => ({ clipId: `c${n}`, sourceOffsetSeconds: 0 })), narrationGainDb: 0, musicGainDb: -18, duckMusic: true, effectGainDb: 0, musicFadeInSeconds: 1, musicFadeOutSeconds: 2, audioHolds: ['score', 'effect', 'silence', 'score'] };
  Content.editPlan.parse(base);
  assert.throws(() => Content.editPlan.parse({ ...base, audioHolds: undefined }), /audioHolds/);
  assert.match(Content.editPlan.shape.audioHolds.description, /per-beat review notes on what carries the time after the voice.*not read by the renderer/);
});

// ---- SPEC 15: settle-transcript for STT mishearings ----

const misheard = beat => (beat === 4 ? 'Nia, now I hold your bicycle steady. Falling is okay. We can try again together.' : script.beats[beat - 1].narration);

function measurementsWith(transcripts) {
  return { transcripts, speechToTextMethod: 'ISOLATED TEST STT', referenceSha256: file().sha256, speakerSimilarity: 0.9, speakerSimilarityMethod: 'ISOLATED TEST embedding model', speakingRateWpm: [80, 80, 80, 80], silenceSeconds: [0, 0, 0, 0], measurementNotes: 'ISOLATED TEST ONLY: no audio-quality claim.' };
}

function narrationReview(p, transcripts, decision) {
  return event(p, 'review', { workerId: 'audio-reviewer', artifactId: current(p).id, artifactDigest: current(p).digest,
    review: { decision, perception: 'direct-audio',
      checks: criteria.narration.map(criterion => ({ criterion, status: decision === 'approved' ? 'pass' : criterion === 'transcript' ? 'inconclusive' : 'pass', evidence: 'ISOLATED STT misheard the rare name; operator adjudication pending.', location: 'beat 4', repair: '' })),
      measurements: measurementsWith(transcripts), modelVersion: 'ISOLATED-audio-v1', capabilityVersion: 'ISOLATED-tools-v1',
      coverage: { artifactSha256: current(p).content.files[0].sha256, audioFiles: current(p).content.files.map(f => ({ sha256: f.sha256, seconds: f.durationSeconds })) } } });
}

function narrationAtReview() {
  let p = audioProject();
  const a = current(p, 'narration');
  delete a.approvedBy; delete a.review;
  return { ...p, step: 'narration', gate: 'review' };
}

test('P17 SPEC15: a misheard take is stored inconclusive but cannot be approved without settlement', T, () => {
  const p = narrationAtReview();
  const stored = applyEvent(p, narrationReview(p, [1, 2, 3, 4].map(misheard), 'inconclusive'));
  assert.equal(stored.gate, 'escalate');
  assert.throws(() => applyEvent(p, narrationReview(p, [1, 2, 3, 4].map(misheard), 'approved')), /Speech-to-text differs from the locked script/);
});

test('P17 SPEC15: settle-transcript records the beat, artifact binding, exact STT text and human message', T, () => {
  const base = narrationAtReview();
  const p = applyEvent(base, narrationReview(base, [1, 2, 3, 4].map(misheard), 'inconclusive'));
  const a = current(p);
  const settled = applyEvent(p, event(p, 'settle-transcript', { actor: 'human', beat: 4, message: 'ISOLATED operator heard Mia on the stem.' }));
  assert.deepEqual(current(settled).transcriptSettlement, { beat: 4, artifactId: a.id, artifactDigest: a.digest, transcript: misheard(4), message: 'ISOLATED operator heard Mia on the stem.', actor: 'human', at: current(settled).transcriptSettlement.at });
  assert.equal(settled.history.at(-1).action, 'settle-transcript');
  assert.equal(settled.history.at(-1).message, 'ISOLATED operator heard Mia on the stem.');
});

test('P17 SPEC15: after settlement the same take is re-reviewed, human-approved and locked', T, () => {
  const base = narrationAtReview();
  let p = applyEvent(base, narrationReview(base, [1, 2, 3, 4].map(misheard), 'inconclusive'));
  p = applyEvent(p, event(p, 'settle-transcript', { actor: 'human', beat: 4, message: 'ISOLATED operator heard Mia on the stem.' }));
  p = applyEvent(p, event(p, 'resolve', { actor: 'human', message: 'ISOLATED accept the settled take for re-review.' }));
  assert.equal(p.gate, 'review');
  p = applyEvent(p, narrationReview(p, [1, 2, 3, 4].map(misheard), 'approved'));
  assert.equal(p.gate, 'human');
  const a = current(p);
  p = applyEvent(p, event(p, 'approve', { actor: 'human', artifactId: a.id, artifactDigest: a.digest, message: 'ISOLATED human confirms the settled narration.' }));
  assert.ok(current(p, 'narration').approvedBy);
});

test('P17 SPEC15: settlement does not carry to a new artifact', T, () => {
  let p = narrationAtReview();
  p = applyEvent(p, narrationReview(p, [1, 2, 3, 4].map(misheard), 'inconclusive'));
  p = applyEvent(p, event(p, 'settle-transcript', { actor: 'human', beat: 4, message: 'ISOLATED operator heard Mia.' }));
  let q = narrationAtReview();
  q.artifacts.find(x => x.key === 'narration').content.files[3] = file(14);
  q.artifacts.find(x => x.key === 'narration').digest = digest(q.artifacts.find(x => x.key === 'narration').content);
  assert.notEqual(current(q, 'narration').digest, current(p, 'narration').digest);
  assert.throws(() => applyEvent(q, narrationReview(q, [1, 2, 3, 4].map(misheard), 'approved')), /Speech-to-text differs from the locked script/);
});

test('P17 SPEC15: settlement does not cover a different transcript text on the same artifact', T, () => {
  const base = narrationAtReview();
  let p = applyEvent(base, narrationReview(base, [1, 2, 3, 4].map(misheard), 'inconclusive'));
  p = applyEvent(p, event(p, 'settle-transcript', { actor: 'human', beat: 4, message: 'ISOLATED operator heard Mia.' }));
  p = applyEvent(p, event(p, 'resolve', { actor: 'human', message: 'ISOLATED re-review with fresh STT.' }));
  const other = [1, 2, 3].map(misheard).concat(['Mia, now I hold your bicycle. Falling is okay. We can try again together.']);
  assert.throws(() => applyEvent(p, narrationReview(p, other, 'approved')), /Speech-to-text differs from the locked script/);
});

test('P17 SPEC15: settle-transcript rejects non-human actors, wrong steps, missing messages and matching transcripts', T, () => {
  const base = narrationAtReview();
  const p = applyEvent(base, narrationReview(base, [1, 2, 3, 4].map(misheard), 'inconclusive'));
  assert.throws(() => applyEvent(p, event(p, 'settle-transcript', { beat: 4, message: 'ISOLATED agent attempt.' })), /authority/);
  const elsewhere = { ...p, step: 'script' };
  assert.throws(() => applyEvent(elsewhere, event(elsewhere, 'settle-transcript', { actor: 'human', beat: 4, message: 'ISOLATED wrong step.' })), /TRANSCRIPT_SETTLEMENT_STEP/);
  assert.throws(() => applyEvent(p, event(p, 'settle-transcript', { actor: 'human', beat: 4 })), /--beat/);
  const fresh = narrationAtReview();
  assert.throws(() => applyEvent(fresh, event(fresh, 'settle-transcript', { actor: 'human', beat: 1, message: 'ISOLATED no stored review.' })), /TRANSCRIPT_SETTLEMENT_SCOPE/);
  const matched = applyEvent(fresh, narrationReview(fresh, script.beats.map(b => b.narration), 'inconclusive'));
  assert.throws(() => applyEvent(matched, event(matched, 'settle-transcript', { actor: 'human', beat: 1, message: 'ISOLATED already matches.' })), /TRANSCRIPT_SETTLEMENT_NOT_NEEDED/);
});
