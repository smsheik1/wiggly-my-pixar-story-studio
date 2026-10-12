// P17 run 2: SPEC 9, 11, 12, 14. Invented fixtures only.
// No network, no providers, no real codex, no child processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialProject, taskFor, current, applyEvent } from '../runtime/workflow.mjs';
import { prepareCrewTask } from '../runtime/crew.mjs';
import { generationEstimate, requestDescriptor } from '../runtime/providers.mjs';
import { validateVideoPlan } from '../runtime/studio.mjs';
import { validateShots } from '../runtime/shots.mjs';
import { AudioEditPlan, AudioEditReceipt, validateAudioEdit } from '../runtime/audio-edit.mjs';
import { Content, Project, digest } from '../runtime/contracts.mjs';
import { inputs, script, file, send, event, reviewed, approved, audioProject, produce } from './helpers.mjs';
import { author, image } from './background-helpers.mjs';
import { shotsProject, shotPlan } from './shot-helpers.mjs';
import { planLocked, videoPlan, videoPrompt, videoReady, videoResult, videosLocked, soundPlan, qualification, visualProject } from './studio-helpers.mjs';

// Hard safety: network calls prohibited
globalThis.fetch = () => { throw new Error('FETCH_PROHIBITED: Network calls are forbidden in p17-plans.test.mjs.'); };

const T = { timeout: 20000 };
const audio = (n, durationSeconds = 60) => ({ path: `/isolated-test/sound-${n}.wav`, sha256: String(n).padStart(64, '0'), bytes: 1024, durationSeconds });

// ---- SPEC 9a: one clip per shot ----

test('P17 SPEC9: one clip per shot passes; two clips for one shot rejected', T, () => {
  const p = planLocked();
  const plan = videoPlan(p);
  assert.equal(plan.clips.length, 4);
  for (const clip of plan.clips) {
    const shot = current(p, 'shots').content.shots.find(s => s.id === clip.shotId);
    assert.equal(clip.startSeconds, 0);
    assert.equal(clip.durationSeconds, shot.durationSeconds);
  }
  const dup = structuredClone(plan);
  const first = dup.clips[0];
  dup.clips.push({ ...first, id: `${first.shotId}-extra`, startSeconds: first.durationSeconds, durationSeconds: first.durationSeconds });
  assert.throws(() => validateVideoPlan(p, dup), /VIDEO_PLAN_ONE_CLIP_PER_SHOT/);
});

test('P17 SPEC9: nonzero start or short duration rejected with one-clip code', T, () => {
  const p = planLocked();
  const base = videoPlan(p);
  assert.throws(() => validateVideoPlan(p, { ...base, clips: base.clips.map((c, i) => i ? c : { ...c, startSeconds: 1 }) }), /VIDEO_PLAN_ONE_CLIP_PER_SHOT/);
  assert.throws(() => validateVideoPlan(p, { ...base, clips: base.clips.map((c, i) => i ? c : { ...c, durationSeconds: c.durationSeconds - 1 }) }), /VIDEO_PLAN_ONE_CLIP_PER_SHOT/);
  assert.throws(() => validateVideoPlan(p, { ...base, clips: base.clips.slice(1) }), /VIDEO_PLAN_ONE_CLIP_PER_SHOT/);
});

test('P17 SPEC9: authoring a two-clip plan is rejected at the gate', T, () => {
  let p = visualProject();
  p = approved(reviewed(send(p, 'qualified', { actor: 'runtime', content: qualification })));
  assert.equal(p.step, 'videoPlan');
  assert.equal(p.gate, 'author');
  const plan = videoPlan(p);
  const dup = structuredClone(plan);
  dup.clips.push({ ...dup.clips[0], id: `${dup.clips[0].shotId}-extra`, startSeconds: dup.clips[0].durationSeconds });
  assert.throws(() => author(p, dup, 'motion-director'), /VIDEO_PLAN_ONE_CLIP_PER_SHOT/);
});

// ---- SPEC 9b: shot frame alignment ----

function splitBeatOne(p, d1, d2) {
  const base = current(p, 'shots') ? null : null;
  const shots = shotPlan.shots.flatMap(s => {
    if (s.beat !== 1) return [s];
    const a = { ...s, durationSeconds: d1, startSeconds: 0 };
    const b = { ...s, id: `${s.id}-b`, durationSeconds: d2, startSeconds: d1 };
    return [a, b];
  });
  return { shots };
}

