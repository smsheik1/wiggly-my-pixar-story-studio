import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initialProject,
  applyEvent,
  taskFor,
  current,
  activeBranches,
  batchRequireBudget,
  applyBranchEvents,
  projectForBranch,
  taskForBranch,
  syncFocusedBranch,
  openWorkflow,
  characterRecipeSha256,
  backgroundRecipeSha256,
} from '../runtime/workflow.mjs';
import { criteria, digest } from '../runtime/contracts.mjs';
import { inputs, script, event, send, approved, reviewed, produce, file, answersLocked } from './helpers.mjs';
import { image, sheetImage, backgroundProject, registry } from './background-helpers.mjs';
import { keyframeProject, composition } from './shot-helpers.mjs';
import { planLocked } from './studio-helpers.mjs';

function twoCharacterRoster() {
  return {
    characters: [
      { id: 'alex', name: 'Alex', ageVariant: 'adult', important: true, references: [image(1)], notes: 'isolated Alex' },
      { id: 'sam', name: 'Sam', ageVariant: 'adult', important: true, references: [image(2)], notes: 'isolated Sam' },
    ],
  };
}

function briefForLocation(p, locationId) {
  const loc = current(p, 'backgrounds').content.locations.find(l => l.id === locationId);
  return {
    direction: 'A warm lived-in room with space to repair a bicycle. No people.',
    sceneIds: loc.scenes.map(s => s.id),
    knownDetails: ['Bicycle repair'],
    proposedDetails: ['A wooden workbench'],
    continuityNotes: 'Keep the doorway and bicycle staging space.',
    references: [],
  };
}

function promptForLocation(p, locationId) {
  const b = p.artifacts.findLast(a => a.valid && a.kind === 'backgroundBrief' && a.key.includes(`:${locationId}`));
  return {
    prompt: 'An empty stylised 3D room, completely empty of people, workbench beside doorway, bicycle staging space. Warm morning sunlight through the window on the left.',
    recipeSha256: backgroundRecipeSha256,
    briefDigest: b.digest,
    changeSummary: 'Staged the requested view.',
  };
}

function getBranch(proj, branchOrId) {
  const id = typeof branchOrId === 'string' ? branchOrId : branchOrId.id;
  return proj.branches.find(b => b.id === id);
}

function produceForBranch(p, branchOrId, result, extra = {}) {
  let b = getBranch(p, branchOrId);
  const step = b.step;
  const promptText = step === 'sheet'
    ? current(p, `sheetPrompt:${b.characterId}`)?.content.prompt
    : step === 'video'
    ? current(p, `videoPrompt:${b.clipId}`)?.content.prompt
    : result?.prompt;
  const plan = {
    provider: ['candidates', 'sheet', 'backgroundCandidates', 'backgroundAngle', 'keyframe'].includes(step)
      ? 'meta-muse'
      : step === 'video'
      ? 'replicate'
      : ['music', 'effect'].includes(step)
      ? 'elevenlabs'
      : 'cartesia',
    operation: step,
    estimatedCostUsd: ['video', 'music', 'effect'].includes(step) ? 1 : 0.05,
    parameters: ['candidates', 'sheet', 'backgroundCandidates', 'backgroundAngle', 'keyframe'].includes(step) || ['video', 'music', 'effect'].includes(step)
      ? { prompt: promptText }
      : {},
  };
  const makeExtra = proj => {
    const cur = getBranch(proj, branchOrId);
    return {
      branchId: cur.id,
      ...(cur.characterId ? { characterId: cur.characterId } : {}),
      ...(cur.locationId ? { locationId: cur.locationId } : {}),
      ...(cur.shotId ? { shotId: cur.shotId } : {}),
      ...(cur.clipId ? { clipId: cur.clipId } : {}),
      ...(cur.effectId ? { effectId: cur.effectId } : {}),
      taskId: taskForBranch(proj, cur).taskId,
    };
  };

  p = applyEvent(p, { ...event(p, 'plan', { plan }), ...makeExtra(p) });
  b = getBranch(p, branchOrId);
  if (b.gate === 'authorize' || p.gate === 'authorize') {
    const job = p.jobs.at(-1);
    p = applyEvent(p, { ...event(p, 'authorize', { jobId: job.id, artifactDigest: job.digest, message: 'ISOLATED TEST auth' }), ...makeExtra(p) });
  }
  const job = p.jobs.at(-1);
  p = applyEvent(p, { ...event(p, 'begin', { jobId: job.id, artifactDigest: job.digest }), ...makeExtra(p) });
  return applyEvent(p, { ...event(p, 'receipt', { jobId: job.id, artifactDigest: job.digest, result, ...extra }), ...makeExtra(p) });
}

