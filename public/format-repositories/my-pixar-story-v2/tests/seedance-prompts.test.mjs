import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSeedancePrompts, SeedancePromptParseError, BLOCK_KEYS } from '../crew/seedance-compiler/schema.mjs';
import { selectSeedanceCompilerInput, SeedanceCompilerInput } from '../crew/seedance-compiler/input.mjs';
import { validateSeedancePrompts as validate, validateSeedanceSegment as validateOne } from '../crew/linter/check-seedance-prompts.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const state = () => ({ storyDirector: json('good-stage-play.json'), characterArchitect: json('good-master-renders.json'),
  locationScout: json('good-location-plates.json'), approvedAssets: json('good-approved-assets.json'), photoNotes: [{ elementTag: '@Shaz', notes: '/Users/shaz/p.jpg' }] });
const input = (st = state()) => selectSeedanceCompilerInput(st);
const out = () => json('good-seedance-prompts.json');
const cls = () => json('good-seedance-classroom.json');
// edit compiledPrompt and keep tenBlocks in sync for the touched block (block key optional)
const T = (d, fn, i = 0, key) => { const s = d.segments[i]; s.compiledPrompt = fn(s.compiledPrompt); if (key) s.tenBlocks[key] = fn(s.tenBlocks[key]); return d; };
const hasCode = (r, code) => {
  assert.ok(r.issues.some((i) => i.code === code), `expected ${code} in:\n${r.issues.map((i) => i.code + ': ' + i.message).join('\n')}`);
  if (r.issues.find((i) => i.code === code).severity === 'error') assert.equal(r.isValid, false);
};
const gate = (d, inp = input()) => validate(d, inp);
const one = (d) => validateOne(d.segments[0]);

