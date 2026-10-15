import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCharacterSheets, CharacterSheetParseError } from '../crew/character-architect/schema.mjs';
import { selectCharacterArchitectInput, CharacterArchitectInput } from '../crew/character-architect/input.mjs';
import { validateCharacterSheets as validate } from '../crew/linter/check-character-sheets.mjs';

const load = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const story = () => load('good-stage-play.json');
const good = () => load('good-character-sheets.json');
const P = (d, tag) => d.characters.find((c) => c.elementTag === tag);
const run = (fn, s = story()) => { const d = good(); fn(d, s); return validate(d, s); };
const hasCode = (r, code) => {
  assert.ok(r.issues.some((i) => i.code === code), `expected ${code} in:\n${r.issues.map((i) => i.code + ': ' + i.message).join('\n')}`);
  assert.equal(r.isValid, false);
};

test('good sheets parse and pass the gate against the Story Director fixture', () => {
  assert.doesNotThrow(() => parseCharacterSheets(good()));
  const r = validate(good(), story());
  assert.equal(r.isValid, true, r.errors.join('\n')); assert.deepEqual(r.warnings, []);
});

// ---- one bad case per gate code ----
test('TAG_PARITY: missing sheet and extra sheet', () => {
  hasCode(run((d) => { d.characters.pop(); }), 'TAG_PARITY');
  hasCode(run((d) => { d.characters.push({ ...d.characters[0], elementTag: '@Dad', imageTag: '@Image 4' }); }), 'TAG_PARITY');
});
test('MULTILINE_PROMPT', () => hasCode(run((d) => { P(d, '@Shaz').sheetPrompt = P(d, '@Shaz').sheetPrompt.replace('. ', '.\n'); }), 'MULTILINE_PROMPT'));
test('PROMPT_LENGTH short and long', () => {
  hasCode(run((d) => { P(d, '@Shaz').sheetPrompt = P(d, '@Shaz').sheetPrompt.slice(0, 3000); }), 'PROMPT_LENGTH');
  hasCode(run((d) => { P(d, '@Shaz').sheetPrompt += ' Extra warm detail.'.repeat(80); }), 'PROMPT_LENGTH');
});
test('MISSING_SKIN_TONE', () => hasCode(run((d) => { P(d, '@Sister').sheetPrompt = P(d, '@Sister').sheetPrompt.replaceAll('light warm brown', 'natural'); }), 'MISSING_SKIN_TONE'));
test('MISSING_HIJAB and HAIR_VISIBLE', () => {
  hasCode(run((d) => { P(d, '@Mom').sheetPrompt = P(d, '@Mom').sheetPrompt.replace(', with no visible hair, hairline or dark band at the forehead', ''); }), 'MISSING_HIJAB');
  hasCode(run((d) => { P(d, '@Mom').sheetPrompt = P(d, '@Mom').sheetPrompt.replace('Her main outfit', 'Soft bangs peek out at the front. Her main outfit'); }), 'HAIR_VISIBLE');
  const r = run((d, s) => { s.cast[2].family = false; P(d, '@Sister').family = false; P(d, '@Sister').sheetPrompt = P(d, '@Sister').sheetPrompt.replace(/She wears a soft grey hijab[^;]*;/, 'Her short black hair is tied back;'); });
  assert.ok(!r.issues.some((i) => i.code === 'MISSING_HIJAB'));
});
test('UNDERAGE_DEPICTION by age and by wording', () => {
  hasCode(run((d) => { P(d, '@Sister').age = 16; }), 'UNDERAGE_DEPICTION');
  hasCode(run((d) => { P(d, '@Sister').sheetPrompt = P(d, '@Sister').sheetPrompt.replace('an eighteen-year-old young woman', 'a teenage girl'); }), 'UNDERAGE_DEPICTION');
  const r = validate(good(), story()); // Shaz at 8 is a child, not a teen
  assert.ok(!r.issues.some((i) => i.code === 'UNDERAGE_DEPICTION'));
});
test('EXPRESSION_COUNT_NOT_STATED', () => {
  hasCode(run((d) => { P(d, '@Shaz').sheetPrompt = P(d, '@Shaz').sheetPrompt.replace('exactly eight expression portraits', 'several expression portraits'); }), 'EXPRESSION_COUNT_NOT_STATED');
  hasCode(run((d) => { P(d, '@Shaz').expressionCount = 6; }), 'EXPRESSION_COUNT_NOT_STATED');
});
test('WRONG_IMAGE_ENGINE', () => {
  hasCode(run((d) => { P(d, '@Shaz').targetEngine = 'gpt-image-2'; }), 'WRONG_IMAGE_ENGINE');
  hasCode(run((d) => { P(d, '@Shaz').sheetPrompt = P(d, '@Shaz').sheetPrompt.replace('Create ONE', 'For GPT Image 2, create ONE'); }), 'WRONG_IMAGE_ENGINE');
});
test('BANNED_JARGON (shared list + "minor")', () => {
  hasCode(run((d) => { P(d, '@Shaz').sheetPrompt = P(d, '@Shaz').sheetPrompt.replace('Render the house look', 'Photorealistic render'); }), 'BANNED_JARGON');
  hasCode(run((d) => { P(d, '@Shaz').sheetPrompt = P(d, '@Shaz').sheetPrompt.replace('an eight-year-old boy', 'a minor, eight years old'); }), 'BANNED_JARGON');
});
test('SKIN_TONE_DRIFT is a warning only', () => {
  const r = run((d) => { P(d, '@Shaz').skinTone = 'medium brown'; });
  assert.ok(r.issues.some((i) => i.code === 'SKIN_TONE_DRIFT' && i.severity === 'warning'));
});