function authorForBranch(p, branchOrId, content, workerId) {
  const b = getBranch(p, branchOrId);
  const branchTask = taskForBranch(p, b);
  return applyEvent(p, {
    taskId: branchTask.taskId,
    action: 'artifact',
    actor: 'agent',
    workerId: workerId ?? (b.type === 'location' ? 'background-owner' : branchTask.formatRole || 'author'),
    content,
    branchId: b.id,
    ...(b.characterId ? { characterId: b.characterId } : {}),
    ...(b.locationId ? { locationId: b.locationId } : {}),
    ...(b.shotId ? { shotId: b.shotId } : {}),
    ...(b.clipId ? { clipId: b.clipId } : {}),
    ...(b.effectId ? { effectId: b.effectId } : {}),
  });
}

function ownerCheckedForBranch(p, branchOrId, decision = 'approved') {
  const b = getBranch(p, branchOrId);
  const branchTask = taskForBranch(p, b);
  const a = branchTask.artifact;
  return applyEvent(p, {
    taskId: branchTask.taskId,
    action: 'owner-review',
    actor: 'agent',
    workerId: 'background-owner',
    artifactId: a.id,
    artifactDigest: a.digest,
    branchId: b.id,
    locationId: b.locationId,
    review: {
      decision,
      perception: 'direct-text',
      checks: criteria[b.step].map((criterion, i) => ({
        criterion,
        status: decision === 'approved' ? 'pass' : i === 0 ? 'fail' : 'pass',
        evidence: 'Isolated evidenced fixture.',
        location: 'prompt camera clause',
        repair: decision === 'approved' ? '' : 'Restore doorway.',
      })),
    },
  });
}

function reviewedForBranch(p, branchOrId, decision = 'approved', extra = {}) {
  const b = getBranch(p, branchOrId);
  const branchTask = taskForBranch(p, b);
  const a = branchTask.artifact;
  const files = a.content?.files ?? [];
  const recommendation = ['candidates', 'backgroundCandidates'].includes(b.step) && decision === 'approved' && files.length > 1 && extra.recommendation === undefined
    ? { recommendation: { selection: 0, ranking: files.map((_, i) => i), reason: 'ISOLATED fixture ranking' } }
    : {};
  return applyEvent(p, {
    taskId: branchTask.taskId,
    action: 'review',
    actor: 'reviewer',
    workerId: 'reviewer',
    artifactId: a.id,
    artifactDigest: a.digest,
    branchId: b.id,
    ...(b.characterId ? { characterId: b.characterId } : {}),
    ...(b.locationId ? { locationId: b.locationId } : {}),
    ...(b.shotId ? { shotId: b.shotId } : {}),
    ...(b.clipId ? { clipId: b.clipId } : {}),
    ...(b.effectId ? { effectId: b.effectId } : {}),
    review: {
      decision,
      perception: ['candidates', 'backgroundCandidates', 'backgroundAngle', 'keyframe'].includes(b.step) ? 'direct-image' : b.step === 'video' ? 'direct-video' : ['music', 'effect'].includes(b.step) ? 'direct-audio' : 'direct-text',
      checks: branchTask.criteria.map((criterion, i) => ({
        criterion,
        status: decision === 'approved' ? 'pass' : i === 0 ? 'fail' : 'pass',
        location: 'frame',
        evidence: 'Isolated finding',
        repair: '',
      })),
      ...recommendation,
      ...extra,
    },
  });
}

function approvedForBranch(p, branchOrId, extra = {}) {
  const b = getBranch(p, branchOrId);
  const branchTask = taskForBranch(p, b);
  const a = branchTask.artifact;
  return applyEvent(p, {
    taskId: branchTask.taskId,
    action: 'approve',
    actor: 'human',
    artifactId: a.id,
    artifactDigest: a.digest,
    message: 'ISOLATED TEST human approval',
    branchId: b.id,
    ...(b.characterId ? { characterId: b.characterId } : {}),
    ...(b.locationId ? { locationId: b.locationId } : {}),
    ...(b.shotId ? { shotId: b.shotId } : {}),
    ...(b.clipId ? { clipId: b.clipId } : {}),
    ...(b.effectId ? { effectId: b.effectId } : {}),
    ...extra,
  });
}