// ---- ours ----
test('good family fixture parses and passes the gate with no warnings', () => {
  const r = gate(parseSeedancePrompts(out())); assert.equal(r.isValid, true, r.errors.join('\n')); assert.deepEqual(r.warnings, []);
});
test('selector: element-name references, voice registry, video settings, inherits locations, drops photos/prompts', () => {
  const i = input();
  assert.deepEqual(i.references.map((r) => [r.tag, r.type, r.sourceTag]), [['@Shaz', 'character', '@Image 1'], ['@Mom', 'character', '@Image 2'], ['@Sister', 'character', '@Image 3'], ['@kitchen', 'location', '@Loc 1']]);
  assert.ok(i.references.every((r) => r.plainEnglishDescription.length >= 10));
  assert.deepEqual(i.voiceRegistry.map((v) => v.speakerTag), ['@Shaz', '@Mom', '@Sister']);
  assert.deepEqual(i.videoSettings, { resolution: '480p', frameRate: 24, aspectRatio: '16:9' });
  assert.ok(i.segments.every((s) => s.goalSummary && s.continuityLocks.length));
  assert.ok(i.segments[1].shots.every((s) => s.location === 'Kitchen'));
  const s = JSON.stringify(i);
  for (const k of ['photoNotes', 'promptText', 'masterRenderPrompt', '/Users', 'http']) assert.ok(!s.includes(k), k);
});
test('input: 480p locked, fps 24|30, no URL audio refs, strict', () => {
  const st = state(); st.videoSettings = { resolution: '720p' }; assert.throws(() => input(st));
  const st2 = state(); st2.videoSettings = { frameRate: 30 }; assert.equal(input(st2).videoSettings.frameRate, 30);
  const st3 = state(); st3.voiceAudioRefs = { '@Shaz': 'https://x.example/v.mp4' }; assert.throws(() => input(st3));
  const st4 = state(); st4.voiceAudioRefs = { '@Shaz': 'asset:voice:shaz-v1' }; assert.equal(input(st4).voiceRegistry[0].audioReference, 'asset:voice:shaz-v1');
  assert.throws(() => SeedanceCompilerInput.parse({ ...input(), photos: [] }));
});
test('selector throws without approved assets; rejects URL asset keys', () => {
  const st = state(); st.approvedAssets = {}; assert.throws(() => input(st), /no approved reference asset/);
  const st2 = state(); delete st2.approvedAssets['@Loc 1']; assert.throws(() => input(st2), /no approved plate asset/);
  const st3 = state(); st3.approvedAssets['@Image 1'] = 'https://x.example/a.png'; assert.throws(() => input(st3));
});
test('schema rejects: >30s, gap, wrong engine/res, extend chain, URL asset, slot tag, speaker unbound, total mismatch, >180s, extra key', () => {
  const muts = [
    (d) => { d.segments[0].totalDurationSec = 31; },
    (d) => { d.segments[0].shots[1].startSec = 6; },
    (d) => { d.segments[0].generationPayload.engine = 'seedance-2.0'; },
    (d) => { d.segments[0].generationPayload.resolution = '1080p'; },
    (d) => { d.segments[1].extendsFrom = null; },
    (d) => { d.segments[0].references[0].assetKey = 'https://cdn.example/x.png'; },
    (d) => { d.segments[0].references[0].tag = '@Image 1'; },
    (d) => { d.segments[0].shots[1].dialogue.speaker = '@Dad'; },
    (d) => { d.segments[0].shotCount = 5; },
    (d) => { d.segments[0].attachedElements.pop(); },
    (d) => { d.totalRuntimeSec = 45; },
    (d) => { d.extra = 1; },
  ];
  for (const f of muts) { const d = out(); f(d); assert.throws(() => parseSeedancePrompts(d), SeedancePromptParseError); }
  const big = out(); big.totalRuntimeSec = 181; assert.throws(() => parseSeedancePrompts(big), SeedancePromptParseError);
  assert.throws(() => parseSeedancePrompts('{x'), /not valid JSON/);
});
test('UNKNOWN_REFERENCE_TAG: unapproved asset key or ref not bound with "@tag ="', () => {
  const d = out(); d.segments[0].references[0].assetKey = 'asset:master-render:shaz-v9'; hasCode(gate(d), 'UNKNOWN_REFERENCE_TAG');
  hasCode(gate(T(out(), (t) => t.replace('@Shaz = ', '@Shaz is '))), 'UNKNOWN_REFERENCE_TAG');
});
test('SLOT_TAG_IN_PROMPT: @Image N / @Loc N never in the prompt', () => hasCode(gate(T(out(), (t) => t.replace('In @kitchen:', 'In @Loc 1:'), 0, 'block5_shots')), 'SLOT_TAG_IN_PROMPT'));
test('MISSING_CAST_REFERENCE', () => {
  const d = out(); const s = d.segments[0]; s.references = s.references.filter((r) => r.tag !== '@Mom'); s.attachedElements = s.attachedElements.filter((t) => t !== '@Mom');
  s.shots.forEach((x) => { if (x.dialogue?.speaker === '@Mom') delete x.dialogue; });
  hasCode(gate(d), 'MISSING_CAST_REFERENCE');
});
test('MISSING_LOCATION_REFERENCE', () => {
  const d = out(); d.segments[0].shots[0].locationTag = '@garden'; hasCode(gate(d), 'MISSING_LOCATION_REFERENCE');
});
test('SPEAKER_NOT_IN_CAST', () => {
  const d = out(); const s = d.segments[0]; s.shots[1].dialogue.speaker = '@Dad';
  s.references.push({ tag: '@Dad', kind: 'character', assetKey: 'asset:master-render:dad-v1' }); s.attachedElements.push('@Dad');
  hasCode(gate(d), 'SPEAKER_NOT_IN_CAST');
});
test('DIALOGUE_TIMING_BUDGET', () => {
  const long = '{I am a scientist and I have been one since breakfast, obviously, ask anyone.}';
  const d = T(out(), (t) => t.replace('{I am a scientist.}', long), 0, 'block5_shots'); d.segments[0].shots[1].dialogue.line = long;
  hasCode(gate(d), 'DIALOGUE_TIMING_BUDGET');
});
test('DIALOGUE_NOT_VERBATIM', () => hasCode(gate(T(out(), (t) => t.replace('{You are eight.}', '{You are like eight.}'), 0, 'block5_shots')), 'DIALOGUE_NOT_VERBATIM'));
test('WRONG_RESOLUTION / WRONG_ENGINE in prompt text', () => {
  hasCode(gate(T(out(), (t) => t + ' Render in 1080p.')), 'WRONG_RESOLUTION');
  hasCode(gate(T(out(), (t) => t + ' Send to Higgsfield / Volcano Engine.')), 'WRONG_ENGINE');
});
test('URL_IN_PROMPT', () => { for (const x of ['https://cdn.example.com/shaz.png', '/Users/shaz/Photos/mom.jpg', 'kitchen_plate.png']) hasCode(gate(T(out(), (t) => `${t}\n${x}`)), 'URL_IN_PROMPT'); });
test('MISSING_HIJAB', () => hasCode(gate(T(out(), (t) => t.replaceAll('with no visible hair, hairline or dark band', 'neatly'))), 'MISSING_HIJAB'));
test('UNDERAGE_DEPICTION', () => {
  hasCode(gate(T(out(), (t) => t.replace('@Sister is eighteen', '@Sister is a teenager'))), 'UNDERAGE_DEPICTION');
  const i = input(); i.cast[2].age = 16; hasCode(validate(out(), i), 'UNDERAGE_DEPICTION');
});
test('BANNED_LIVE_ACTION_JARGON incl. bare 35mm ("not photorealistic" ok)', () => {
  for (const w of ['35mm lens', 'film grain', 'Kodak look', 'live action', 'lens flare', '8K']) hasCode(gate(T(out(), (t) => `${t} ${w}.`)), 'BANNED_LIVE_ACTION_JARGON');
});
test('RUNTIME_CAP', () => {
  const d = out(); const seg = structuredClone(d.segments[0]);
  for (let k = 0; k < 6; k++) d.segments.push({ ...structuredClone(seg), segmentIndex: d.segments.length + 1, extendsFrom: d.segments.length });
  hasCode(gate(d), 'RUNTIME_CAP');
});
test('MISSING_EXTEND, MISSING_SEGMENT, SHOT_HEADER_MISMATCH', () => {
  const d = out(); d.segments[1].extendsFrom = null; hasCode(gate(d), 'MISSING_EXTEND');
  const e = out(); e.segments.pop(); hasCode(gate(e), 'MISSING_SEGMENT');
  const f = out(); f.segments[0].shots[0].endSec = 4; f.segments[0].shots[1].startSec = 4; hasCode(gate(f), 'SHOT_HEADER_MISMATCH');
});
test('warnings: hard narrative stop, animation physics, continuous pan', () => {
  const d = T(out(), (t) => t.replace(/It ends the instant[^.]*\./, ''), 0, 'block3_goal');
  T(d, (t) => t.replace('Anticipation: every move winds the opposite way first. ', ''), 0, 'block7_cameraAndPerformance');
  T(d, (t) => t.replace('Medium on Shaz lowering', 'Slow pan to Shaz lowering'), 0, 'block5_shots');
  const r = gate(d);
  for (const c of ['MISSING_HARD_NARRATIVE_STOP', 'MISSING_ANIMATION_PHYSICS', 'UNMARKED_CONTINUOUS_PAN']) assert.ok(r.issues.some((i) => i.code === c && i.severity === 'warning'), c);
  assert.ok(!gate(T(out(), (t) => t.replace('fridge on', 'pantry and fridge on'))).issues.some((i) => i.code === 'UNMARKED_CONTINUOUS_PAN'));
});

