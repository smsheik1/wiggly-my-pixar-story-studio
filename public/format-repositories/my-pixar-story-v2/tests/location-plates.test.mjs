import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLocationPlates, LocationPlateParseError } from '../crew/location-scout/schema.mjs';
import { selectLocationScoutInput, LocationScoutInput } from '../crew/location-scout/input.mjs';
import { validateLocationPlates as validate, validateLocationScoutOutput as validateOne, PLATE_OPENING } from '../crew/linter/check-location-plates.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const story = () => json('good-stage-play.json');
const plates = () => json('good-location-plates.json');
const classroom = () => json('good-location-classroom.json').locations[0];
const input = (sd = story(), inputs = {}, extra = {}) => selectLocationScoutInput({ storyDirector: sd, inputs, ...extra });
const P = (d, fn) => { d.locations[0].locationPlatePrompt.promptText = fn(d.locations[0].locationPlatePrompt.promptText); return d; };
const CP = (fn) => { const c = classroom(); c.locationPlatePrompt.promptText = fn(c.locationPlatePrompt.promptText); return c; };
const hasCode = (r, code) => {
  assert.ok(r.issues.some((i) => i.code === code), `expected ${code} in:\n${r.issues.map((i) => i.code + ': ' + i.message).join('\n')}`);
  if (r.issues.find((i) => i.code === code).severity === 'error') assert.equal(r.isValid, false);
};
const twoRooms = () => { const s = story(); s.segments[1].shots[0].location = 'Back Garden'; return s; };
const parseOne = (l) => parseLocationPlates({ locations: [l] });