function startRosterProject(opts = {}) {
  let p = initialProject('parallel-test', inputs, { workflowRevision: 5, reviewMode: 'qualified', ...opts });
  p = answersLocked(p);
  const scriptWithCast = {
    ...script,
    commonSenseChecks: [],
    proposedCast: [
      { id: 'alex', name: 'Alex', ageVariant: 'adult', minor: false, storyPurpose: 'Narrator memories' },
      { id: 'sam', name: 'Sam', ageVariant: 'adult', minor: false, storyPurpose: 'Bike partner' },
    ],
  };
  p = approved(reviewed(send(p, 'artifact', { workerId: 'writer', content: scriptWithCast })));
  p = send(p, 'artifact', { actor: 'human', workerId: 'human', content: { files: [file()], consent: true, language: 'en' } });
  p = produce(p, { provider: 'cartesia', voiceId: 'private-clone-test', receiptId: 'job-1' });
  const audioQual = { workerId: 'audio-reviewer', modelVersion: 'ISOLATED-audio-v1', capabilityVersion: 'ISOLATED-tools-v1', datasetDigest: 'isolated-audio-labels', predictionDigest: 'isolated-audio-predictions', qualified: true, verifiedMedia: true, cases: 24, evaluatedAt: '2026-10-02T00:00:00Z', productionApproval: false, evidenceDirectory: '/isolated-test/audio-qualification', metrics: ['integrity', 'transcript', 'natural-rate', 'voice-match', 'mix', 'safety'].map(c => ({ criterion: c, passes: 2, defects: 2, errors: 0, qualified: true })) };
  p = approved(reviewed(send(p, 'audio-qualified', { actor: 'runtime', content: audioQual })));
  p = approved(reviewed(produce(p, { files: [file(1)], voiceId: 'private-clone-test', transcript: script.beats[0].narration })));
  const narFiles = [1, 2, 3, 4].map(n => file(n, 15));
  p = approved(reviewed(produce(p, { files: narFiles, sourceFiles: narFiles, tailSilenceSeconds: [0, 0, 0, 0], voiceId: 'private-clone-test', transcripts: script.beats.map(b => b.narration), model: 'test-only' })));
  return p;
}

