import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStagePlay, StagePlayParseError } from '../crew/story-director/schema.mjs';
import { validateStoryDirectorOutput, lineBudget } from '../crew/linter/check-stage-play.mjs';
// The good fixture is a 46s film: its target is 60s (RUNTIME_UNDER_TARGET fires below 75% of the target).
const validate = (d, input = { targetTotalRuntimeSec: 60 }) => validateStoryDirectorOutput(d, input);

const good = () => JSON.parse(readFileSync(new URL('./fixtures/good-stage-play.json', import.meta.url), 'utf8'));
const run = (fn) => { const d = good(); fn(d); return validate(d); };
const hasCode = (r, code, sub) => {
  const hit = r.issues.find((i) => i.code === code && (!sub || i.message.includes(sub)));
  assert.ok(hit, `expected ${code}${sub ? ` "${sub}"` : ''} in:\n${r.issues.map((i) => i.code + ': ' + i.message).join('\n')}`);
  assert.equal(r.isValid, hit.severity !== 'error' ? r.isValid : false);
};

// ---- Gemini's 7 validator cases (Wiggly family fixture) ----
test('G1 valid Wiggly family output passes', () => {
  const r = validate(good());
  assert.equal(r.isValid, true, r.errors.join('\n')); assert.deepEqual(r.errors, []);
  assert.doesNotThrow(() => parseStagePlay(good()));
});
test('G2 adding a shot that pushes a segment past 30s -> ceiling error', () =>
  hasCode(run((d) => { const s = d.segments[0].shots; s.push({ ...s.at(-1), shotNumber: 7, startSec: 30, endSec: 35, dialogue: undefined }); }),
    'EXCEEDS_30S_CEILING', 'HARD CEILING IS 30 SECONDS'));
test('G3 endSec 2.5 -> fractional timecode', () =>
  hasCode(run((d) => { d.segments[0].shots[0].endSec = 2.5; }), 'FRACTIONAL_TIMECODE', 'fractional timecode'));
test('G4 startSec gap -> discontinuity', () =>
  hasCode(run((d) => { d.segments[0].shots[1].startSec = 6; }), 'TIMECODE_DISCONTINUITY', 'Timecodes must be strictly consecutive'));
test('G5 unbraced line -> curly braces', () =>
  hasCode(run((d) => { d.segments[0].shots[1].dialogue.line = 'I am a scientist.'; }), 'UNBRACKETED_DIALOGUE', 'curly braces {}'));
test("G6 whatWeSee 'OTS shot' -> Forbidden jargon 'OTS'", () =>
  hasCode(run((d) => { d.segments[0].shots[0].whatWeSee = 'OTS shot of Shaz looking at his sister'; }), 'BANNED_JARGON', "Forbidden jargon 'OTS'"));
test('G7 panel 1 without skin tone -> does not name skin tone', () =>
  hasCode(run((d) => { d.storyboardSheets[0].panels[0].whatIsInFrame = 'A boy in sunglasses at the table'; }), 'MISSING_SKIN_TONE_IN_PANEL', 'does not name skin tone'));

// ---- Gemini's remaining codes ----
test('NO_SEGMENTS, NO_CAST, INVALID_SHOT_DURATION, UNTAGGED_SPEAKER, PANEL_COUNT, WEAK_SIGNATURE_ACCENT', () => {
  hasCode(run((d) => { d.segments = []; }), 'NO_SEGMENTS');
  hasCode(run((d) => { d.cast = []; }), 'NO_CAST');
  hasCode(run((d) => { d.segments[0].shots[0].endSec = 0; }), 'INVALID_SHOT_DURATION');
  hasCode(run((d) => { d.segments[0].shots[1].dialogue.speaker = 'Shaz'; }), 'UNTAGGED_SPEAKER');
  hasCode(run((d) => { d.storyboardSheets[0].panels.pop(); }), 'STORYBOARD_SHOT_MISSING');
  const w = run((d) => { d.cast[0].signatureAccent = 'red'; });
  hasCode(w, 'WEAK_SIGNATURE_ACCENT'); assert.equal(w.isValid, true);
});

