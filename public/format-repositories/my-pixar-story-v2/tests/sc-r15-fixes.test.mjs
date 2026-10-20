// r4-dry15 SC review: (1) camera direction was dropped by the input slice, (2) sunglasses leaked into [SHOTS] (since change 5:
// they are locked word for word in every shot instead),
// (3) voiceover-only @DadShaz was attached as an image in Part 1, (4) broken [GOAL] hard stop, "not photorealistic"
// in the [VISUAL STYLE] template, and "breathing" filler in every shot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSeedancePrompts, assembleCompiledPrompt } from '../crew/seedance-compiler/schema.mjs';
import { selectSeedanceCompilerInput, segmentCastPresence } from '../crew/seedance-compiler/input.mjs';
import { validateSeedancePrompts } from '../crew/linter/check-seedance-prompts.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const role = readFileSync(new URL('../crew/seedance-compiler/role.md', import.meta.url), 'utf8');
const state = () => ({ storyDirector: json('good-stage-play.json'), characterArchitect: { output: json('good-master-renders.json') },
  locationScout: { output: json('good-location-plates.json') }, approvedAssets: json('good-approved-assets.json') });
const out = () => json('good-seedance-prompts.json');
const shots = (d, i, fn) => { const s = d.segments[i]; s.tenBlocks.block5_shots = fn(s.tenBlocks.block5_shots); s.compiledPrompt = assembleCompiledPrompt(s.tenBlocks); return d; };
const block = (d, i, k, fn) => { const s = d.segments[i]; s.tenBlocks[k] = fn(s.tenBlocks[k]); s.compiledPrompt = assembleCompiledPrompt(s.tenBlocks); return d; };
const issues = (d, st = state()) => validateSeedancePrompts(d, selectSeedanceCompilerInput(st)).issues;
const errs = (d, st) => issues(d, st).filter((i) => i.severity === 'error').map((i) => i.code);

test('fixture passes the new checks', () => {
  const r = validateSeedancePrompts(parseSeedancePrompts(out()), selectSeedanceCompilerInput(state()));
  assert.equal(r.isValid, true, r.errors.join('\n'));
});