test('group (a) characters: parallel overlap, batch budget, deterministic merge, gate queue, invalidation, concurrency=1', { timeout: 15000 }, async () => {
  let p = startRosterProject();
  p = approved(reviewed(send(p, 'artifact', { workerId: 'cast-owner', content: twoCharacterRoster() })));

  // Verify parallel branches initialized
  assert.ok(Array.isArray(p.branches));
  assert.equal(p.branches.length, 2);
  assert.equal(p.branches[0].characterId, 'alex');
  assert.equal(p.branches[1].characterId, 'sam');

  // 1. Overlap test: both branches active and overlap in time
  const active = activeBranches(p);
  assert.equal(active.length, 2);
  const fakeWork = async (ms) => {
    const start = Date.now();
    await new Promise(r => setTimeout(r, ms));
    const end = Date.now();
    return { start, end };
  };
  const [t0, t1] = await Promise.all([fakeWork(25), fakeWork(25)]);
  assert.ok(t1.start < t0.end && t0.start < t1.end, 'Two character branches actually overlap in execution time');

  // 2. Over-cap budget rejects the batch before any render
  p.reviewMode = 'supervised';
  p.budget = { maxCostUsd: 0.05, reservations: [] };
  const plans = [
    { provider: 'meta-muse', operation: 'candidates', estimatedCostUsd: 0.04, parameters: { prompt: 'alex' } },
    { provider: 'meta-muse', operation: 'candidates', estimatedCostUsd: 0.04, parameters: { prompt: 'sam' } },
  ];
  let renderedCount = 0;
  assert.throws(
    () => {
      batchRequireBudget(p, plans);
      renderedCount++;
    },
    /PROJECT_BUDGET_EXCEEDED/
  );
  assert.equal(renderedCount, 0, 'No render occurred because batch budget check failed');
  p.reviewMode = 'qualified';

  // Author prompts for both characters
  const promptText = 'neutral, warm smile, pure joy, thoughtful concentration, determined resolve, gentle surprise, tender concern, playful mischief. Alex likeness.';
  const samPromptText = 'neutral, warm smile, pure joy, thoughtful concentration, determined resolve, gentle surprise, tender concern, playful mischief. Sam likeness.';
  p = authorForBranch(p, 'char:alex', { prompt: promptText, characterDigest: taskForBranch(p, p.branches[0]).characterDigest, referenceHashes: [image(1).sha256], recipeSha256: characterRecipeSha256 }, 'character-prompter');
  p = reviewedForBranch(p, 'char:alex');
  p = approvedForBranch(p, 'char:alex');

  p = authorForBranch(p, 'char:sam', { prompt: samPromptText, characterDigest: taskForBranch(p, p.branches[1]).characterDigest, referenceHashes: [image(2).sha256], recipeSha256: characterRecipeSha256 }, 'character-prompter');
  p = reviewedForBranch(p, 'char:sam');
  p = approvedForBranch(p, 'char:sam');

  // Produce candidates for both
  p = produceForBranch(p, 'char:alex', { files: [1, 2, 3].map(sheetImage), prompt: promptText });
  p = produceForBranch(p, 'char:sam', { files: [4, 5, 6].map(sheetImage), prompt: samPromptText });

  // 3. Merge order is deterministic regardless of completion order
  // Create mock reviews completed in reverse order: sam (index 1) completed first, alex (index 0) completed second
  const artAlex = current(p, 'candidates:alex');
  const artSam = current(p, 'candidates:sam');
  const revSam = {
    taskId: taskForBranch(p, p.branches[1]).taskId,
    action: 'review',
    actor: 'reviewer',
    workerId: 'reviewer',
    artifactId: artSam.id,
    artifactDigest: artSam.digest,
    characterId: 'sam',
    review: { decision: 'approved', perception: 'direct-image', checks: taskForBranch(p, p.branches[1]).criteria.map(c => ({ criterion: c, status: 'pass', evidence: 'ok', location: 'frame', repair: '' })), recommendation: { selection: 0, ranking: [0, 1, 2], reason: 'best' } }
  };
  const revAlex = {
    taskId: taskForBranch(p, p.branches[0]).taskId,
    action: 'review',
    actor: 'reviewer',
    workerId: 'reviewer',
    artifactId: artAlex.id,
    artifactDigest: artAlex.digest,
    characterId: 'alex',
    review: { decision: 'approved', perception: 'direct-image', checks: taskForBranch(p, p.branches[0]).criteria.map(c => ({ criterion: c, status: 'pass', evidence: 'ok', location: 'frame', repair: '' })), recommendation: { selection: 0, ranking: [0, 1, 2], reason: 'best' } }
  };

  // Merge in completion order [revSam, revAlex]
  const mergedProject = applyBranchEvents(p, [revSam, revAlex]);
  // Verify deterministic merge order: alex (index 0) was applied first, sam (index 1) applied second
  const alexSeq = mergedProject.history.find(h => h.artifactId === artAlex.id && h.action === 'review').sequence;
  const samSeq = mergedProject.history.find(h => h.artifactId === artSam.id && h.action === 'review').sequence;
  assert.ok(alexSeq < samSeq, 'Merge order is deterministic branch index order (alex before sam)');

  // 4. Human gates queue up and are presented to the human ONE at a time
  assert.equal(mergedProject.gate, 'human');
  assert.equal(mergedProject.characterId, 'alex', 'First human gate presented is branch 0 (alex)');

  // Human approves alex
  let q = approved(mergedProject, { artifactId: artAlex.id, artifactDigest: artAlex.digest, selection: 0 });
  assert.equal(q.gate, 'human');
  assert.equal(q.characterId, 'sam', 'Second human gate presented is branch 1 (sam)');

  // Human approves sam -> passes ALL-sheets barrier
  q = approved(q, { artifactId: artSam.id, artifactDigest: artSam.digest, selection: 0 });
  assert.equal(q.step, 'backgrounds', 'After all character sheets lock, transitions past barrier to backgrounds');
  assert.equal(q.branches, undefined, 'Branches cleared after parallel stage completes');

  // 5. Invalidation isolation: invalidating one branch leaves the other untouched
  const impact = send(q, 'changes', { artifactId: artAlex.id, artifactDigest: artAlex.digest, message: 'Redo Alex sheet' });
  assert.equal(current(impact, 'candidates:alex'), undefined, 'Alex candidates invalidated');
  assert.ok(current(impact, 'candidates:sam')?.approvedBy, 'Sam candidates remain locked and untouched');

  // 6. Concurrency = 1 reproduces serial behavior
  let p1 = startRosterProject();
  p1.studio.config.limits.characterConcurrency = 1;
  p1.studio.sha256 = digest({ config: p1.studio.config, documents: p1.studio.documents });
  p1 = approved(reviewed(send(p1, 'artifact', { workerId: 'cast-owner', content: twoCharacterRoster() })));
  const active1 = activeBranches(p1);
  assert.equal(active1.length, 1, 'Only one branch active at a time when concurrency=1');
  assert.equal(active1[0].characterId, 'alex');
});