test('P17 SPEC9: non-frame shot durations rejected with SHOT_FRAME_ALIGNMENT', T, () => {
  const p = shotsProject();
  assert.throws(() => author(p, splitBeatOne(p, 7.51, 7.49), 'shot-planner'), /SHOT_FRAME_ALIGNMENT/);
  assert.throws(() => author(p, { shots: shotPlan.shots.map(s => ({ ...s, durationSeconds: 3.75 })) }, 'shot-planner'), /SHOT_FRAME_ALIGNMENT|Each beat requires/);
});

test('P17 SPEC9: frame-aligned split beat passes the new check', T, () => {
  const p = shotsProject();
  const q = author(p, splitBeatOne(p, 7.5, 7.5), 'shot-planner');
  assert.equal(current(q, 'shots').content.shots.filter(s => s.beat === 1).length, 2);
});

test('P17 SPEC9: old stored shots artifacts still parse without re-validation', T, () => {
  const p = shotsProject();
  const stored = structuredClone(p);
  stored.artifacts.push({ id: 'shots@99', key: 'shots', kind: 'shots', version: 99, digest: digest({ shots: [] }), content: { shots: [] }, dependencies: [], valid: true, authoredBy: 'human' });
  assert.doesNotThrow(() => Project.parse(stored));
});

// ---- SPEC 11: sourced generation rates ----

test('P17 SPEC11: studio.json carries sourced video/music/effect rates and no clone rate', T, () => {
  const studioJson = JSON.parse(readFileSync(new URL('../studio.json', import.meta.url), 'utf8'));
  const videoRate = studioJson.generation.video.rates['seedance-2.0-mini@480p'];
  assert.equal(videoRate.usdPerSecond, 0.04);
  assert.equal(videoRate.source, 'https://replicate.com/bytedance/seedance-2.0-mini');
  assert.equal(videoRate.verifiedAt, '2026-10-11');
  assert.match(videoRate.basis, /seedance-2\.0-mini/);
  assert.equal(studioJson.generation.video.rates['seedance-2.0@1080p'], undefined);
  assert.equal(studioJson.generation.music.usdPerMinute, 0.15);
  assert.equal(studioJson.generation.music.source, 'https://elevenlabs.io/pricing/api');
  assert.equal(studioJson.generation.music.verifiedAt, '2026-10-11');
  assert.match(studioJson.generation.music.basis, /music_length_ms 60000/);
  assert.equal(studioJson.generation.effect.usdPerMinute, 0.12);
  assert.equal(studioJson.generation.effect.source, 'https://elevenlabs.io/pricing/api');
  assert.equal(studioJson.generation.effect.verifiedAt, '2026-10-11');
  assert.equal(studioJson.generation.clone, undefined);
});

test('P17 SPEC11: video estimate is generationSeconds x rate, rounded up, min $0.01', T, () => {
  const p = videoReady();
  const legacy = generationEstimate({ ...p, productionProfile: 'legacy-seedance-hd' }, 'video');
  assert.equal(legacy, null);
  const mini = generationEstimate({ ...p, productionProfile: 'seedance-mini-480p' }, 'video');
  assert.equal(mini.provider, 'replicate');
  assert.equal(mini.operation, 'video');
  assert.equal(mini.generationSeconds, 15);
  assert.equal(mini.usdPerSecond, 0.04);
  assert.equal(mini.estimatedCostUsd, 0.6);
  assert.equal(mini.source, 'https://replicate.com/bytedance/seedance-2.0-mini');
  assert.equal(mini.verifiedAt, '2026-10-11');
  assert.match(mini.basis, /per second/);
});

test('P17 SPEC11: music is $0.15 and effect is duration-proportional with $0.01 floor', T, () => {
  const p = audioProject();
  const music = generationEstimate(p, 'music');
  assert.equal(music.provider, 'elevenlabs');
  assert.equal(music.estimatedCostUsd, 0.15);
  assert.equal(music.source, 'https://elevenlabs.io/pricing/api');
  let q = approved(reviewed(author(videosLocked(), soundPlan, 'sound-designer')));
  q = approved(reviewed(send(q, 'artifact', { workerId: 'sound-designer', content: { files: [audio(80, 60)], prompt: soundPlan.music.prompt, provenance: soundPlan.music.provenance } })));
  assert.equal(q.step, 'effect');
  const effect = generationEstimate(q, 'effect');
  assert.equal(effect.provider, 'elevenlabs');
  assert.equal(effect.durationSeconds, 1);
  assert.equal(effect.estimatedCostUsd, 0.01);
  assert.equal(generationEstimate(p, 'clone'), null);
});

