import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCharacterSheets, CharacterSheetParseError, CharacterSchema } from '../crew/character-architect/schema.mjs';
import { selectCharacterArchitectInput, CharacterArchitectInput } from '../crew/character-architect/input.mjs';
import { validateCharacterArchitectOutput as validateOne, validateCharacterSheets as validate } from '../crew/linter/check-character-sheets.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const json = (f) => JSON.parse(fx(f));
const story = () => json('good-stage-play.json');
const sheets = () => json('good-character-sheets.json');
const masters = () => json('good-master-renders.json');
const C = (d, tag) => d.characters.find((c) => c.elementTag === tag);
const hasCode = (r, code, sub) => {
  const hit = r.issues.find((i) => i.code === code && (!sub || i.message.includes(sub)));
  assert.ok(hit, `expected ${code}${sub ? ` "${sub}"` : ''} in:\n${r.issues.map((i) => i.code + ': ' + i.message).join('\n')}`);
  if (hit.severity === 'error') assert.equal(r.isValid, false);
};

// Gemini's fixtures, adapted only for engine (nano-banana-2.1) and single-line flattening.
const dad = () => ({
  characterId: 'dad', name: 'Dad', elementTag: '@Dad',
  designSpecs: { headsTall: 7, dominantSilhouette: 'a broad triangle', exaggeration: 'heavy square jaw', counterpart: 'small rounded nose, smallish eyes',
    skinZoning: 'deep', signatureAccent: 'red elasticated braces', isChildProportionRiderApplied: false, cleanSkinGuarantee: true, emptyHandsGuarantee: true },
  masterRenderPrompt: { targetEngine: 'nano-banana-2.1', promptText: fx('gemini-ca-dad-master.txt'), aspectRatio: '1:1' },
});
const mia = () => ({
  characterId: 'mia', name: 'Mia', elementTag: '@Mia',
  designSpecs: { headsTall: 4.5, dominantSilhouette: 'a small round pear', exaggeration: 'huge bright eyes', counterpart: 'button nose, tiny mouth',
    skinZoning: 'light', signatureAccent: 'yellow hair clip', isChildProportionRiderApplied: true, cleanSkinGuarantee: true, emptyHandsGuarantee: true },
  modelSheetPrompt: { targetEngine: 'nano-banana-2.1', promptText: fx('gemini-ca-mia-sheet.txt'), aspectRatio: '16:9', resolution: '2K', masterRenderRef: 'asset:master-render:mia-v1', expressionCount: 8 },
});
const edit = (o, k, fn) => { o[k].promptText = fn(o[k].promptText); return o; };

// ---- Gemini's 13 cases ----
test('G1 valid master render passes (dad)', () => { const r = validateOne(dad()); assert.equal(r.isValid, true, r.errors.join('\n')); });
test('G2 valid Format B sheet passes (Mia)', () => { const r = validateOne(mia()); assert.equal(r.isValid, true, r.errors.join('\n')); });
test('G3 held object -> Empty Hands Law Violated', () =>
  hasCode(validateOne(edit(dad(), 'masterRenderPrompt', (t) => t.replace('Pose:', 'He holds a heavy firefighter axe in his hands. Pose:'))), 'HELD_OBJECT_VIOLATION', 'Empty Hands Law Violated'));
test('G4 tattoo -> Never put ink, pen, or drawn marks on skin', () =>
  hasCode(validateOne(edit(dad(), 'masterRenderPrompt', (t) => t.replace('Hands:', 'A black ink anchor tattoo on his right forearm. Hands:'))), 'SKIN_INK_VIOLATION', 'Never put ink, pen, or drawn marks on skin'));
test('G5 bobblehead adult -> child proportion token', () =>
  hasCode(validateOne(edit(dad(), 'masterRenderPrompt', (t) => t.replace('Adult head-to-body ratio', 'Adult head-to-body ratio, an enlarged head and narrow shoulders'))), 'BOBBLEHEAD_ADULT_VIOLATION', 'child proportion token'));
test('G6 light zoning on brown skin -> Deep Skin Zoning', () => {
  const d = dad(); d.designSpecs.skinZoning = 'light';
  hasCode(validateOne(d), 'SKIN_ZONING_MISMATCH', 'Deep Skin Zoning');
});
test('G7 hex removed -> #B5B5B5', () => hasCode(validateOne(edit(mia(), 'modelSheetPrompt', (t) => t.replace('#B5B5B5', 'mid-grey'))), 'MISSING_HEX_LOCK', '#B5B5B5'));
test('G8 "8) TALKING" -> "8) SMILING" -> missing expression', () =>
  hasCode(validateOne(edit(mia(), 'modelSheetPrompt', (t) => t.replace('8) TALKING', '8) SMILING'))), 'MISSING_EXPRESSION', '8) TALKING'));
