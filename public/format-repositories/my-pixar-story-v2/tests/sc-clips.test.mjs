// WIGGLY: engine clip caps (Omni 1.1 Flash 10s, 4/6/8/10) and the no-lip-sync narration lock. Fixtures only, no model calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assembleCompiledPrompt, engineDurationFor, parseSeedancePrompts, VIDEO_ENGINES } from '../crew/seedance-compiler/schema.mjs';
import { selectSeedanceCompilerInput } from '../crew/seedance-compiler/input.mjs';
import { validateSeedancePrompts, shotBlocks } from '../crew/linter/check-seedance-prompts.mjs';
import { V2_MODELS } from '../config/models.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const state = (videoEngine) => ({ ...(videoEngine ? { videoEngine } : {}), storyDirector: json('good-stage-play.json'), characterArchitect: { output: json('good-master-renders.json') },
  locationScout: { output: json('good-location-plates.json') }, approvedAssets: json('good-approved-assets.json') });
const role = readFileSync(new URL('../crew/seedance-compiler/role.md', import.meta.url), 'utf8');
const errs = (d, eng = 'omni-1.1-flash') => validateSeedancePrompts(d, selectSeedanceCompilerInput(state(eng))).issues.filter((i) => i.severity === 'error');
const codes = (d, eng) => errs(d, eng).map((i) => i.code);

/** Split the good fixture into Omni clips the way the SC should: groups = per part, lists of staged shot indexes. */
function clips(groups = { 1: [[0, 1], [2], [3, 4], [5]], 2: [[0, 1], [2]] }, engine = 'omni-1.1-flash') {
  const d = json('good-seedance-prompts.json'), out = [];
  for (const seg of d.segments) for (const [j, g] of groups[seg.segmentId].entries()) {
    const shots = g.map((k) => seg.shots[k]), off = shots[0].startSec, blocks = shotBlocks(seg.tenBlocks.block5_shots);
    const len = shots.at(-1).endSec - off;
    const cs = shots.map((s, n) => ({ ...s, shotNumber: n + 1, startSec: s.startSec - off, endSec: s.endSec - off }));
    const text = g.map((k, n) => blocks[k].text.replace(/SHOT\s+\d+\s*\|\s*\d+[–-]\d+s/, `SHOT ${n + 1} | ${cs[n].startSec}–${cs[n].endSec}s`)).join('').trimEnd();
    const keep = new Set([...cs.flatMap((s) => s.cast), ...cs.filter((s) => s.dialogue?.mode === 'on-camera').map((s) => s.dialogue.speaker), ...cs.map((s) => s.locationTag)]);
    const refs = seg.references.filter((r) => keep.has(r.tag));
    const tb = { ...seg.tenBlocks, block5_shots: text,
      block1_referenceMaterials: seg.tenBlocks.block1_referenceMaterials.split('\n').filter((l) => { const m = l.match(/^(@[\w_]+)\s*=/); return !m || keep.has(m[1]); }).join('\n') };
    out.push({ ...seg, ...(groups[seg.segmentId].length > 1 ? { clipId: `${seg.segmentId}${'abcd'[j]}`, sourceShotNumbers: g.map((k) => seg.shots[k].shotNumber) } : {}), sourceStartSec: off,
      totalDurationSec: len, shotCount: cs.length, shots: cs, references: refs, attachedElements: refs.map((r) => r.tag), tenBlocks: tb, compiledPrompt: assembleCompiledPrompt(tb),
      generationPayload: { ...seg.generationPayload, engine, durationSec: engineDurationFor(engine, len) } });
  }
  out.forEach((s, i) => { s.segmentIndex = i + 1; s.extendsFrom = i ? i : null; });
  return { ...d, segments: out, totalRuntimeSec: out.reduce((n, s) => n + s.totalDurationSec, 0) };
}