const generateSoundPlan = () => {
  const plan = structuredClone(soundPlan);
  plan.music.mode = 'generate'; plan.music.provenance = { source: 'generated', description: 'ISOLATED generated score.', usageRights: 'ISOLATED TEST fixture.' };
  plan.effects[0].mode = 'generate'; plan.effects[0].provenance = { source: 'generated', description: 'ISOLATED generated bell.', usageRights: 'ISOLATED TEST fixture.' };
  return plan;
};

test('P17 SPEC11: below-estimate video/music plans rejected, at-estimate accepted', T, () => {
  const p = videoReady();
  const mini = { ...p, productionProfile: 'seedance-mini-480p' };
  const clipPrompt = current(mini, `videoPrompt:${mini.clipId}`).content.prompt;
  assert.throws(() => requestDescriptor(mini, { provider: 'replicate', operation: 'video', estimatedCostUsd: 0.59, parameters: { prompt: clipPrompt } }), /VIDEO_ESTIMATE_REQUIRED/);
  assert.ok(requestDescriptor(mini, { provider: 'replicate', operation: 'video', estimatedCostUsd: 0.6, parameters: { prompt: clipPrompt } }));
  let q = approved(reviewed(author(videosLocked(), generateSoundPlan(), 'sound-designer')));
  q.step = 'music'; q.gate = 'produce'; q.clipId = null;
  assert.throws(() => requestDescriptor(q, { provider: 'elevenlabs', operation: 'music', estimatedCostUsd: 0.14, parameters: { prompt: generateSoundPlan().music.prompt } }), /SOUND_ESTIMATE_REQUIRED/);
  assert.ok(requestDescriptor(q, { provider: 'elevenlabs', operation: 'music', estimatedCostUsd: 0.15, parameters: { prompt: generateSoundPlan().music.prompt } }));
});

test('P17 SPEC11: produce packet carries the estimate; legacy snapshots without rates still load', T, async () => {
  const p = videoReady();
  const mini = { ...p, productionProfile: 'seedance-mini-480p', gate: 'produce' };
  const task = taskFor(mini);
  assert.equal(task.generationEstimate.estimatedCostUsd, 0.6);
  await prepareCrewTask(mini, task);
  const noStudio = { ...p };
  delete noStudio.studio;
  assert.equal(generationEstimate(noStudio, 'video'), null);
  assert.equal(generationEstimate(noStudio, 'music'), null);
  assert.equal(generationEstimate(noStudio, 'effect'), null);
  assert.doesNotThrow(() => Project.parse(structuredClone(noStudio)));
});

// ---- SPEC 12: import-sound + soundDefaults ----

function musicAuthor() {
  return approved(reviewed(author(videosLocked(), soundPlan, 'sound-designer')));
}

test('P17 SPEC12: import-sound records music audio and the packet carries it', T, async () => {
  let p = musicAuthor();
  assert.equal(p.step, 'music');
  assert.equal(p.gate, 'author');
  p = send(p, 'import-sound', { actor: 'human', importFile: audio(80, 60), message: 'ISOLATED licensed score import' });
  assert.deepEqual(p.soundImports.music.file, audio(80, 60));
  const task = taskFor(p);
  assert.deepEqual(task.importFile.file, audio(80, 60));
  assert.equal(task.importFile.message, 'ISOLATED licensed score import');
  assert.ok(task.importFile.at);
  await prepareCrewTask(p, task);
  const q = send(p, 'artifact', { workerId: 'sound-designer', content: { files: [audio(80, 60)], prompt: soundPlan.music.prompt, provenance: soundPlan.music.provenance } });
  assert.equal(q.gate, 'review');
});

test('P17 SPEC12: music author with the wrong file is rejected when an import exists', T, () => {
  let p = send(musicAuthor(), 'import-sound', { actor: 'human', importFile: audio(81, 60), message: 'ISOLATED score' });
  assert.throws(() => send(p, 'artifact', { workerId: 'sound-designer', content: { files: [audio(82, 60)], prompt: soundPlan.music.prompt, provenance: soundPlan.music.provenance } }), /SOUND_IMPORT_FILE_MISMATCH/);
});