test('G9 child "a cute round belly" -> round belly', () =>
  hasCode(validateOne(edit(mia(), 'modelSheetPrompt', (t) => t.replace('4.5 heads tall.', '4.5 heads tall, a cute round belly.'))), 'CHILD_ROUND_BELLY_VIOLATION', 'round belly'));
test('G10 "and back view" -> "and rear angle" -> back view', () =>
  hasCode(validateOne(edit(mia(), 'modelSheetPrompt', (t) => t.replace('and back view', 'and rear angle'))), 'MISSING_TURNAROUND_VIEW', 'back view'));
test('G11 sheet + small black ink star tattoo -> tattoo', () =>
  hasCode(validateOne(edit(mia(), 'modelSheetPrompt', (t) => t + ' A small black ink star tattoo on left wrist.')), 'SHEET_SKIN_INK_VIOLATION', 'tattoo'));
test('G12 Zod: child without rider -> Child Proportion Rider is MANDATORY', () => {
  const c = C(sheets(), '@Shaz'); c.designSpecs.isChildProportionRiderApplied = false;
  const r = CharacterSchema.safeParse(c);
  assert.equal(r.success, false);
  assert.ok(r.error.issues.some((i) => i.message.includes('Child Proportion Rider is MANDATORY')));
});
test('G13 Zod: adult with rider -> Bobblehead Anti-Pattern', () => {
  const c = C(sheets(), '@Mom'); c.designSpecs.isChildProportionRiderApplied = true;
  const r = CharacterSchema.safeParse(c);
  assert.equal(r.success, false);
  assert.ok(r.error.issues.some((i) => i.message.includes('Bobblehead Anti-Pattern')));
});

