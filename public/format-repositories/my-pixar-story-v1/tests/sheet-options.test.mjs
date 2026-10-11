import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initialProject, taskFor, current, criteriaFor, characterRecipeSha256 } from '../runtime/workflow.mjs';
import { characterSheet, characterSheetArtifact, sheetKeyFor } from '../runtime/gates.mjs';
import { requestDescriptor } from '../runtime/providers.mjs';
import { importMedia } from '../runtime/media.mjs';
import { criteria, digest } from '../runtime/contracts.mjs';
import { inputs, script, file, send, reviewed, approved, produce, intakeFixture } from './helpers.mjs';
import { image, sheetImage } from './background-helpers.mjs';
import { shotReferences } from '../runtime/shots.mjs';

function rev5Audio() {
  let p = initialProject('rev5', inputs, { workflowRevision: 5 });
  const q = { inputs: p.inputs, sourceInputDigest: digest(p.inputs), commonSenseChecks: script.commonSenseChecks };
  p = send(p, 'artifact', { workerId: 'intake', content: q });
  p = reviewed(p);
  const intake = { voiceConsent: true, characters: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', minor: false, photoRights: true, references: [{ path: '/isolated-test/background-1.png', sha256: file(1).sha256, bytes: 100, width: 1600, height: 900 }], likeness: 'reference', decisionNotes: 'ISOLATED' }], resolvedFindings: script.commonSenseChecks.map(c => ({ findingDigest: digest({ category: c.category, finding: c.finding }), resolution: 'ISOLATED' })) };
  const answerFindings = current(p).content.commonSenseChecks.map(c => ({ findingDigest: digest({ category: c.category, finding: c.finding }), resolution: 'ISOLATED' }));
  p = send(p, 'approve', { artifactId: current(p).id, artifactDigest: current(p).digest, message: 'ISOLATED', resolvedFindings: answerFindings, intakeConfirmation: intake });
  const withCast = { ...script, proposedCast: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', minor: false, storyPurpose: 'Narrator' }] };
  p = reviewed(send(p, 'artifact', { workerId: 'writer', content: withCast }));
  { const sc = current(p).content.commonSenseChecks.map(c => ({ findingDigest: digest({ category: c.category, finding: c.finding }), resolution: 'ISOLATED' })); p = send(p, 'approve', { artifactId: current(p).id, artifactDigest: current(p).digest, message: 'ISOLATED audio setup', resolvedFindings: sc }); }
  p = send(p, 'artifact', { actor: 'human', workerId: 'human', content: { files: [file()], consent: true, language: 'en' } });
  p = send(p, 'set-budget', { actor: 'human', budgetLimitUsd: 100, message: 'ISOLATED' });
  p = send(p, 'plan', { plan: { provider: 'cartesia', operation: 'clone', estimatedCostUsd: 0.1, parameters: {} } });
  { const job = p.jobs.at(-1); p = send(p, 'authorize', { jobId: job.id, artifactDigest: job.digest, message: 'ISOLATED' }); }
  { const job = p.jobs.at(-1); p = send(p, 'begin', { jobId: job.id, artifactDigest: job.digest }); p = send(p, 'receipt', { jobId: job.id, artifactDigest: job.digest, result: { provider: 'cartesia', voiceId: 'private-clone-test', receiptId: 'job-1' } }); }
  const narrationSources = [1,2,3,4].map(n => file(n));
  const narrationFiles = narrationSources.map((f,i) => ({ ...f, sha256: String(900+i).padStart(64,'0'), path: `/isolated-test/window-${i}.wav`, durationSeconds: 15 }));
  for (const [op, result] of [
    ['audition', { files: [file(1)], voiceId: 'private-clone-test', transcript: withCast.beats[0].narration }],
    ['narration', { files: narrationFiles, sourceFiles: narrationSources, tailSilenceSeconds: [3,3,3,3], voiceId: 'private-clone-test', transcripts: withCast.beats.map(b => b.narration), model: 'isolated' }],
  ]) {
    p = send(p, 'plan', { plan: { provider: 'cartesia', operation: op, estimatedCostUsd: 0.05, parameters: {} } });
    { const job = p.jobs.at(-1); p = send(p, 'authorize', { jobId: job.id, artifactDigest: job.digest, message: 'ISOLATED' }); }
    { const job = p.jobs.at(-1); p = send(p, 'begin', { jobId: job.id, artifactDigest: job.digest }); p = send(p, 'receipt', { jobId: job.id, artifactDigest: job.digest, result }); }
    p = reviewed(p);
    const a = current(p);
    p = send(p, 'approve', { artifactId: a.id, artifactDigest: a.digest, message: 'ISOLATED', humanReview: { decision: 'approved', perception: 'direct-audio', checks: criteria[op].map(criterion => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED' })) } });
  }
  return p;
}

function approveRosterRev5(p) {
  p = send(p, 'artifact', { workerId: 'cast-owner', content: { characters: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', important: true, references: [image(1)], notes: 'ISOLATED rev5' }] } });
  p = reviewed(p);
  const a = current(p);
  const intake = { voiceConsent: true, characters: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', minor: false, photoRights: true, references: [image(1)], likeness: 'reference', decisionNotes: 'ISOLATED' }], resolvedFindings: current(p, 'script').content.commonSenseChecks.map(c => ({ findingDigest: digest({ category: c.category, finding: c.finding }), resolution: 'ISOLATED' })) };
  return send(p, 'approve', { artifactId: a.id, artifactDigest: a.digest, message: 'ISOLATED roster', intakeConfirmation: intake });
}

test('new projects default to revision 5; rev-5 candidates require full sheet criteria', () => {
  assert.equal(initialProject('n', inputs).workflowRevision, 5);
  const p = initialProject('n2', inputs, { workflowRevision: 5 });
  assert.deepEqual(criteriaFor(p, 'candidates'), criteria.sheet);
  const old = initialProject('o', inputs, { workflowRevision: 4 });
  assert.deepEqual(criteriaFor(old, 'candidates'), criteria.candidates);
});

test('character aspect is 4:3 and background is 16:9 for both providers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sheet-aspect-'));
  try {
    const mk = (name, size) => { const path = join(dir, name); execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=${size}`, '-frames:v', '1', path]); return importMedia(path, dir); };
    const ref43 = await mk('r43.png', '1200x900');
    const p = initialProject('a', inputs, { workflowRevision: 5 });
    p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref43] }] } });
    p.characterId = 'alex';
    for (const provider of ['agy', 'meta-muse']) {
      const cost = provider === 'agy' ? 0 : 0.03;
      const cand = requestDescriptor(p, { provider, operation: 'candidates', estimatedCostUsd: cost, parameters: { prompt: 'sheet prompt' } });
      assert.equal(cand.aspectRatio, '4:3');
      if (provider === 'meta-muse') assert.equal(cand.size, '1536x1152');
    }
    const { readyForMaster } = await import('./background-helpers.mjs');
    const { current: cur } = await import('../runtime/workflow.mjs');
    const b = readyForMaster();
    for (const provider of ['agy', 'meta-muse']) {
      const cost = provider === 'agy' ? 0 : 0.03;
      const bg = requestDescriptor(b, { provider, operation: b.step, estimatedCostUsd: cost, parameters: { prompt: cur(b, 'backgroundPrompt:home').content.prompt } });
      assert.equal(bg.aspectRatio, '16:9');
      if (provider === 'meta-muse') assert.equal(bg.size, '1536x864');
    }
  } finally { await rm(dir, { recursive: true }); }
});

test('rev 5 skips sheetPrompt/sheet; selection IS the final sheet and downstream refs resolve it', () => {
  let p = approveRosterRev5(rev5Audio());
  assert.equal(p.step, 'characterPrompt');
  assert.equal(taskFor(p).formatRole, 'sheet-prompter');
  assert.equal(taskFor(p).recipe.sha256, characterRecipeSha256);
  const cast = current(p, 'roster').content.characters[0];
  const prompt = { prompt: 'Full sheet prompt with 4 views and 8 expressions', characterDigest: digest(cast), referenceHashes: cast.references.map(f => f.sha256), recipeSha256: characterRecipeSha256 };
  p = approved(reviewed(send(p, 'artifact', { workerId: 'pia', content: prompt })));
  assert.equal(p.step, 'candidates');
  p = produce(p, { files: [1, 2, 3].map(sheetImage), prompt: prompt.prompt });
  assert.deepEqual(taskFor(p).criteria, criteria.sheet);
  const a = current(p);
  p = send(p, 'review', { workerId: 'vera', artifactId: a.id, artifactDigest: a.digest, review: { decision: 'approved', perception: 'direct-image', checks: criteria.sheet.map(criterion => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED full sheet' })), recommendation: { selection: 1, ranking: [1, 0, 2], reason: 'ISOLATED option 2 stages the scripted action best.' }, toolEvidence: a.content.files.map(f => ({ tool: 'viewImage', sha256: f.sha256 })) } });
  assert.equal(p.gate, 'human');
  assert.equal(taskFor(p).reviewPolicy.humanMediaConfirmationRequired, false);
  p = send(p, 'approve', { artifactId: a.id, artifactDigest: a.digest, message: 'ISOLATED pick 1', selection: 1, humanReview: { decision: 'approved', perception: 'crew-review', checks: [] } });
  assert.equal(sheetKeyFor(p, 'alex'), 'candidates:alex');
  assert.equal(characterSheetArtifact(p, 'alex').id, a.id);
  assert.equal(characterSheet(p, 'alex').sha256, a.content.files[1].sha256);
  assert.ok(!['sheetPrompt', 'sheet'].includes(p.step));
  assert.equal(p.step, 'shotIntentions');
});

test('rev 4 flow unchanged: candidates then sheetPrompt/sheet with 4-criterion candidates', async () => {
  const { backgroundProject } = await import('./background-helpers.mjs');
  const p = backgroundProject();
  assert.equal(p.workflowRevision, 2);
  assert.ok(current(p, 'candidates:alex'));
  assert.ok(current(p, 'sheet:alex'));
  assert.equal(sheetKeyFor(p, 'alex'), 'sheet:alex');
  assert.equal(characterSheet(p, 'alex').sha256, current(p, 'sheet:alex').content.files[0].sha256);
});

test('upgrade-workflow allows rev4->5 before sheets and blocks after sheet approval', () => {
  let fresh = initialProject('up', inputs, { workflowRevision: 4 });
  assert.throws(() => send(fresh, 'upgrade-workflow', { actor: 'human', workflowRevision: 5, message: 'ISOLATED' }), /roster must exist/i);
  // minimal rev4 project with roster but no sheets
  let p = initialProject('up2', inputs, { workflowRevision: 4 });
  p.artifacts.push({ id: 'script@1', key: 'script', kind: 'script', version: 1, digest: 's', content: { beats: [1,2,3,4].map(i => ({ beat: i, durationSeconds: 15, narration: 'x', emotionalPurpose: 'c', sourceAnswers: ['scene1Childhood'] })), commonSenseChecks: [] }, dependencies: [], valid: true, authoredBy: 't' });
  p.artifacts.push({ id: 'roster@1', key: 'roster', kind: 'roster', version: 1, digest: 'd', content: { characters: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', important: true, references: [image(1)], notes: 'x' }] }, dependencies: [], valid: true, authoredBy: 't' });
  p.step = 'characterPrompt'; p.gate = 'author'; p.characterId = 'alex';
  p = send(p, 'upgrade-workflow', { actor: 'human', workflowRevision: 5, message: 'ISOLATED upgrade to sheets' });
  assert.equal(p.workflowRevision, 5);
  assert.equal(p.step, 'characterPrompt');
  assert.equal(p.gate, 'author');
  assert.equal(taskFor(p).formatRole, 'sheet-prompter');
  // blocked after a sheet approval
  let q = initialProject('up3', inputs, { workflowRevision: 4 });
  q.artifacts.push({ id: 'script@1', key: 'script', kind: 'script', version: 1, digest: 's', content: { beats: [1,2,3,4].map(i => ({ beat: i, durationSeconds: 15, narration: 'x', emotionalPurpose: 'c', sourceAnswers: ['scene1Childhood'] })), commonSenseChecks: [] }, dependencies: [], valid: true, authoredBy: 't' });
  q.artifacts.push({ id: 'roster@1', key: 'roster', kind: 'roster', version: 1, digest: 'd', content: { characters: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', important: true, references: [image(1)], notes: 'x' }] }, dependencies: [], valid: true, authoredBy: 't' });
  q.artifacts.push({ id: 'sheet:alex@1', key: 'sheet:alex', kind: 'sheet', version: 1, digest: 'e', content: { files: [sheetImage(9)], prompt: 'sheet' }, dependencies: [], valid: true, authoredBy: 't', approvedBy: { message: 'm', at: new Date().toISOString() }, review: { decision: 'approved', perception: 'direct-image', checks: criteria.sheet.map(criterion => ({ criterion, status: 'pass', location: 'x', evidence: 'x' })) } });
  q.step = 'characterPrompt'; q.gate = 'author'; q.characterId = 'alex';
  assert.throws(() => send(q, 'upgrade-workflow', { actor: 'human', workflowRevision: 5, message: 'ISOLATED' }), /no approved character sheet/i);
});

test('keyframe stays 16:9 with minimum 1280x720 for both providers', async () => {
  const { promptLocked } = await import('./shot-helpers.mjs');
  const { current: cur } = await import('../runtime/workflow.mjs');
  const p = promptLocked();
  for (const provider of ['agy', 'meta-muse']) {
    const cost = provider === 'agy' ? 0 : 0.01;
    const req = requestDescriptor(p, { provider, operation: 'keyframe', estimatedCostUsd: cost, parameters: { prompt: cur(p, `keyframePrompt:${p.shotId}`).content.prompt } });
    assert.equal(req.aspectRatio, '16:9');
    if (provider === 'meta-muse') assert.equal(req.size, '1536x864');
  }
  const refs = shotReferences(p);
  assert.ok(refs[0].file.width);
});