// ---- Zod contract ----
test('schema: violations throw CharacterSheetParseError with paths', () => {
  assert.throws(() => parseCharacterSheets('{x'), CharacterSheetParseError);
  const bad = (fn, re) => { const d = good(); fn(d); assert.throws(() => parseCharacterSheets(d), (e) => e instanceof CharacterSheetParseError && re.test(e.message)); };
  bad((d) => { d.characters[0].sheetPrompt = 'too short'; }, /at least 3500/);
  bad((d) => { d.characters[0].sheetPrompt = d.characters[0].sheetPrompt.replace('. ', '.\n'); }, /single line/);
  bad((d) => { d.characters[0].targetEngine = 'gpt-image-2'; }, /targetEngine/);
  bad((d) => { d.characters[0].expressionCount = 7; }, /expressionCount/);
  bad((d) => { d.characters[1].imageTag = '@Image 5'; }, /@Image 2/);
  bad((d) => { d.characters[0].age = 15; }, /depicted as 18/);
  bad((d) => { d.characters[0].outfits[0].isMain = false; }, /isMain/);
  bad((d) => { d.characters[0].elementTag = 'Shaz'; }, /elementTag/);
  bad((d) => { d.extra = 1; }, /extra/);
});

// ---- input slice ----
test('input selector keeps cast, outfit/location context and photo text notes only', () => {
  const sd = story();
  const state = { project: {
    storyDirector: sd,
    photoNotes: [{ elementTag: '@Mom', notes: 'round kind face, see /Users/shaz/photos/mom.jpg', path: '/Users/shaz/photos/mom.jpg' }],
    photos: ['/Users/shaz/photos/mom.jpg'], secrets: { OPENROUTER_API_KEY: 'k' }, videoUrl: 'https://example.invalid/v',
  } };
  const s = selectCharacterArchitectInput(state);
  assert.deepEqual(Object.keys(s).sort(), ['cast', 'photoNotes', 'segments']);
  assert.equal(s.cast.length, 3);
  assert.deepEqual(s.segments[0].locations, ['Kitchen']);
  assert.ok(s.segments[0].visualContext.some((v) => /red t-shirt|card/.test(v)));
  const flat = JSON.stringify(s);
  for (const bad of ['dialogue', 'startSec', 'endSec', 'storyboard', 'htmlScriptDocument', 'OPENROUTER', 'example.invalid', '/Users/', '.jpg', 'Then go do science'])
    assert.ok(!flat.includes(bad), `leaked ${bad}`);
  assert.throws(() => CharacterArchitectInput.parse({ ...s, storyboardPrompt: {} }));
});

test('role.md documents the contract and family rules', () => {
  const role = readFileSync(new URL('../crew/character-architect/role.md', import.meta.url), 'utf8');
  for (const k of ['"elementTag"', '"sheetPrompt"', '"expressionCount"', '"outfits"', '"imageTag"', '"targetEngine"', 'nano-banana-2.1',
    'no visible hair, hairline or dark band', 'depicted as 18', 'Shaz has no son', 'exactly eight', 'catchlights', 'rim light', '3,500 and 5,000', 'Google Flow'])
    assert.ok(role.includes(k), k);
});