// ---- Wiggly gate (cast-level, both modes) ----
const run = (fn, base = sheets, s = story()) => { const d = base(); fn(d, s); return validate(d, s); };
test('Wiggly master-render and model-sheet fixtures parse and pass against the Story Director cast', () => {
  for (const d of [masters(), sheets()]) {
    assert.doesNotThrow(() => parseCharacterSheets(d));
    const r = validate(d, story()); assert.equal(r.isValid, true, r.errors.join('\n')); assert.deepEqual(r.warnings, []);
  }
});
test('TAG_PARITY both directions', () => {
  hasCode(run((d) => { d.characters.pop(); }), 'TAG_PARITY');
  hasCode(run((d) => { d.characters.push({ ...dad(), imageTag: '@Image 4' }); }), 'TAG_PARITY');
});
test('MULTILINE_PROMPT (master and sheet)', () => {
  hasCode(run((d) => { C(d, '@Shaz').masterRenderPrompt.promptText = C(d, '@Shaz').masterRenderPrompt.promptText.replace(' Eyes:', '\nEyes:'); }), 'MULTILINE_PROMPT');
  hasCode(run((d) => { C(d, '@Mom').modelSheetPrompt.promptText = C(d, '@Mom').modelSheetPrompt.promptText.replace(' TOP ROW', '\nTOP ROW'); }), 'MULTILINE_PROMPT');
});
test('PROMPT_LENGTH on Wiggly sheets (3,500-5,000)', () => {
  hasCode(run((d) => { C(d, '@Shaz').modelSheetPrompt.promptText = C(d, '@Shaz').modelSheetPrompt.promptText.slice(0, 3000); }), 'PROMPT_LENGTH');
  hasCode(run((d) => { C(d, '@Shaz').modelSheetPrompt.promptText += ' Soft warm light.'.repeat(90); }), 'PROMPT_LENGTH');
});
test('MISSING_SKIN_TONE', () => hasCode(run((d) => { const m = C(d, '@Sister').masterRenderPrompt; m.promptText = m.promptText.replaceAll('light warm brown', 'natural'); }), 'MISSING_SKIN_TONE'));
test('MISSING_HIJAB and HAIR_VISIBLE; non-family exempt', () => {
  hasCode(run((d) => { const m = C(d, '@Mom').masterRenderPrompt; m.promptText = m.promptText.replace(', with no visible hair, hairline or dark band at the forehead', ''); }), 'MISSING_HIJAB');
  hasCode(run((d) => { const m = C(d, '@Mom').modelSheetPrompt; m.promptText = m.promptText.replace('Stylized proportions', 'Soft bangs peek out at the front. Stylized proportions'); }), 'HAIR_VISIBLE');
  const r = validateOne({ ...C(sheets(), '@Sister'), family: false, masterRenderPrompt: { ...C(sheets(), '@Sister').masterRenderPrompt, promptText: C(sheets(), '@Sister').masterRenderPrompt.promptText.replaceAll('hijab', 'scarf').replace(/no visible hair, hairline or dark band/, 'a neat wrap') } });
  assert.ok(!r.issues.some((i) => i.code === 'MISSING_HIJAB'));
});
test('UNDERAGE_DEPICTION by age and wording; Shaz at 8 is fine', () => {
  hasCode(run((d) => { C(d, '@Sister').age = 16; }), 'UNDERAGE_DEPICTION');
  hasCode(run((d) => { const m = C(d, '@Sister').masterRenderPrompt; m.promptText = m.promptText.replace('an eighteen-year-old young woman', 'a teenage girl'); }), 'UNDERAGE_DEPICTION');
  assert.ok(!validate(sheets(), story()).issues.some((i) => i.code === 'UNDERAGE_DEPICTION'));
});
test('WRONG_IMAGE_ENGINE (field and text, both phases)', () => {
  hasCode(run((d) => { C(d, '@Shaz').masterRenderPrompt.targetEngine = 'gpt-image-2'; }), 'WRONG_IMAGE_ENGINE');
  hasCode(run((d) => { C(d, '@Shaz').modelSheetPrompt.targetEngine = 'seedream-5.0-pro'; }), 'WRONG_IMAGE_ENGINE');
  hasCode(run((d) => { const m = C(d, '@Shaz').modelSheetPrompt; m.promptText = 'For Seedream, ' + m.promptText; }), 'WRONG_IMAGE_ENGINE');
});
test('BANNED_JARGON includes "minor"; negated live-action words are allowed', () => {
  hasCode(run((d) => { const m = C(d, '@Shaz').masterRenderPrompt; m.promptText = m.promptText.replace('an eight-year-old boy', 'a minor, eight years old'); }), 'BANNED_JARGON', "'minor'");
  hasCode(run((d) => { const m = C(d, '@Shaz').masterRenderPrompt; m.promptText += ' Film grain.'; }), 'BANNED_LIVE_ACTION_JARGON');
});
test('BOBBLEHEAD and CHILD_RIDER_MISSING gate codes', () => {
  hasCode(run((d) => { C(d, '@Mom').designSpecs.isChildProportionRiderApplied = true; }), 'BOBBLEHEAD', 'Bobblehead Anti-Pattern');
  hasCode(run((d) => { C(d, '@Shaz').designSpecs.isChildProportionRiderApplied = false; }), 'CHILD_RIDER_MISSING', 'Child Proportion Rider is MANDATORY');
});
test('skin zoning: "black hijab" / "black trousers" do not force deep zoning (Wiggly deviation)', () => {
  const d = dad(); d.designSpecs.skinZoning = 'light';
  d.masterRenderPrompt.promptText = d.masterRenderPrompt.promptText.replace('warm brown skin', 'fair skin').replace('black moustache', 'brown moustache') + ' Black trousers, a black hijab on the hook behind.';
  assert.ok(!validateOne(d).issues.some((i) => i.code === 'SKIN_ZONING_MISMATCH'));
});
test('modes: model-sheet needs attached master render ref; master-render forbids sheets', () => {
  hasCode(run((d) => { const m = C(d, '@Shaz').modelSheetPrompt; m.promptText = m.promptText.replace('Match the attached approved master render', 'Follow the design'); }), 'MASTER_RENDER_NOT_REFERENCED');
  hasCode(run((d) => { delete C(d, '@Shaz').modelSheetPrompt; }), 'MISSING_MODEL_SHEET');
  hasCode(run((d) => { C(d, '@Shaz').modelSheetPrompt = C(sheets(), '@Shaz').modelSheetPrompt; }, masters), 'WRONG_MODE');
});