// ---- Gemini's 13 cases (classroom 10-block scene; 480p; tags bound to placeholder asset keys) ----
test('G1 valid classroom segment passes the gate', () => { const r = one(cls()); assert.equal(r.isValid, true, r.errors.join('\n')); assert.deepEqual(r.warnings, []); });
test('G2 valid classroom segment parses the schema', () => assert.equal(parseSeedancePrompts(cls()).segments[0].generationPayload.resolution, '480p'));
test('G3 shot 5 11–35s -> RUNTIME_CEILING_EXCEEDED', () => hasCode(one(T(cls(), (t) => t.replace('SHOT 5 | 11–27s', 'SHOT 5 | 11–35s'), 0, 'block5_shots')), 'RUNTIME_CEILING_EXCEEDED'));
test('G4 shot 1 0–2.5s -> DECIMAL_TIMECODE_DETECTED', () => hasCode(one(T(cls(), (t) => t.replace('SHOT 1 | 0–3s', 'SHOT 1 | 0–2.5s'), 0, 'block5_shots')), 'DECIMAL_TIMECODE_DETECTED'));
test('G5 shot 2 4–6s -> TIMECODE_DISCONTINUITY', () => hasCode(one(T(cls(), (t) => t.replace('SHOT 2 | 3–5s', 'SHOT 2 | 4–6s'), 0, 'block5_shots')), 'TIMECODE_DISCONTINUITY'));
test('G6 no "Hard cut." after shot 4 -> MISSING_HARD_CUT_TERMINATOR', () =>
  hasCode(one(T(cls(), (t) => t.replace("{Okay — so who's next?}\nHard cut.", "{Okay — so who's next?}"), 0, 'block5_shots')), 'MISSING_HARD_CUT_TERMINATOR'));