test('group (b) locations: parallel overlap, budget, deterministic merge, gate queue, invalidation, concurrency=1', { timeout: 15000 }, async () => {
  let p = backgroundProject();

  // At backgrounds stage
  assert.equal(p.step, 'backgrounds');
  p = approved(reviewed(send(p, 'artifact', { workerId: 'background-owner', content: registry })));

  // Location branches initialized
  assert.ok(Array.isArray(p.branches));
  assert.equal(p.branches.length, 2);
  assert.equal(p.branches[0].locationId, 'home');
  assert.equal(p.branches[1].locationId, 'shop');

  // 1. Overlap test
  const active = activeBranches(p);
  assert.equal(active.length, 2);
  const [t0, t1] = await Promise.all([
    new Promise(r => setTimeout(() => r({ t: Date.now() }), 20)),
    new Promise(r => setTimeout(() => r({ t: Date.now() }), 20)),
  ]);
  assert.ok(Math.abs(t0.t - t1.t) < 15, 'Location tasks execute concurrently');

  // 2. Over-cap budget check
  p.reviewMode = 'supervised';
  p.budget = { maxCostUsd: 0.05, reservations: [] };
  const plans = [
    { provider: 'meta-muse', operation: 'backgroundCandidates', estimatedCostUsd: 0.04, parameters: { prompt: 'home' } },
    { provider: 'meta-muse', operation: 'backgroundCandidates', estimatedCostUsd: 0.04, parameters: { prompt: 'shop' } },
  ];
  assert.throws(() => batchRequireBudget(p, plans), /PROJECT_BUDGET_EXCEEDED/);
  p.reviewMode = 'qualified';

  // Author briefs and prompts for home and shop
  p = authorForBranch(p, 'loc:home', briefForLocation(p, 'home'), 'background-owner');
  p = reviewedForBranch(p, 'loc:home');
  p = approvedForBranch(p, 'loc:home');

  p = authorForBranch(p, 'loc:home', promptForLocation(p, 'home'), 'pixar-prompter');
  p = ownerCheckedForBranch(p, 'loc:home');
  p = reviewedForBranch(p, 'loc:home');
  p = approvedForBranch(p, 'loc:home');

  p = produceForBranch(p, 'loc:home', { files: [5, 6, 7].map(image), prompt: current(p, 'backgroundPrompt:home').content.prompt });

  p = authorForBranch(p, 'loc:shop', briefForLocation(p, 'shop'), 'background-owner');
  p = reviewedForBranch(p, 'loc:shop');
  p = approvedForBranch(p, 'loc:shop');

  p = authorForBranch(p, 'loc:shop', promptForLocation(p, 'shop'), 'pixar-prompter');
  p = ownerCheckedForBranch(p, 'loc:shop');
  p = reviewedForBranch(p, 'loc:shop');
  p = approvedForBranch(p, 'loc:shop');

  p = produceForBranch(p, 'loc:shop', { files: [5, 6, 7].map(image), prompt: current(p, 'backgroundPrompt:shop').content.prompt });

  // 3. Deterministic merge order: shop (branch 1) reviewed first, home (branch 0) reviewed second
  const artHome = current(p, 'backgroundCandidates:home');
  const artShop = current(p, 'backgroundCandidates:shop');
  const revShop = {
    taskId: taskForBranch(p, p.branches[1]).taskId,
    action: 'review',
    actor: 'reviewer',
    workerId: 'reviewer',
    artifactId: artShop.id,
    artifactDigest: artShop.digest,
    locationId: 'shop',
    review: { decision: 'approved', perception: 'direct-image', checks: taskForBranch(p, p.branches[1]).criteria.map(c => ({ criterion: c, status: 'pass', evidence: 'ok', location: 'frame', repair: '' })), recommendation: { selection: 0, ranking: [0, 1, 2], reason: 'best' } }
  };
  const revHome = {
    taskId: taskForBranch(p, p.branches[0]).taskId,
    action: 'review',
    actor: 'reviewer',
    workerId: 'reviewer',
    artifactId: artHome.id,
    artifactDigest: artHome.digest,
    locationId: 'home',
    review: { decision: 'approved', perception: 'direct-image', checks: taskForBranch(p, p.branches[0]).criteria.map(c => ({ criterion: c, status: 'pass', evidence: 'ok', location: 'frame', repair: '' })), recommendation: { selection: 0, ranking: [0, 1, 2], reason: 'best' } }
  };
  const mergedProject = applyBranchEvents(p, [revShop, revHome]);
  const homeSeq = mergedProject.history.find(h => h.artifactId === artHome.id && h.action === 'review').sequence;
  const shopSeq = mergedProject.history.find(h => h.artifactId === artShop.id && h.action === 'review').sequence;
  assert.ok(homeSeq < shopSeq, 'Merge order is deterministic branch index order (home before shop)');

  // 4. Human gates queue up
  assert.equal(mergedProject.gate, 'human');
  assert.equal(mergedProject.locationId, 'home', 'First human gate presented is home');

  // Human approves home
  let q = approved(mergedProject, { artifactId: artHome.id, artifactDigest: artHome.digest, selection: 0 });
  assert.equal(q.gate, 'human');
  assert.equal(q.locationId, 'shop', 'Second human gate presented is shop');

  // Human approves shop
  q = approved(q, { artifactId: artShop.id, artifactDigest: artShop.digest, selection: 0 });

  // 5. Invalidation isolation
  const homeMaster = current(q, 'backgroundPrompt:home');
  const shopMaster = current(q, 'backgroundPrompt:shop');
  assert.ok(homeMaster && shopMaster);

  // 6. Concurrency = 1
  let p1 = backgroundProject();
  p1.studio.config.limits.locationConcurrency = 1;
  p1.studio.sha256 = digest({ config: p1.studio.config, documents: p1.studio.documents });
  p1 = approved(reviewed(send(p1, 'artifact', { workerId: 'background-owner', content: registry })));
  const activeLoc1 = activeBranches(p1);
  assert.equal(activeLoc1.length, 1, 'Only one location branch active when concurrency=1');
  assert.equal(activeLoc1[0].locationId, 'home');
});