// ---- Wiggly codes ----
test('SPEAKER_NOT_IN_CAST (dialogue and narration)', () => {
  hasCode(run((d) => { d.segments[0].shots[1].dialogue.speaker = '@Dad'; }), 'SPEAKER_NOT_IN_CAST');
  hasCode(run((d) => { d.segments[1].shots[0].narration.speaker = '@Narrator'; }), 'SPEAKER_NOT_IN_CAST');
});
test('no hijab code check: female family without hijab wording is not blocked (rule lives in role.md only)', () => {
  const r = run((d) => { d.cast[1].physicalDescription = 'Kind round face, long modest dress, gentle eyes.'; });
  assert.ok(!r.issues.some((i) => /HIJAB/.test(i.code)));
  assert.doesNotThrow(() => parseStagePlay(JSON.stringify((() => { const d = JSON.parse(readFileSync(new URL('./fixtures/good-stage-play.json', import.meta.url), 'utf8')); d.cast[1].physicalDescription = 'Kind round face, long modest dress, gentle eyes.'; return d; })())));
});
test('UNDERAGE_DEPICTION for 13-17; 8 and 18 fine', () => {
  hasCode(run((d) => { d.cast[2].age = 16; }), 'UNDERAGE_DEPICTION');
  assert.equal(validate(good()).issues.filter((i) => i.code === 'UNDERAGE_DEPICTION').length, 0);
});
test('MULTILINE_STORYBOARD_PROMPT and WRONG_IMAGE_ENGINE', () => {
  hasCode(run((d) => { d.storyboardSheets[0].fullPrompt += '\nPanel 2 [shot 2]: ...'; }), 'MULTILINE_STORYBOARD_PROMPT');
  hasCode(run((d) => { d.storyboardSheets[0].targetEngine = 'gpt-image-2'; }), 'WRONG_IMAGE_ENGINE');
});
test('DIALOGUE_TIMING_BUDGET', () => {
  // 3 words/sec + 1s lead/tail pad, shared with the Seedance gate
  assert.equal(lineBudget(3), 2); assert.equal(lineBudget(6), 3); assert.equal(lineBudget(7), 4); assert.equal(lineBudget(18), 7); assert.equal(lineBudget(19), null);
  hasCode(run((d) => { const s = d.segments[0].shots; s[1].endSec = 7; s[2].startSec = 7;
    s[1].dialogue.line = '{I am a scientist and nobody here can stop me now}'; }), 'DIALOGUE_TIMING_BUDGET', '11 spoken words need 5s (11 words at 3 words/sec plus 1s lead-in and tail) but the shot is 2s. Fix: lengthen this shot to 5s');
  // dialogue and narration in one shot share the budget: 4 + 6 words = 10 -> 5s, the shot is 4s
  hasCode(run((d) => { d.segments[0].shots[1].narration = { speaker: '@Shaz', line: '{I said it every single day.}', source: { kind: 'connective' } }; }), 'DIALOGUE_TIMING_BUDGET', '10 spoken words need 5s');
  hasCode(run((d) => { d.segments[0].shots[1].dialogue.line = '{' + 'word '.repeat(19).trim() + '}'; }), 'DIALOGUE_TIMING_BUDGET', 'max 18');
});
test('BANNED_JARGON union includes Wiggly live-action tokens', () =>
  hasCode(run((d) => { d.segments[0].shots[0].whatWeSee += ' photorealistic'; }), 'BANNED_JARGON', "'photorealistic'"));
test('RUNTIME_EXCEEDS_CAP at 180s', () => {
  const r = run((d) => { for (let i = 3; i <= 9; i++) d.segments.push({ ...structuredClone(d.segments[0]), segmentId: i }); });
  hasCode(r, 'RUNTIME_EXCEEDS_CAP', '180s');
});

// ---- Zod contract ----
test('schema: parse failures throw StagePlayParseError with paths', () => {
  assert.throws(() => parseStagePlay('{nope'), StagePlayParseError);
  const bad = (fn, re) => { const d = good(); fn(d); assert.throws(() => parseStagePlay(d), (e) => e instanceof StagePlayParseError && re.test(e.message)); };
  bad((d) => { delete d.cast[0].skinTone; }, /skinTone/);
  bad((d) => { d.cast[2].age = 15; }, /depicted as 18/);
  bad((d) => { d.segments[0].shots[1].dialogue.speaker = '@Dad'; }, /not a cast elementTag/);
  bad((d) => { d.segments[0].shots[0].startSec = 1; }, /start at 0/);
  bad((d) => { d.segments[0].targetDurationSec = 31; }, /targetDurationSec/);
});
test('schema: defaults (family true, clarifyingQuestion null, assumptions [])', () => {
  const d = good(); delete d.cast[0].family; delete d.clarifyingQuestion; delete d.assumptions;
  const p = parseStagePlay(d);
  assert.equal(p.cast[0].family, true); assert.equal(p.clarifyingQuestion, null); assert.deepEqual(p.assumptions, []);
  delete d.storyboardSheets[0].targetEngine; assert.equal(parseStagePlay(d).storyboardSheets[0].targetEngine, 'nano-banana-2.1');
});
test('speech rate is one rule across SD and SC: any shot length the SD gate accepts also passes the SC budget', async () => {
  const { WORDS_PER_SECOND } = await import('../crew/linter/check-seedance-prompts.mjs');
  const { maxWordsFor } = await import('../crew/linter/speech.mjs');
  for (let w = 1; w <= 18; w++) assert.ok(w <= maxWordsFor(lineBudget(w)) && w > maxWordsFor(lineBudget(w) - 1), `${w} words`);
  assert.equal(WORDS_PER_SECOND, 3);
});