test('engines: Omni 1.1 Flash caps clips at 10s with 4/6/8/10; Seedance stays default at 30s', () => {
  assert.equal(VIDEO_ENGINES['omni-1.1-flash'].segmentMaxSec, 10);
  assert.deepEqual([3, 4, 5, 7, 9, 10, 11].map((n) => engineDurationFor('omni-1.1-flash', n)), [4, 4, 6, 8, 10, 10, undefined]);
  assert.equal(engineDurationFor('seedance-2.5', 27), 27);
  assert.deepEqual(V2_MODELS['seedance-compiler'].videoEngines, ['seedance-2.5', 'omni-1.1-flash']);
  const def = selectSeedanceCompilerInput(state()), om = selectSeedanceCompilerInput(state('omni-1.1-flash'));
  assert.deepEqual([def.targetEngine, def.segmentMaxSec, def.allowedDurationsSec], ['seedance-2.5', 30, null]);
  assert.deepEqual([om.targetEngine, om.segmentMaxSec, om.allowedDurationsSec], ['omni-1.1-flash', 10, [4, 6, 8, 10]]);
});
test('split at shot boundaries: a correct clip split parses and passes the gate', () => {
  const d = clips(); parseSeedancePrompts(d);
  assert.deepEqual(codes(d), []);
  assert.deepEqual(d.segments.map((s) => [s.clipId, s.totalDurationSec, s.generationPayload.durationSec]), [['1a', 9, 10], ['1b', 5, 6], ['1c', 10, 10], ['1d', 6, 6], ['2a', 10, 10], ['2b', 6, 6]]);
});
test('the unsplit 30s part fails on Omni (over the clip cap), still passes on Seedance', () => {
  const d = json('good-seedance-prompts.json');
  assert.ok(codes(d, 'seedance-2.5').length === 0);
  for (const s of d.segments) s.generationPayload.engine = 'omni-1.1-flash';
  assert.throws(() => parseSeedancePrompts(d), /longer than omni-1\.1-flash renders/);
  assert.ok(codes(d).includes('CLIP_OVER_ENGINE_CAP'));
});
test('durationSec must be the smallest allowed Omni length >= the clip', () => {
  const d = clips(); d.segments[0].generationPayload.durationSec = 9;
  assert.throws(() => parseSeedancePrompts(d), /must be 10/);
});
test('clips must cover every staged shot once, in order, with offsets and source shots recorded', () => {
  let d = clips(); d.segments.splice(1, 1); d.segments.forEach((s, i) => { s.segmentIndex = i + 1; s.extendsFrom = i ? i : null; });
  assert.ok(codes(d).includes('CLIP_SPLIT_NOT_AT_SHOTS'));
  d = clips(); d.segments[1].sourceStartSec = 0; assert.ok(codes(d).includes('CLIP_SOURCE_OFFSET'));
  d = clips(); d.segments[1].sourceShotNumbers = [4]; assert.ok(codes(d).includes('CLIP_SOURCE_SHOTS'));
  d = clips(); d.segments[1].clipId = '1c'; assert.ok(codes(d).includes('CLIP_ID'));
});
test('timing as staged is checked against the source part, offset per clip', () => {
  const d = clips(); d.segments[2].shots[0].startSec = 14; // staged time instead of the clip's 0
  assert.ok(codes(d).includes('SHOT_TIMING_NOT_AS_STAGED'));
  assert.ok(errs(clips()).every((i) => i.code !== 'SHOT_TIMING_NOT_AS_STAGED'));
});
test('per-clip references: a picture of someone not in the clip is an error on Omni', () => {
  const d = clips(); const s = d.segments[1]; // 1b: only @Sister on screen
  s.references.push({ tag: '@Mom', kind: 'character', sourceTag: d.segments[3].references.find((r) => r.tag === '@Mom').sourceTag, assetKey: d.segments[3].references.find((r) => r.tag === '@Mom').assetKey });
  s.attachedElements.push('@Mom');
  assert.ok(codes(d).includes('REFERENCE_NOT_IN_CLIP'));
});
test('a staged shot longer than the cap is a reported blocker, never cut', () => {
  const st = state('omni-1.1-flash'); const sh = st.storyDirector.segments[0].shots;
  const inp = selectSeedanceCompilerInput(st); inp.segments[0].shots[0].endSec = 11; // 11s shot
  const issues = validateSeedancePrompts(clips(), inp).issues;
  assert.ok(issues.some((i) => i.code === 'SHOT_LONGER_THAN_CLIP_CAP' && /BLOCKER/.test(i.message)), sh.length);
});
test('narration: voiceover shots say no one on screen speaks; [VOICES] says off-screen narrator; no mumbling excluded', () => {
  const strip = (fn) => { const d = clips(); fn(d.segments[4].tenBlocks); d.segments[4].compiledPrompt = assembleCompiledPrompt(d.segments[4].tenBlocks); return codes(d); };
  assert.ok(strip((tb) => { tb.block5_shots = tb.block5_shots.replaceAll('No one on screen speaks; every on-screen mouth stays closed.\n', ''); }).includes('VOICEOVER_MOUTHS_OPEN'));
  assert.ok(strip((tb) => { tb.block2_voices = tb.block2_voices.replaceAll('An off-screen narrator, never seen. ', ''); }).includes('NARRATOR_NOT_OFF_SCREEN'));
  assert.ok(strip((tb) => { tb.block9_exclusions = tb.block9_exclusions.replace(/ No humming[^.]*\./, ''); }).includes('MUMBLE_NOT_EXCLUDED'));
});
test('wardrobe: the Look line restates the signature garment', () => {
  const d = clips(); const tb = d.segments[0].tenBlocks; tb.block5_shots = tb.block5_shots.replaceAll('; crisp bright red cotton t-shirt.', '.'); d.segments[0].compiledPrompt = assembleCompiledPrompt(tb);
  assert.ok(codes(d).includes('GARMENT_MISSING'));
});
test('role.md: clip split, mouths closed, narrator silent action, no mumbling, garment, prop anchor; no subsurface glow', () => {
  for (const s of ['at shot boundaries, never mid-shot', 'No one on screen speaks; every on-screen mouth stays closed.', 'An off-screen narrator, never seen.',
    'No humming, mumbling, breaths-as-words or partial words from anyone on screen.', 'signature garment', 'anchor every prop', 'narrator\'s own character', 'never turned into voiceover', 'BLOCKER'])
    assert.ok(role.includes(s), s);
  assert.doesNotMatch(role, /subsurface glow/);
});