// ---- Zod contract ----
test('schema: violations throw CharacterSheetParseError with paths', () => {
  assert.throws(() => parseCharacterSheets('{x'), CharacterSheetParseError);
  const bad = (fn, re, base = sheets) => { const d = base(); fn(d); assert.throws(() => parseCharacterSheets(d), (e) => e instanceof CharacterSheetParseError && re.test(e.message)); };
  bad((d) => { d.characters[0].modelSheetPrompt.promptText = 'short'; }, /at least 3500/);
  bad((d) => { d.characters[0].masterRenderPrompt.promptText += '\nx'; }, /single line/);
  bad((d) => { d.characters[0].masterRenderPrompt.targetEngine = 'gpt-image-2'; }, /targetEngine/);
  bad((d) => { d.characters[0].modelSheetPrompt.targetEngine = 'seedream-5.0-pro'; }, /targetEngine/);
  bad((d) => { d.characters[0].masterRenderPrompt.aspectRatio = '16:9'; }, /aspectRatio/);
  bad((d) => { d.characters[0].modelSheetPrompt.masterRenderRef = 'https://example.invalid/m.png'; }, /local asset key/);
  bad((d) => { d.characters[0].modelSheetPrompt.masterRenderRef = '/Users/shaz/m.png'; }, /local asset key/);
  bad((d) => { d.characters[0].modelSheetPrompt.expressionCount = 12; }, /expressionCount/);
  bad((d) => { d.characters[1].imageTag = '@Image 5'; }, /@Image 2/);
  bad((d) => { d.characters[2].age = 15; }, /depicted as 18/);
  bad((d) => { d.characters[0].outfits[0].isMain = false; }, /isMain/);
  bad((d) => { d.characters[0].designSpecs.cleanSkinGuarantee = false; }, /cleanSkinGuarantee/);
  bad((d) => { delete d.characters[0].modelSheetPrompt; }, /REQUIRED in model-sheet mode/);
  bad((d) => { d.characters[0].modelSheetPrompt = sheets().characters[0].modelSheetPrompt; }, /master renders only/, masters);
});

// ---- input slice ----
const state = () => ({ project: {
  storyDirector: story(),
  photoNotes: [{ elementTag: '@Mom', notes: 'round kind face, see /Users/shaz/photos/mom.jpg', path: '/Users/shaz/photos/mom.jpg' }],
  photos: ['/Users/shaz/photos/mom.jpg'], secrets: { OPENROUTER_API_KEY: 'k' }, videoUrl: 'https://example.invalid/v',
} });
test('input selector keeps cast, outfit/location context and photo text notes only', () => {
  const s = selectCharacterArchitectInput(state());
  assert.deepEqual(Object.keys(s).sort(), ['cast', 'mode', 'photoNotes', 'segments']);
  assert.equal(s.mode, 'master-render');
  assert.equal(s.cast.length, 3);
  assert.deepEqual(s.segments[0].locations, ['Kitchen']);
  const flat = JSON.stringify(s);
  for (const bad of ['dialogue', 'startSec', 'endSec', 'storyboard', 'htmlScriptDocument', 'OPENROUTER', 'example.invalid', '/Users/', '.jpg', 'Then go do science'])
    assert.ok(!flat.includes(bad), `leaked ${bad}`);
  assert.throws(() => CharacterArchitectInput.parse({ ...s, storyboardPrompt: {} }));
});
test('input: model-sheet mode requires masterRenderRef per cast tag (Gemini wording); asset keys only', () => {
  const st = state(); st.project.characterArchitect = { options: { mode: 'model-sheet' } };
  assert.throws(() => selectCharacterArchitectInput(st), /masterRenderRef is REQUIRED when generating a model-sheet \(Format B\)/);
  st.project.characterArchitect.options.masterRenderRef = { '@Shaz': 'asset:master-render:shaz-v1' };
  assert.throws(() => selectCharacterArchitectInput(st), /missing for @Mom, @Sister/);
  st.project.characterArchitect.options.masterRenderRef = { '@Shaz': 'a:1', '@Mom': 'a:2', '@Sister': 'https://x.invalid/s.png' };
  assert.throws(() => selectCharacterArchitectInput(st), /local asset key/);
  st.project.characterArchitect = { options: { mode: 'model-sheet', masterRenderRef: { '@Shaz': 'a:1', '@Mom': 'a:2', '@Sister': 'a:3' }, variationDirectives: { focusTrait: 'sunglasses' } } };
  const s = selectCharacterArchitectInput(st);
  assert.equal(s.mode, 'model-sheet'); assert.equal(s.variationDirectives.focusTrait, 'sunglasses');
  assert.throws(() => CharacterArchitectInput.parse({ ...s, variationDirectives: { referenceStyleImageUrl: 'https://x' } }));
});