// 1 camera direction
test('input slice passes framing, cameraAngle and cameraMove through', () => {
  const sh = selectSeedanceCompilerInput(state()).segments[0].shots[1];
  assert.deepEqual([sh.framing, sh.cameraAngle, sh.cameraMove], ['medium', 'eye level', 'slow push in']);
});
test('MISSING_CAMERA_DIRECTION when a SHOT has no "Camera:" line; mismatch is a warning', () => {
  assert.ok(errs(shots(out(), 0, (t) => t.replace('Camera: medium, eye level, slow push in.\n', ''))).includes('MISSING_CAMERA_DIRECTION'));
  assert.ok(errs(shots(out(), 0, (t) => t.replace('Camera: medium, eye level, slow push in.', 'Camera: medium shot.'))).includes('MISSING_CAMERA_DIRECTION'));
  const w = issues(shots(out(), 0, (t) => t.replace('Camera: medium, eye level, slow push in.', 'Camera: wide, high angle, static.')));
  assert.ok(w.some((i) => i.code === 'CAMERA_DIRECTION_MISMATCH' && i.severity === 'warning'));
});
test('role.md requires the camera line from the stage play', () => {
  assert.match(role, /`Camera: <framing>, <angle>, <move>\.`/);
  assert.match(role, /MISSING_CAMERA_DIRECTION/);
  assert.match(role, /Keep every shot's framing, angle and camera move/);
});

// 2 sunglasses: since change 5 (shot locks) the accessory is REQUIRED in every shot, as the exact cast-card wording
test('signature accessory: the exact locked wording is required per on-screen shot; missing or reworded fails', () => {
  const lock = 'Look @Shaz: red plastic sunglasses pushed up on his forehead; crisp bright red cotton t-shirt.';
  assert.ok(out().segments[0].tenBlocks.block5_shots.includes(lock));
  assert.ok(errs(shots(out(), 0, (t) => t.replace(`${lock}\n`, ''))).includes('ACCESSORY_MISSING'));
  assert.ok(errs(shots(out(), 0, (t) => t.replace(lock, 'Look @Shaz: red sunglasses up on his head; crisp bright red cotton t-shirt.'))).includes('ACCESSORY_REWORDED'));
  // a shot action may mention it; the old "never in [SHOTS]" ban is gone
  const d = out(); d.segments[0].shots[1].action = '@Shaz, red plastic sunglasses pushed up on his forehead, lowers his chin.';
  assert.ok(!errs(d).some((c) => /REDESCRIBED|ACCESSORY/.test(c)));
});
test('role.md: accessories are locked word for word in every shot (no longer banned from [SHOTS])', () => {
  assert.doesNotMatch(role, /the sunglasses as his signature/);
  assert.doesNotMatch(role, /never in `\[SHOTS\]`/);
  assert.match(role, /word for word/);
});

// 3 voice-only cast
const narratorOnly = () => {
  const st = state(), seg = st.storyDirector.segments[1];
  for (const sh of seg.shots) { sh.whatWeSee = sh.whatWeSee.replaceAll('@Shaz', 'the boy'); sh.onScreen = sh.onScreen.filter((t) => t !== '@Shaz'); }
  for (const sc of seg.scenes) { sc.present = sc.present.filter((t) => t !== '@Shaz'); sc.props = sc.props.map((x) => x.replaceAll("@Shaz's", "the boy's")); }
  return st;
};
/** The compiled part 2 with @Shaz heard only: no On screen / Look entries, no tag outside his voiceover label. */
const shazHeardOnly = (t) => t.split('\n').filter((l) => !l.startsWith('Look @Shaz:')).map((l) => (l.startsWith('On screen:')
  ? `On screen: ${l.replace('On screen:', '').replace(/[.\s]+$/, '').split(',').map((x) => x.trim()).filter((x) => x && x !== '@Shaz').join(', ') || 'no one'}.`
  : l.startsWith('@Shaz, voiceover:') ? l : l.replaceAll("@Shaz's", "the boy's").replaceAll('@Shaz', 'The boy'))).join('\n');
test('segmentCastPresence: narration-only speaker is voice only', () => {
  const st = narratorOnly(); const tags = st.storyDirector.cast.map((c) => c.elementTag);
  assert.deepEqual(segmentCastPresence(st.storyDirector.segments[1], tags).voiceOnlyCast, ['@Shaz']);
  assert.deepEqual(selectSeedanceCompilerInput(st).segments[1].voiceOnlyCast, ['@Shaz']);
  assert.deepEqual(selectSeedanceCompilerInput(state()).segments.map((s) => s.voiceOnlyCast), [[], []]);
});
test('VOICE_ONLY_REFERENCE when a voice-only speaker is attached; passes once removed (voiceover line needs no binding)', () => {
  assert.ok(errs(out(), narratorOnly()).includes('VOICE_ONLY_REFERENCE'));
  const d = out(); const s = d.segments[1];
  s.references = s.references.filter((r) => r.tag !== '@Shaz'); s.attachedElements = s.attachedElements.filter((t) => t !== '@Shaz');
  for (const sh of s.shots) sh.cast = sh.cast.filter((c) => c !== '@Shaz');
  block(d, 1, 'block1_referenceMaterials', (t) => t.split('\n').filter((l) => !l.startsWith('@Shaz =')).join('\n'));
  shots(d, 1, shazHeardOnly);
  const c = errs(d, narratorOnly());
  assert.deepEqual(c.filter((k) => !k.startsWith('WRITING')), [], 'nothing else fails either');
  for (const k of ['VOICE_ONLY_REFERENCE', 'UNREGISTERED_ELEMENT_TAG', 'MISSING_CAST_REFERENCE']) assert.ok(!c.includes(k), c.join(','));
});
test('role.md: voice-only cast gets no image', () => assert.match(role, /Voice-only cast gets no image/));

// 4 goal grammar, visual style, breathing
test('BROKEN_HARD_STOP for "It ends the instant X ... and do not continue"', () => {
  assert.ok(errs(block(out(), 0, 'block3_goal', (t) => t.replace("It ends the instant @Mom's line finishes — do not continue,", "It ends the instant @Mom's line finishes and do not continue,"))).includes('BROKEN_HARD_STOP'));
  assert.ok(!errs(block(out(), 0, 'block3_goal', (t) => t.replace("It ends the instant @Mom's line finishes — do not continue,", "It ends the instant @Mom's line finishes. Do not continue,"))).includes('BROKEN_HARD_STOP'));
});
test('role.md templates: two-sentence hard stop; [VISUAL STYLE] names no forbidden word outside the FORBIDDEN list', () => {
  assert.match(role, /It ends the instant X finishes\. Do not continue past that moment, do not resolve anything and do not add an ending\./);
  assert.doesNotMatch(role, /ends the instant X finishes —/);
  const vs = role.slice(role.indexOf('### Block 6'), role.indexOf('### Block 7')).split('\n').filter((l) => !l.includes('FORBIDDEN'));
  for (const w of ['photorealistic', 'kodak', 'film grain', '35mm', 'live action']) assert.ok(!vs.some((l) => l.toLowerCase().includes(w)), w);
});
test('FILLER_BREATHING warning; role.md bans breathing filler', () => {
  const w = issues(shots(out(), 0, (t) => t.replace('one slow blink.', 'one slow blink, breathing.')));
  assert.ok(w.some((i) => i.code === 'FILLER_BREATHING' && i.severity === 'warning'));
  assert.match(role, /Never use "breathing"/);
});