test('G7 Mia line without braces -> UNBRACKETED_DIALOGUE', () =>
  hasCode(one(T(cls(), (t) => t.replace('@Mia: {Me! Me Miss Park! I want to go next!}', '@Mia: Me! Me Miss Park! I want to go next!'), 0, 'block5_shots')), 'UNBRACKETED_DIALOGUE'));
test('G8 exclusions without the ironclad sentence -> MISSING_DIALOGUE_EXCLUSION', () =>
  hasCode(one(T(cls(), (t) => t.replace('The only spoken words in the entire segment are the lines in braces.', 'Keep it clean.'), 0, 'block9_exclusions')), 'MISSING_DIALOGUE_EXCLUSION'));
test('G9 audio += dialogue -> DIALOGUE_IN_AUDIO_BLOCK (gate + schema)', () => {
  const d = T(cls(), (t) => t.replace('subtle pizzicato strings.', 'subtle pizzicato strings. @Mia says {Pick me!}'), 0, 'block8_audio');
  hasCode(one(d), 'DIALOGUE_IN_AUDIO_BLOCK'); assert.throws(() => parseSeedancePrompts(d), /zero dialogue/);
});
test('G10 @ben_drawing -> @unregistered_prop -> UNREGISTERED_ELEMENT_TAG', () =>
  hasCode(one(T(cls(), (t) => t.replace('holding up @ben_drawing', 'holding up @unregistered_prop'), 0, 'block5_shots')), 'UNREGISTERED_ELEMENT_TAG'));
test('G11 schema: blocks 2/3 swapped -> sequential order refine (and OUT_OF_ORDER_BLOCK)', () => {
  const d = cls(); const s = d.segments[0];
  const v = `[VOICES]\n${s.tenBlocks.block2_voices}`, g = `[GOAL]\n${s.tenBlocks.block3_goal}`;
  s.compiledPrompt = s.compiledPrompt.replace(`${v}\n\n${g}`, `${g}\n\n${v}`);
  assert.throws(() => parseSeedancePrompts(d), /sequential order/); hasCode(one(d), 'OUT_OF_ORDER_BLOCK');
});
test('G12 "Mia: {..}" without @ -> MISSING_SPEAKER_HANDLE_AT', () =>
  hasCode(one(T(cls(), (t) => t.replace('@Mia: {Me!', 'Mia: {Me!'), 0, 'block5_shots')), 'MISSING_SPEAKER_HANDLE_AT'));
test('G13 schema: payload durationSec 30 vs total 27 -> duration mismatch', () => {
  const d = cls(); d.segments[0].generationPayload.durationSec = 30; assert.throws(() => parseSeedancePrompts(d), /must equal totalDurationSec/);
});
test('MISSING_SCHEMA_BLOCK and MISSING_REFERENCE_CLOSING_LAW', () => {
  hasCode(one(T(cls(), (t) => t.replace('[VISUAL STYLE]', '[STYLE]'))), 'MISSING_SCHEMA_BLOCK');
  hasCode(one(T(cls(), (t) => t.replace('Each reference is one person or one object and appears once.', ''))), 'MISSING_REFERENCE_CLOSING_LAW');
  assert.equal(BLOCK_KEYS.length, 10);
});