// ---- ours: contract + coverage ----
test('good kitchen fixture parses and passes the gate with no warnings', () => {
  const r = validate(parseLocationPlates(plates()), input());
  assert.equal(r.isValid, true, r.errors.join('\n')); assert.deepEqual(r.warnings, []);
  assert.ok(plates().locations[0].locationPlatePrompt.promptText.startsWith(PLATE_OPENING));
});
test('selector: inherits locations, builds settings, excludes cast + dialogue', () => {
  const i = input(twoRooms(), { settingSeed: 'suburban home', photoNotes: 'x' });
  assert.deepEqual(i.settings.map((s) => [s.name, s.sceneIds]), [['Kitchen', ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6']], ['Back Garden', ['2.1', '2.2', '2.3']]]);
  assert.equal(i.settingSeed, 'suburban home');
  assert.equal(i.toneDirectives.genre, 'comedy-subversion');
  const s = JSON.stringify(i);
  for (const k of ['cast', 'characters', 'dialogue', 'photoNotes', 'elementTag']) assert.ok(!s.includes(`"${k}"`), k);
});
test('selector scrubs URLs/paths and throws when the first shot has no location', () => {
  const s = story(); s.segments[0].shots[0].whatWeSee += ' see https://x.example/a.png /Users/shaz/p.jpg';
  assert.ok(!/https|\/Users/.test(JSON.stringify(input(s))));
  const bad = story(); delete bad.segments[0].shots[0].location;
  assert.throws(() => input(bad), /no location/);
});
test('input: Gemini per-setting fields derived (actorCount, forbidden accent colours, default tones)', () => {
  const k = input().settings[0];
  assert.ok(k.stagingRequirements.actorCount >= 2 && k.stagingRequirements.actorCount <= story().cast.length, String(k.stagingRequirements.actorCount));
  assert.ok(k.paletteRestrictions.forbiddenWallColors.includes('red'));
  assert.deepEqual(k.paletteRestrictions.dominantEnvironmentTones, ['warm white', 'natural wood', 'muted teal']);
  assert.equal(k.lightingAnchor, undefined); assert.equal(k.singleSignText, undefined);
});
test('input: per-setting overrides from state.locationScout.settings', () => {
  const k = input(story(), {}, { locationScout: { hints: { Kitchen: {
    stagingRequirements: { actorCount: 3, blockingGeometry: 'two chairs across the table', cameraPerspective: 'chest height straight on' },
    lightingAnchor: { source: 'kitchen window', timeOfDay: 'afternoon', shadowCharacteristics: 'long soft shadows' }, singleSignText: 'LAB' } } } }).settings[0];
  assert.equal(k.stagingRequirements.actorCount, 3); assert.equal(k.lightingAnchor.source, 'kitchen window'); assert.equal(k.singleSignText, 'LAB');
  assert.throws(() => input(story(), {}, { locationScout: { hints: { Kitchen: { singleSignText: 'x'.repeat(31) } } } }));
  assert.throws(() => input(story(), {}, { locationScout: { hints: { Kitchen: { stagingRequirements: { actorCount: 0 } } } } }));
});
test('input contract is strict', () => assert.throws(() => LocationScoutInput.parse({ ...input(), characterSheets: [] })));
test('schema: bad tag order/format, multiline, wrong engine, emptySetGuarantee false, bad scene id, extra key, lens bounds', () => {
  for (const f of [(d) => { d.locations[0].elementTag = '@Loc 2'; }, (d) => { d.locations[0].elementTag = '@Kitchen'; }, (d) => P(d, (t) => t + '\nmore'),
    (d) => { d.locations[0].locationPlatePrompt.targetEngine = 'gpt-image-2'; }, (d) => { d.locations[0].emptySetGuarantee = false; },
    (d) => { d.locations[0].sceneIds = ['scene1']; }, (d) => { d.extra = 1; }, (d) => { d.locations[0].cameraStaging.lensMm = 14; }]) {
    const d = plates(); f(d); assert.throws(() => parseLocationPlates(d), LocationPlateParseError);
  }
  assert.throws(() => parseLocationPlates('{nope'), /not valid JSON/);
});
test('schema defaults via prefault: singleSignRule, lensMm', () => {
  const d = plates(); delete d.locations[0].singleSignRule; delete d.locations[0].cameraStaging.lensMm;
  const o = parseLocationPlates(d).locations[0];
  assert.equal(o.singleSignRule.hasSign, false); assert.match(o.singleSignRule.antiRuneExclusion, /no posters/); assert.equal(o.cameraStaging.lensMm, 35);
});
test('HUMAN_FIGURE_IN_BACKGROUND: family words and element tags (Wiggly)', () => {
  hasCode(validate(P(plates(), (t) => t.replace('Secondary Depth', 'A boy sits at the table. Secondary Depth')), input()), 'HUMAN_FIGURE_IN_BACKGROUND');
  hasCode(validate(P(plates(), (t) => t.replace('Secondary Depth', 'Mom waits by the fridge. Secondary Depth')), input()), 'HUMAN_FIGURE_IN_BACKGROUND');
  hasCode(validate(P(plates(), (t) => t.replace('Secondary Depth', '@Shaz chair. Secondary Depth')), input()), 'HUMAN_FIGURE_IN_BACKGROUND');
});
test('MULTILINE_PROMPT', () => hasCode(validate(P(plates(), (t) => t.replace('. Camera', '.\nCamera')), input()), 'MULTILINE_PROMPT'));
test('WRONG_IMAGE_ENGINE (field and prompt text)', () => {
  const d = plates(); d.locations[0].locationPlatePrompt.targetEngine = 'seedream-5'; hasCode(validate(d, input()), 'WRONG_IMAGE_ENGINE');
  hasCode(validate(P(plates(), (t) => t + ' Midjourney style.'), input()), 'WRONG_IMAGE_ENGINE');
});
test('TAG_PARITY: wrong @Loc tag and missing scene ids', () => {
  const d = plates(); d.locations[0].elementTag = '@Loc 3'; hasCode(validate(d, input()), 'TAG_PARITY');
  const e = plates(); e.locations[0].sceneIds.pop(); hasCode(validate(e, input()), 'TAG_PARITY');
});
test('MISSING_SETTING: every stage-play setting needs a plate', () => {
  const r = validate(plates(), input(twoRooms()));
  hasCode(r, 'MISSING_SETTING'); assert.ok(r.errors.some((e) => e.includes('Back Garden')));
});
test('UNKNOWN_SCENE_REF: invented or wrong-room scene ids', () => {
  const d = plates(); d.locations[0].sceneIds.push('9.9'); hasCode(validate(d, input()), 'UNKNOWN_SCENE_REF');
  hasCode(validate(plates(), input(twoRooms())), 'UNKNOWN_SCENE_REF');
});
test('UNKNOWN_SETTING', () => { const d = plates(); d.locations[0].settingName = 'Moon'; hasCode(validate(d, input()), 'UNKNOWN_SETTING'); });
test('PROMPT_LENGTH bounds', () => {
  hasCode(validate(P(plates(), (t) => t.slice(0, 250)), input()), 'PROMPT_LENGTH');
  hasCode(validate(P(plates(), (t) => t + ' warm wood'.repeat(300)), input()), 'PROMPT_LENGTH');
});
test('INVALID_OPENING_STYLE', () => hasCode(validate(P(plates(), (t) => t.replace('production CG, not photorealistic', 'CG')), input()), 'INVALID_OPENING_STYLE'));
test('BANNED_LIVE_ACTION_JARGON: local negation only', () => {
  for (const w of ['film grain', 'Kodak look', 'lens flare', '8K', 'Unreal Engine', 'hyperrealistic', 'live-action', 'shot on 35mm grain'])
    hasCode(validate(P(plates(), (t) => `${t} ${w}.`), input()), 'BANNED_LIVE_ACTION_JARGON');
  // Gemini's version exempted any hit after a "no" anywhere; ours only when directly negated.
  hasCode(validate(P(plates(), (t) => `${t} no photorealistic film grain.`), input()), 'BANNED_LIVE_ACTION_JARGON');
  assert.equal(validate(P(plates(), (t) => `${t} no film grain.`), input()).isValid, true);
});
test('INVALID_ASPECT_RATIO (gate, raw object)', () => { const c = classroom(); c.locationPlatePrompt.aspectRatio = '4:3'; hasCode(validateOne(c), 'INVALID_ASPECT_RATIO'); });
test('warnings: shadows, focal, time of day', () => {
  const r = validate(P(plates(), (t) => t.replace(/shadows/g, 'shade').replace('35mm wide shot', 'framing').replace(/late afternoon|afternoon /g, '')), input());
  for (const c of ['MISSING_SHADOW_DESCRIPTION', 'MISSING_CAMERA_STAGING_FOCAL', 'MISSING_TIME_OF_DAY']) assert.ok(r.issues.some((i) => i.code === c && i.severity === 'warning'), c);
});
test('two-room happy path passes', () => {
  const d = plates(); const g = structuredClone(d.locations[0]);
  d.locations[0].sceneIds = ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6'];
  Object.assign(g, { locationId: 'back-garden', name: 'Back Garden', settingName: 'Back Garden', elementTag: '@Loc 2', sceneIds: ['2.1', '2.2', '2.3'] });
  g.locationPlatePrompt.promptText = g.locationPlatePrompt.promptText.replace('a warm family kitchen in a modern suburban home', 'a small walled back garden behind a suburban home');
  d.locations.push(g);
  const r = validate(parseLocationPlates(d), input(twoRooms())); assert.equal(r.isValid, true, r.errors.join('\n'));
});

// ---- Gemini's 14 cases (classroom plate, adapted: single line, nano-banana-2.1, @Loc 1) ----
test('G1 valid classroom plate passes the gate', () => { const r = validateOne(classroom()); assert.equal(r.isValid, true, r.errors.join('\n')); assert.deepEqual(r.warnings, []); });
test('G2 valid classroom plate parses the schema', () => assert.equal(parseOne(classroom()).locations[0].singleSignRule.signText, 'MY FAMILY'));
test('G3 missing "completely empty of people" -> Empty Set error (gate + schema)', () => {
  const c = CP((t) => t.replaceAll('completely empty of people', 'quiet and peaceful'));
  hasCode(validateOne(c), 'MISSING_EMPTY_OF_PEOPLE'); assert.throws(() => parseOne(c), /Empty Set Law/);
});
test('G4 child in the corner -> HUMAN_FIGURE_IN_BACKGROUND', () =>
  hasCode(validateOne(CP((t) => t.replace('one forgotten cardigan', 'one forgotten cardigan and a child sitting in the corner'))), 'HUMAN_FIGURE_IN_BACKGROUND'));
test('G5 alphabet chart -> BANNED_WALL_TEXT_ELEMENT', () =>
  hasCode(validateOne(CP((t) => t + ' An alphabet chart is taped across the top wall.')), 'BANNED_WALL_TEXT_ELEMENT'));
test('G6 second caps sign -> MULTIPLE_SIGNS_DETECTED', () =>
  hasCode(validateOne(CP((t) => t + ' A second sign reading "WELCOME TO CLASS" hangs on the door.')), 'MULTIPLE_SIGNS_DETECTED'));
test('G7 fluorescent flat light -> MISSING_LIGHTING_SOURCE', () =>
  hasCode(validateOne(CP((t) => t.replace(/Lighting & Atmosphere: .*?floor\./, 'Lighting & Atmosphere: flat ambient interior fluorescent illumination throughout.'))), 'MISSING_LIGHTING_SOURCE'));
test('G8 Photorealistic kodak 35mm film grain -> BANNED_LIVE_ACTION_JARGON', () =>
  hasCode(validateOne(CP((t) => t + ' Photorealistic kodak 35mm film grain.')), 'BANNED_LIVE_ACTION_JARGON'));
test('G9 schema: signText not in prompt -> Anti-Rune refine', () => {
  const c = classroom(); c.singleSignRule.signText = 'SHOW AND TELL'; assert.throws(() => parseOne(c), /Anti-Rune/);
});
test('G10 child-sized chairs, child-height tables, teacher\'s desk -> no false positive', () => {
  const r = validateOne(CP((t) => t.replace('low tables with small stacking chairs', "child-sized wooden chairs, low child-height tables and a teacher's desk")));
  assert.equal(r.isValid, true, r.errors.join('\n'));
});
test('G11 title-case second banner -> MULTIPLE_SIGNS_DETECTED', () =>
  hasCode(validateOne(CP((t) => t + ' A banner reading "Welcome to Kindergarten" hangs by the door.')), 'MULTIPLE_SIGNS_DETECTED'));
test('G12 bright neon yellow wall -> PALETTE_DISCIPLINE_VIOLATION', () =>
  hasCode(validateOne(CP((t) => t.replace('A warm white wall', 'A bright neon yellow wall'))), 'PALETTE_DISCIPLINE_VIOLATION'));
test('G13 hasSign false with a sign in the prompt -> UNEXPECTED_SIGN_PRESENT', () => {
  const c = classroom(); c.singleSignRule = { hasSign: false }; hasCode(validateOne(c), 'UNEXPECTED_SIGN_PRESENT');
});
test('G14 schema: hasSign true with empty signText -> signText REQUIRED', () => {
  const c = classroom(); c.singleSignRule.signText = ''; assert.throws(() => parseOne(c), /signText is REQUIRED/);
});
test('SIGN_TEXT_MISSING (gate, raw object)', () => { const c = classroom(); c.singleSignRule.signText = 'LAB'; hasCode(validateOne(c), 'SIGN_TEXT_MISSING'); });
// ---- r4 rehearsal false positives (Wiggly) ----
const lp = (f) => CP((t) => f(t));
const codes = (r) => r.issues.map((i) => i.code);
test('people check: negated lists, possessive rooms, action figures, family photos are not people', () => {
  for (const add of [' A classroom with simple student desks in rows.', ' Kid chairs and teacher desks.', ' No people, figures or crowds anywhere.', " The sister's bedroom door is ajar.", ' Yu-Gi-Oh action figures on the shelf.', ' Framed family photos on the wall.', ' A baby blue blanket.', " Dad's car keys on a hook."])
    assert.ok(!codes(validateOne(lp((t) => t + add))).includes('HUMAN_FIGURE_IN_BACKGROUND'), add);
  for (const add of [' A student sits at a desk.', ' A boy sits on the rug.', ' A woman waits by the door.', ' Mom stands at the stove.'])
    assert.ok(codes(validateOne(lp((t) => t + add))).includes('HUMAN_FIGURE_IN_BACKGROUND'), add);
});
test('night / car / interior practical key lights count as a lighting source; flat ambient still fails', () => {
  const swap = (s) => lp((t) => t.replace(/Lighting & Atmosphere: .*?floor\./, `Lighting & Atmosphere: ${s}`));
  for (const s of ['night, warm streetlights through the windshield and a soft dashboard glow.', 'night, a single bedside lamp casting long shadows.', 'evening, cool moonlight through the window.', 'overhead fluorescent tubes hum above the desks.'])
    assert.ok(!codes(validateOne(swap(s))).includes('MISSING_LIGHTING_SOURCE'), s);
  assert.ok(codes(validateOne(swap('flat even ambient illumination everywhere.'))).includes('MISSING_LIGHTING_SOURCE'));
});
test('palette: fluorescent tube lighting is fine; fluorescent colours still fail', () => {
  assert.ok(!codes(validateOne(lp((t) => t + ' Overhead fluorescent tubes.'))).includes('PALETTE_DISCIPLINE_VIOLATION'));
  assert.ok(codes(validateOne(lp((t) => t + ' Fluorescent green walls.'))).includes('PALETTE_DISCIPLINE_VIOLATION'));
});
