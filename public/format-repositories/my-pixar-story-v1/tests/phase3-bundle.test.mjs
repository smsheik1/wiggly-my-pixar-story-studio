import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initialProject, taskFor, current, characterPromptRecipeSha256 } from '../runtime/workflow.mjs';
import { requestDescriptor } from '../runtime/providers.mjs';
import { importMedia } from '../runtime/media.mjs';
import { loadStudio } from '../runtime/instructions.mjs';
import { digest, criteria } from '../runtime/contracts.mjs';
import { runCrewTask } from '../runtime/crew.mjs';
import { audioProject, inputs, file, send, reviewed, approved } from './helpers.mjs';
import { image, author } from './background-helpers.mjs';
import { supervisedAudio, confirmed } from './supervised-helpers.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');

function candidatesProduce() {
  let p = audioProject();
  p = send(p, 'artifact', { workerId: 'cast-owner', content: { characters: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', important: true, references: [image(1)], notes: 'ISOLATED' }] } });
  p = reviewed(p);
  p = approved(p);
  assert.equal(p.step, 'candidates');
  assert.equal(p.gate, 'produce');
  return p;
}

// Supervised rev3 path to candidates/produce (requireBudget only enforces in supervised mode)
function supervisedCandidatesProduce() {
  let p = confirmed(supervisedAudio());
  p = approved(reviewed(author(p, { characters: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', important: true, references: [image(1)], notes: 'ISOLATED' }] }, 'cast-owner')));
  const c = current(p, 'roster').content.characters[0];
  p = approved(reviewed(author(p, { prompt: 'character', characterDigest: digest(c), referenceHashes: c.references.map(f => f.sha256), recipeSha256: characterPromptRecipeSha256 }, 'cast-owner')));
  assert.equal(p.step, 'candidates');
  assert.equal(p.gate, 'produce');
  return p;
}

test('authorize requires budget for estimate plus fallback reserve', () => {
  let p = supervisedCandidatesProduce();
  p.budget.maxCostUsd = 0;
  const prompt = 'character';
  p = send(p, 'plan', { plan: { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, fallbackEstimatedCostUsd: 0.03, parameters: { prompt } } });
  assert.equal(p.gate, 'authorize');
  const job = p.jobs.at(-1);
  assert.ok(job.request.fallback);
  assert.throws(() => send(p, 'authorize', { jobId: job.id, artifactDigest: job.digest, message: 'ISOLATED no budget' }), /BUDGET_EXCEEDED/);
  p = send(p, 'set-budget', { actor: 'human', budgetLimitUsd: 1, message: 'ISOLATED ceiling' });
  p = send(p, 'authorize', { jobId: job.id, artifactDigest: job.digest, message: 'ISOLATED authorize with fallback reserve' });
  assert.equal(p.jobs.at(-1).status, 'authorized');
  assert.equal(p.gate, 'collect');
});

test('plan rejects a too-low fallbackEstimatedCostUsd', () => {
  const p = candidatesProduce();
  assert.throws(() => send(p, 'plan', { plan: { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, fallbackEstimatedCostUsd: 0.01, parameters: { prompt: 'ISOLATED' } } }), /fallback estimate must reserve/);
});

test('old pinned runs still plan meta-muse jobs exactly as today', () => {
  const p = candidatesProduce();
  p.budget = { maxCostUsd: 10, reservations: [] };
  const before = send(p, 'plan', { plan: { provider: 'meta-muse', operation: 'candidates', estimatedCostUsd: 0.03, parameters: { prompt: 'ISOLATED muse prompt' } } });
  const job = before.jobs.at(-1);
  assert.equal(job.request.endpoint, 'https://api.meta.ai/v1/images/edits');
  assert.equal(job.request.size, '1536x1152');
  assert.equal(job.request.fallback, undefined);
});

test('image provider preference is visible in Max task with a directive', () => {
  let p = candidatesProduce();
  p = send(p, 'prefer-image-provider', { actor: 'human', provider: 'meta-muse', message: 'ISOLATED agy is down, use Muse' });
  const task = taskFor(p);
  assert.deepEqual(task.imageProviderPreference.provider, 'meta-muse');
  assert.match(task.imageProviderDirective, /meta-muse/);
  assert.match(task.imageProviderDirective, /next image job only/);
});

test('mismatched image plan is rejected; matching plan is accepted and consumes the preference', () => {
  let p = candidatesProduce();
  p = send(p, 'prefer-image-provider', { actor: 'human', provider: 'meta-muse', message: 'ISOLATED use Muse' });
  assert.throws(() => send(p, 'plan', { plan: { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, parameters: { prompt: 'ISOLATED' } } }), /IMAGE_PROVIDER_PREFERENCE/);
  p.budget = { maxCostUsd: 10, reservations: [] };
  p = send(p, 'plan', { plan: { provider: 'meta-muse', operation: 'candidates', estimatedCostUsd: 0.03, parameters: { prompt: 'ISOLATED' } } });
  assert.equal(p.jobs.at(-1).plan.provider, 'meta-muse');
  assert.equal(p.imageProviderPreference, undefined);
  assert.equal(taskFor(p).imageProviderPreference, undefined);
});

test('prefer-image-provider is refused while a job is uncertain', () => {
  let p = candidatesProduce();
  p = send(p, 'plan', { plan: { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, parameters: { prompt: 'ISOLATED' } } });
  const job = p.jobs.at(-1);
  p = send(p, 'authorize', { jobId: job.id, artifactDigest: job.digest, message: 'ISOLATED $0 agy' });
  p = send(p, 'begin', { jobId: job.id, artifactDigest: job.digest });
  p = send(p, 'provider-error', { jobId: job.id, artifactDigest: job.digest, message: 'ISOLATED agy blew up' });
  assert.equal(p.jobs.at(-1).status, 'uncertain');
  assert.throws(() => send(p, 'prefer-image-provider', { actor: 'human', provider: 'agy', message: 'ISOLATED' }), /IMAGE_PREFERENCE_LOCKED/);
});

test('refresh-visual-instructions applies only Vera skill and visual rubric', () => {
  let p = candidatesProduce();
  const kit = loadStudio();
  const oldVera = kit.documents['crew/vera/SKILL.md'].content + '\n<!-- isolated old vera -->';
  p.studio.documents['crew/vera/SKILL.md'] = { content: oldVera, sha256: sha(oldVera) };
  p.studio.sha256 = digest({ config: p.studio.config, documents: p.studio.documents });
  p = send(p, 'refresh-visual-instructions', { actor: 'human', message: 'ISOLATED refresh Vera' });
  assert.equal(p.studio.documents['crew/vera/SKILL.md'].content, kit.documents['crew/vera/SKILL.md'].content);
  assert.equal(p.studio.sha256, kit.sha256);
});

test('refresh-visual-instructions refuses when another doc or config differs', () => {
  const kit = loadStudio();
  let p = candidatesProduce();
  const oldLeo = kit.documents['crew/leo/SKILL.md'].content + '\n<!-- isolated -->';
  p.studio.documents['crew/leo/SKILL.md'] = { content: oldLeo, sha256: sha(oldLeo) };
  p.studio.sha256 = digest({ config: p.studio.config, documents: p.studio.documents });
  assert.throws(() => send(p, 'refresh-visual-instructions', { actor: 'human', message: 'ISOLATED' }), /VISUAL_REFRESH_SCOPE/);
  let q = candidatesProduce();
  q.studio.config = { ...q.studio.config, version: 1 };
  // force a config digest difference via a generation model string that still parses
  q.studio.config.generation = { ...q.studio.config.generation, image: { ...q.studio.config.generation.image, model: 'muse-image-1.0-changed' } };
  q.studio.sha256 = digest({ config: q.studio.config, documents: q.studio.documents });
  assert.throws(() => send(q, 'refresh-visual-instructions', { actor: 'human', message: 'ISOLATED' }), /VISUAL_REFRESH_SCOPE|STUDIO_SNAPSHOT_CHANGED|custom/);
});

test('refresh-visual-instructions refuses when the current item already has an approved image', () => {
  let p = candidatesProduce();
  const files = [1, 2, 3].map(n => ({ path: `/isolated-test/cand-${n}.png`, sha256: file(n).sha256, bytes: 100, width: 1200, height: 900 }));
  p.artifacts.push({ id: 'candidates:alex@1', key: 'candidates:alex', kind: 'candidates', version: 1, digest: digest({ files, prompt: 'x' }), content: { files, prompt: 'x' }, dependencies: [], valid: true, authoredBy: 'provider-runtime', approvedBy: { message: 'm', at: new Date().toISOString() }, review: { decision: 'approved', perception: 'direct-image', checks: criteria.candidates.map(criterion => ({ criterion, status: 'pass', location: 'x', evidence: 'x' })) } });
  assert.throws(() => send(p, 'refresh-visual-instructions', { actor: 'human', message: 'ISOLATED' }), /VISUAL_REFRESH_LOCKED/);
});

test('refresh is allowed at produce with earlier characters approved', () => {
  let p = audioProject();
  p = send(p, 'artifact', { workerId: 'cast-owner', content: { characters: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', important: true, references: [image(1)], notes: 'x' }, { id: 'bob', name: 'Bob', ageVariant: 'adult', important: true, references: [image(2)], notes: 'x' }] } });
  p = reviewed(p);
  // approve roster with intake for both characters
  {
    const a = current(p);
    const intake = { voiceConsent: true, characters: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', minor: false, photoRights: true, references: [image(1)], likeness: 'reference', decisionNotes: 'ISOLATED' }, { id: 'bob', name: 'Bob', ageVariant: 'adult', minor: false, photoRights: true, references: [image(2)], likeness: 'reference', decisionNotes: 'ISOLATED' }], resolvedFindings: [] };
    p = send(p, 'approve', { artifactId: a.id, artifactDigest: a.digest, message: 'ISOLATED roster', intakeConfirmation: intake });
  }
  // earlier character alex has an approved candidates image; current item is bob with none
  const alexFiles = [1, 2, 3].map(n => ({ path: `/isolated-test/alex-${n}.png`, sha256: file(10 + n).sha256, bytes: 100, width: 1200, height: 900 }));
  p.artifacts.push({ id: 'candidates:alex@1', key: 'candidates:alex', kind: 'candidates', version: 1, digest: digest({ files: alexFiles, prompt: 'x' }), content: { files: alexFiles, prompt: 'x' }, dependencies: [], valid: true, authoredBy: 'provider-runtime', approvedBy: { message: 'm', at: new Date().toISOString() }, review: { decision: 'approved', perception: 'direct-image', checks: criteria.candidates.map(criterion => ({ criterion, status: 'pass', location: 'x', evidence: 'x' })) } });
  p.characterId = 'bob';
  p.step = 'candidates';
  p.gate = 'produce';
  const kit = loadStudio();
  const oldVera = kit.documents['crew/vera/SKILL.md'].content + '\n<!-- isolated old -->';
  p.studio.documents['crew/vera/SKILL.md'] = { content: oldVera, sha256: sha(oldVera) };
  p.studio.sha256 = digest({ config: p.studio.config, documents: p.studio.documents });
  p = send(p, 'refresh-visual-instructions', { actor: 'human', message: 'ISOLATED refresh for bob' });
  assert.equal(p.studio.documents['crew/vera/SKILL.md'].content, kit.documents['crew/vera/SKILL.md'].content);
});

test('Vera anatomy pass without crops is accepted when fingers are too small to count but nothing looks wrong', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vera-small-'));
  try {
    const mk = async (name, color) => { const pth = join(dir, name); execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=1200x900`, '-frames:v', '1', pth]); return importMedia(pth, dir); };
    const f = await mk('s0.png', 'green');
    const f1 = await mk('s1.png', 'red');
    const f2 = await mk('s2.png', 'blue');
    let p = initialProject('vera-small', inputs, { workflowRevision: 4, reviewMode: 'supervised' });
    const { crewRoles } = await import('../runtime/crew.mjs');
    const crew = { workers: Object.entries(crewRoles).map(([role, { name }]) => ({ role, name, workerId: `t-${role}`, modelVersion: 'm', capabilityVersion: 'c', execution: 'host' })) };
    p.crew = crew;
    const okReview = { decision: 'approved', perception: 'direct-text', checks: [{ criterion: 'x', status: 'pass', location: 'x', evidence: 'x' }] };
    const humanOk = { decision: 'approved', perception: 'direct-text', checks: [] };
    p.artifacts.push({ id: 'script@1', key: 'script', kind: 'script', version: 1, digest: 's', content: { beats: [1, 2, 3, 4].map(i => ({ beat: i, durationSeconds: 15, narration: 'x', emotionalPurpose: 'c', sourceAnswers: ['scene1Childhood'] })), commonSenseChecks: [] }, dependencies: [], valid: true, authoredBy: 't', approvedBy: { message: 'm', at: new Date().toISOString() }, review: okReview });
    p.artifacts.push({ id: 'roster@1', key: 'roster', kind: 'roster', version: 1, digest: 'r', content: { characters: [{ id: 'alex', name: 'A', ageVariant: 'adult', important: true, references: [image(1)], notes: 'x' }] }, dependencies: [], valid: true, authoredBy: 't', approvedBy: { message: 'm', at: new Date().toISOString() }, review: okReview, humanReview: humanOk });
    p.artifacts.push({ id: 'characterPrompt:alex@1', key: 'characterPrompt:alex', kind: 'characterPrompt', version: 1, digest: 'c', content: { prompt: 'p', characterDigest: 'd', referenceHashes: [image(1).sha256], recipeSha256: 'h' }, dependencies: [], valid: true, authoredBy: 't', approvedBy: { message: 'm', at: new Date().toISOString() }, review: okReview, humanReview: humanOk });
    const files = [f, f1, f2];
    p.artifacts.push({ id: 'candidates:alex@1', key: 'candidates:alex', kind: 'candidates', version: 1, digest: digest({ files, prompt: 'p' }), content: { files, prompt: 'p' }, dependencies: [], valid: true, authoredBy: 't-visual' });
    p.characterId = 'alex';
    p.step = 'candidates';
    p.gate = 'review';
    const task = taskFor(p);
    const verdict = { taskId: task.taskId, action: 'review', actor: 'reviewer', workerId: task.crewWorker.workerId, artifactId: task.artifact.id, artifactDigest: task.artifact.digest, review: { decision: 'approved', perception: 'direct-image', modelVersion: task.crewWorker.modelVersion, capabilityVersion: task.crewWorker.capabilityVersion, checks: task.criteria.map(criterion => criterion === 'anatomy' ? { criterion, status: 'pass', location: 'Full views', evidence: 'Fingers too small to count in the full views but nothing looks wrong; no clearly visible defect.' } : { criterion, status: 'pass', location: 'x', evidence: 'x' }) } };
    const event = await runCrewTask(p, task, { tools: { viewImage: async () => ({ perception: 'direct-image' }) }, runTask: async (_t, { callTool }) => { for (const fl of files) await callTool('viewImage', { sha256: fl.sha256 }); return verdict; } });
    assert.equal(event.review.decision, 'approved');
    assert.equal(event.review.toolEvidence.filter(r => r.tool === 'viewImage' && !r.region).length, 3);
    assert.equal(event.review.toolEvidence.filter(r => r.region).length, 0);
    // the same review is also accepted end to end by the workflow reducer
    const done = send(p, 'review', { workerId: event.workerId, artifactId: event.artifactId, artifactDigest: event.artifactDigest, review: event.review });
    assert.equal(done.gate, 'human');
  } finally { await rm(dir, { recursive: true }); }
});