test('P17 SPEC12: import-sound on an effect id flows to that effect author', T, async () => {
  let p = musicAuthor();
  p = approved(reviewed(send(p, 'artifact', { workerId: 'sound-designer', content: { files: [audio(80, 60)], prompt: soundPlan.music.prompt, provenance: soundPlan.music.provenance } })));
  assert.equal(p.step, 'effect');
  p = send(p, 'import-sound', { actor: 'human', effectId: 'bell', importFile: audio(83, 1), message: 'ISOLATED bell import' });
  const task = taskFor(p);
  assert.deepEqual(task.importFile.file, audio(83, 1));
  await prepareCrewTask(p, task);
  const q = send(p, 'artifact', { workerId: 'sound-designer', content: { files: [audio(83, 1)], prompt: soundPlan.effects[0].prompt, provenance: soundPlan.effects[0].provenance } });
  assert.equal(q.gate, 'review');
  assert.throws(() => send(p, 'artifact', { workerId: 'sound-designer', content: { files: [audio(84, 1)], prompt: soundPlan.effects[0].prompt, provenance: soundPlan.effects[0].provenance } }), /SOUND_IMPORT_FILE_MISMATCH/);
});

test('P17 SPEC12: import-sound rejects stills, generate mode, wrong step and missing notes', T, () => {
  const still = { path: '/isolated-test/still.png', sha256: 'a'.repeat(64), bytes: 100, width: 1600, height: 900 };
  assert.throws(() => send(musicAuthor(), 'import-sound', { actor: 'human', importFile: still, message: 'ISOLATED still' }), /audio-only/);
  const generated = structuredClone(soundPlan);
  generated.music.mode = 'generate'; generated.music.provenance.source = 'generated';
  const g = approved(reviewed(author(videosLocked(), generated, 'sound-designer')));
  assert.throws(() => send(g, 'import-sound', { actor: 'human', importFile: audio(85, 60), message: 'ISOLATED wrong mode' }), /SOUND_IMPORT_MODE/);
  const elsewhere = videosLocked();
  assert.throws(() => send(elsewhere, 'import-sound', { actor: 'human', importFile: audio(85, 60), message: 'ISOLATED wrong step' }), /SOUND_IMPORT_STEP/);
  assert.throws(() => send(musicAuthor(), 'import-sound', { actor: 'human', importFile: audio(85, 60) }), /--file and --message/);
  let p = musicAuthor();
  p = approved(reviewed(send(p, 'artifact', { workerId: 'sound-designer', content: { files: [audio(80, 60)], prompt: soundPlan.music.prompt, provenance: soundPlan.music.provenance } })));
  assert.throws(() => send(p, 'import-sound', { actor: 'human', effectId: 'nope', importFile: audio(86, 1), message: 'ISOLATED unknown' }), /SOUND_IMPORT/);
});

test('P17 SPEC12: soundPlan packet carries pinned music/effect defaults, no behaviour change', T, async () => {
  const p = videosLocked();
  assert.equal(p.step, 'soundPlan');
  const task = taskFor(p);
  assert.deepEqual(task.soundDefaults, { musicEnabledByDefault: false, effectsEnabledByDefault: false });
  await prepareCrewTask(p, task);
});

// ---- SPEC 14: glitch-removal rename with deprecated alias ----

const editRanges = [{ startSeconds: 0, endSeconds: 7 }, { startSeconds: 9.2, endSeconds: 17.2 }];

test('P17 SPEC14: glitch-removal validates; pronunciation-repair normalises to it', T, () => {
  const source = file(101, 20);
  const fresh = validateAudioEdit(source, { kind: 'glitch-removal', keepRanges: editRanges, reason: 'ISOLATED cut a doubled syllable.' });
  assert.equal(fresh.plan.kind, 'glitch-removal');
  const legacy = validateAudioEdit(source, { kind: 'pronunciation-repair', keepRanges: editRanges, reason: 'ISOLATED old skill wording.' });
  assert.equal(legacy.plan.kind, 'glitch-removal');
  assert.throws(() => AudioEditPlan.parse({ kind: 'word-repair', keepRanges: editRanges, reason: 'ISOLATED bad kind.' }));
});

test('P17 SPEC14: old stored receipts with the deprecated kind still parse', T, () => {
  const source = file(101, 20), edited = file(102, 15);
  const receipt = AudioEditReceipt.parse({ beat: 2, parentArtifactId: 'narration@1', parentArtifactDigest: 'd'.repeat(64), sourceFile: source, editedFile: edited, outputFile: edited, tailSilenceSeconds: 0, plan: { kind: 'pronunciation-repair', keepRanges: [{ startSeconds: 0, endSeconds: 15 }], reason: 'ISOLATED stored receipt.' }, editDigest: 'e'.repeat(64), receiptPath: '/isolated-test/audio-edit' });
  assert.equal(receipt.plan.kind, 'glitch-removal');
});