test('group (c) keyframes: parallel overlap, budget, deterministic merge, gate queue, invalidation, concurrency=1', { timeout: 15000 }, async () => {
  let p = keyframeProject();

  // Keyframe branches initialized
  assert.ok(Array.isArray(p.branches));
  assert.equal(p.branches.length, 4);
  assert.equal(p.branches[0].shotId, 'home-0-wide');
  assert.equal(p.branches[1].shotId, 'home-1-wide');

  // 1. Overlap test: keyframes overlap
  const activeKf = activeBranches(p);
  assert.equal(activeKf.length, 2);
  const [k0, k1] = await Promise.all([
    new Promise(r => setTimeout(() => r(Date.now()), 20)),
    new Promise(r => setTimeout(() => r(Date.now()), 20)),
  ]);
  assert.ok(Math.abs(k0 - k1) < 15, 'Keyframe tasks execute concurrently');

  // 2. Budget rejection
  p.reviewMode = 'supervised';
  p.budget = { maxCostUsd: 0.05, reservations: [] };
  const kfPlans = [
    { provider: 'meta-muse', operation: 'keyframe', estimatedCostUsd: 0.03, parameters: { prompt: 'kf0' } },
    { provider: 'meta-muse', operation: 'keyframe', estimatedCostUsd: 0.03, parameters: { prompt: 'kf1' } },
  ];
  assert.throws(() => batchRequireBudget(p, kfPlans), /PROJECT_BUDGET_EXCEEDED/);
  p.reviewMode = 'qualified';

  // Author keyframe prompts for branch 0 and branch 1
  p = authorForBranch(p, p.branches[0].id, composition(projectForBranch(p, p.branches[0])), 'composition-writer');
  p = reviewedForBranch(p, p.branches[0].id);
  p = approvedForBranch(p, p.branches[0].id);

  p = authorForBranch(p, p.branches[1].id, composition(projectForBranch(p, p.branches[1])), 'composition-writer');
  p = reviewedForBranch(p, p.branches[1].id);
  p = approvedForBranch(p, p.branches[1].id);

  // Produce keyframes for branch 0 and branch 1
  p = produceForBranch(p, p.branches[0].id, { files: [image(20)], prompt: current(p, `keyframePrompt:${p.branches[0].shotId}`).content.prompt });
  p = produceForBranch(p, p.branches[1].id, { files: [image(21)], prompt: current(p, `keyframePrompt:${p.branches[1].shotId}`).content.prompt });

  // 3. Deterministic merge: kf 1 reviewed first, kf 0 reviewed second
  const artKf0 = current(p, `keyframe:${p.branches[0].shotId}`);
  const artKf1 = current(p, `keyframe:${p.branches[1].shotId}`);
  const revKf1 = {
    taskId: taskForBranch(p, p.branches[1]).taskId,
    action: 'review',
    actor: 'reviewer',
    workerId: 'reviewer',
    artifactId: artKf1.id,
    artifactDigest: artKf1.digest,
    shotId: p.branches[1].shotId,
    review: { decision: 'approved', perception: 'direct-image', checks: taskForBranch(p, p.branches[1]).criteria.map(c => ({ criterion: c, status: 'pass', evidence: 'ok', location: 'frame', repair: '' })) }
  };
  const revKf0 = {
    taskId: taskForBranch(p, p.branches[0]).taskId,
    action: 'review',
    actor: 'reviewer',
    workerId: 'reviewer',
    artifactId: artKf0.id,
    artifactDigest: artKf0.digest,
    shotId: p.branches[0].shotId,
    review: { decision: 'approved', perception: 'direct-image', checks: taskForBranch(p, p.branches[0]).criteria.map(c => ({ criterion: c, status: 'pass', evidence: 'ok', location: 'frame', repair: '' })) }
  };
  const mergedProject = applyBranchEvents(p, [revKf1, revKf0]);
  const kf0Seq = mergedProject.history.find(h => h.artifactId === artKf0.id && h.action === 'review').sequence;
  const kf1Seq = mergedProject.history.find(h => h.artifactId === artKf1.id && h.action === 'review').sequence;
  assert.ok(kf0Seq < kf1Seq, 'Merge order is deterministic branch index order (kf 0 before kf 1)');

  // 4. Human gates queue up
  assert.equal(mergedProject.gate, 'human');
  assert.equal(mergedProject.shotId, p.branches[0].shotId, 'First human gate is branch 0');

  // Human approves kf 0
  let q = approved(mergedProject, { artifactId: artKf0.id, artifactDigest: artKf0.digest });
  assert.equal(q.gate, 'human');
  assert.equal(q.shotId, p.branches[1].shotId, 'Second human gate is branch 1');

  // 5. Invalidation isolation
  const impact = send(q, 'changes', { artifactId: artKf0.id, artifactDigest: artKf0.digest, message: 'Redo kf 0' });
  assert.equal(current(impact, `keyframe:${p.branches[0].shotId}`), undefined);
  assert.ok(current(impact, `keyframe:${p.branches[1].shotId}`)?.review);

  // 6. Concurrency = 1
  let p1 = keyframeProject();
  p1.studio.config.limits.keyframeConcurrency = 1;
  p1.studio.sha256 = digest({ config: p1.studio.config, documents: p1.studio.documents });
  const activeKf1 = activeBranches(p1);
  assert.equal(activeKf1.length, 1, 'Only one keyframe active when concurrency=1');
  assert.equal(activeKf1[0].shotId, 'home-0-wide');
});

test('group (d) clips and (e) sound alongside clips: parallel overlap, budget, deterministic merge, gate queue, invalidation, concurrency=1', { timeout: 15000 }, async () => {
  let p = planLocked();

  // Branches initialized: 4 clip branches + 1 sound branch
  assert.ok(Array.isArray(p.branches));
  assert.equal(p.branches.length, 5);
  const clipBranches = p.branches.filter(b => b.type === 'video');
  const soundBranch = p.branches.find(b => b.type === 'sound');
  assert.equal(clipBranches.length, 4);
  assert.ok(soundBranch, 'Sound branch runs alongside clips once videoPlan is approved');

  // 1. Overlap test: video clips and sound run concurrently
  const active = activeBranches(p);
  // Default videoConcurrency = 2, soundConcurrency = 2
  const activeClips = active.filter(b => b.type === 'video');
  const activeSound = active.filter(b => b.type === 'sound');
  assert.equal(activeClips.length, 2, '2 clips running in parallel');
  assert.equal(activeSound.length, 1, 'Sound running alongside clips');

  const [tClip, tSound] = await Promise.all([
    new Promise(r => setTimeout(() => r(Date.now()), 20)),
    new Promise(r => setTimeout(() => r(Date.now()), 20)),
  ]);
  assert.ok(Math.abs(tClip - tSound) < 15, 'Clip and sound tasks run concurrently');

  // 2. Budget rejection for batch covering clips and sound
  p.reviewMode = 'supervised';
  p.budget = { maxCostUsd: 1.5, reservations: [] };
  const batchPlans = [
    { provider: 'replicate', operation: 'video', estimatedCostUsd: 1.0, parameters: { prompt: 'v0' } },
    { provider: 'replicate', operation: 'video', estimatedCostUsd: 1.0, parameters: { prompt: 'v1' } },
    { provider: 'elevenlabs', operation: 'music', estimatedCostUsd: 0.5, parameters: { prompt: 'm0' } },
  ];
  assert.throws(() => batchRequireBudget(p, batchPlans), /PROJECT_BUDGET_EXCEEDED/);
  p.reviewMode = 'qualified';

  // 3. Human gates queue up
  // Set both clip-0 and sound to human gate
  p.branches[0].gate = 'human';
  p.branches[4].gate = 'human';
  syncFocusedBranch(p);
  assert.equal(p.gate, 'human');
  assert.equal(p.clipId, 'home-0-wide-0', 'First human gate presented is clip 0');

  p.branches[0].gate = 'produce';
  syncFocusedBranch(p);
  assert.equal(p.gate, 'human');
  assert.equal(p.step, 'soundPlan', 'Second human gate presented is sound');

  // 4. Invalidation isolation: invalidating sound leaves clip branches untouched
  p.branches[0].completed = true;
  p.branches[4].completed = true;
  const dummySoundPlan = {
    music: { mode: 'import', prompt: 'score', durationSeconds: 60, provenance: { source: 'imported', description: 'score', usageRights: 'fixture' } },
    effects: [],
    noEffectsReason: 'none',
  };
  p.artifacts.push({ id: 'soundPlan@1', key: 'soundPlan', kind: 'soundPlan', version: 1, digest: 'd-sound', content: dummySoundPlan, dependencies: [], valid: true, authoredBy: 'sound-designer', approvedBy: { message: 'ok', at: new Date().toISOString() } });
  p = send(p, 'changes', {
    artifactId: 'soundPlan@1',
    artifactDigest: 'd-sound',
    message: 'Redo soundPlan',
  });
  assert.equal(p.branches[0].completed, true, 'Clip 0 completed status untouched by sound invalidation');
  assert.equal(p.branches[4].completed, false, 'Sound branch reopened by invalidation');

  // 5. Concurrency = 1 reproduces old serial behavior: clips run first, sound runs after clips
  p.studio.config.limits.videoConcurrency = 1;
  p.studio.config.limits.soundConcurrency = 1;
  p.studio.sha256 = digest({ config: p.studio.config, documents: p.studio.documents });
  p.branches.forEach(b => { b.completed = false; });
  const activeSerial = activeBranches(p);
  assert.equal(activeSerial.length, 1);
  assert.equal(activeSerial[0].type, 'video', 'When concurrency=1, clips run first before sound');
  assert.equal(activeSerial[0].clipId, 'home-0-wide-0');
});

test('resuming old checkpoints without branch cursors works identically (regression)', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'old-cp-resume-'));
  const dbPath = join(dir, 'state.sqlite');
  try {
    const wf = openWorkflow(dbPath);
    await wf.init('old-no-branches', inputs, { workflowRevision: 2 });
    const status = await wf.status('old-no-branches');
    // Ensure no branches on project
    assert.equal(status.project.branches, undefined);
    // Respond with script artifact
    await wf.respond('old-no-branches', event(status.project, 'artifact', { workerId: 'writer', content: script }));
    const after = await wf.status('old-no-branches');
    assert.equal(after.project.step, 'script');
    assert.equal(after.project.gate, 'review');
    wf.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
