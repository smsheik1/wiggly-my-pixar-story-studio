// Shaz's r4-dry5 review: @tags not re-descriptions, camera direction, defined locations, sunglasses on forehead,
// photo characters never guessed (photos reach the Character Architect only), max 2 cards per real person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryDirectorOutputSchema } from '../crew/story-director/schema.mjs';
import { validateStoryDirectorOutput, EYES_HIDDEN, lookPhrases } from '../crew/linter/check-stage-play.mjs';
import { selectStoryDirectorInput } from '../crew/story-director/input.mjs';
import { selectCharacterArchitectInput } from '../crew/character-architect/input.mjs';
import { selectLocationScoutInput } from '../crew/location-scout/input.mjs';
import { prepareRunWorkspace, photoFilesFor, systemPromptFor } from '../graph/deep-agent-node.mjs';
import { loadPhotoReferences, defaultPhotoRefsPath } from '../scripts/run-rehearsal.mjs';

const good = () => JSON.parse(readFileSync(new URL('./fixtures/good-stage-play.json', import.meta.url)));
const codes = (d, input) => validateStoryDirectorOutput(d, input).issues.filter((i) => i.severity === 'error').map((i) => i.code);
const shot0 = (d) => d.segments[0].shots[0];
const REFS = [{ id: 'shaz-child', name: 'Shaz', realPerson: 'Shaz', age: 8, skinTone: 'light olive', description: 'Slim boy, short straight black hair.', path: '/Users/shaz/secret/p.jpg' }];

test('fixture passes; every shot has camera + a defined location', () => {
  assert.deepEqual(codes(good()), []);
  assert.equal(StoryDirectorOutputSchema.safeParse(good()).success, true);
});
test('camera direction is required (schema + MISSING_CAMERA_DIRECTION)', () => {
  for (const k of ['framing', 'cameraAngle', 'cameraMove']) {
    const d = good(); delete shot0(d)[k];
    assert.equal(StoryDirectorOutputSchema.safeParse(d).success, false, k);
    assert.ok(codes(d).includes('MISSING_CAMERA_DIRECTION'), k);
  }
});
test('location required on every shot and must be in locations[]', () => {
  let d = good(); delete d.segments[0].shots[2].location;
  assert.equal(StoryDirectorOutputSchema.safeParse(d).success, false); assert.ok(codes(d).includes('MISSING_LOCATION'));
  d = good(); d.segments[0].shots[2].location = 'Garage';
  assert.equal(StoryDirectorOutputSchema.safeParse(d).success, false); assert.ok(codes(d).includes('UNKNOWN_LOCATION'));
  d = good(); delete d.locations; assert.ok(codes(d).includes('NO_LOCATIONS'));
});
test('REDESCRIBED_CHARACTER: shots repeating cast look phrases fail; @tag only passes', () => {
  const d = good(); shot0(d).whatWeSee = '@Mom with warm medium brown skin waits in the doorway.';
  assert.ok(codes(d).includes('REDESCRIBED_CHARACTER'));
  const e = good(); shot0(e).whatWeSee = '@Mom, soft blue hijab fully covering hair, waits.';
  assert.ok(codes(e).includes('REDESCRIBED_CHARACTER'));
  assert.ok(lookPhrases(good().cast[1]).includes('warm medium brown'));
});
test('UNTAGGED_CHARACTER: bare names fail', () => {
  const d = good(); shot0(d).whatWeSee = 'Shaz slaps a card down across the table from @Sister.';
  assert.ok(codes(d).includes('UNTAGGED_CHARACTER'));
});
test('EYES_HIDDEN: any eyewear that hides the eyes, in shots, cast and panels (generic, not one family accessory)', () => {
  for (const t of ['@Shaz wearing matte black sunglasses', 'sunglasses over his eyes', '@Shaz puts on his sunglasses', 'eyes hidden behind sunglasses', 'his sunglasses covering his eyes',
    '@Gran lowers her ski goggles', 'mirrored shades on her face', 'reading glasses covering her eyes', 'eyes hidden behind dark glasses', '@Theo wearing tinted glasses'])
    assert.ok(EYES_HIDDEN.test(t), t);
  for (const t of ['@Shaz, sunglasses pushed up on his forehead, grins', '@Shaz pushes his sunglasses higher up his forehead', '@Gran peers over her reading glasses',
    '@Gran, round reading glasses on her nose, eyes visible', 'ski goggles pushed up on his forehead', '@Theo wipes his glasses'])
    assert.ok(!EYES_HIDDEN.test(t), t);
  let d = good(); shot0(d).whatWeSee = '@Shaz slaps a card down, sunglasses over his eyes.'; assert.ok(codes(d).includes('EYES_HIDDEN'));
  d = good(); d.cast[0].physicalDescription = 'Small boy, short black hair, matte black sunglasses, red t-shirt.'; assert.ok(codes(d).includes('EYES_HIDDEN'));
  d = good(); d.cast[1].signatureAccent = 'dark aviator glasses'; assert.ok(codes(d).includes('EYES_HIDDEN'));
  d = good(); d.storyboardSheets[0].panels[0].whatIsInFrame = 'Warm brown boy wearing dark sunglasses'; assert.ok(codes(d).includes('EYES_HIDDEN'));
});
test('TOO_MANY_AGE_VARIANTS: max 3 cards per real person, one per life stage (by realPerson, or name minus age words)', () => {
  const d = good(); const base = d.cast[0];
  d.cast.push({ ...base, name: 'Dad Shaz', elementTag: '@DadShaz', age: 34 });
  d.cast.push({ ...base, name: 'Teen Shaz', elementTag: '@TeenShaz', age: 18, ageNote: 'true age 17; shown as 18' });
  assert.ok(!codes(d).includes('TOO_MANY_AGE_VARIANTS'), 'child + young adult + adult is allowed');
  d.cast.push({ ...base, name: 'Old Shaz', elementTag: '@OldShaz', age: 70 });
  assert.ok(codes(d).includes('TOO_MANY_AGE_VARIANTS'));
  const e = good(); for (const n of ['Teen Shaz', 'Adult Shaz', 'Grown Shaz']) e.cast.push({ ...e.cast[0], name: n, elementTag: '@' + n.replace(' ', ''), realPerson: undefined });
  assert.ok(codes(e).includes('TOO_MANY_AGE_VARIANTS'));
});
test('photo characters: skin tone copied from the photo; guessed skin tone assumption fails', () => {
  const input = { photoCharacters: REFS };
  const d = good(); d.cast[0].photoRef = 'shaz-child';
  assert.ok(codes(d, input).includes('SKIN_TONE_NOT_FROM_PHOTO'));
  d.cast[0].skinTone = 'light olive'; assert.ok(!codes(d, input).includes('SKIN_TONE_NOT_FROM_PHOTO'));
  d.assumptions = ['Skin tone warm medium brown assumed for all family; no photos provided.'];
  assert.ok(codes(d, input).includes('GUESSED_SKIN_TONE'));
  d.cast[0].photoRef = 'nope'; assert.ok(codes(d, input).includes('UNKNOWN_PHOTO_REF'));
});
test('r4-dry5 Story Director output fails all six review rules', () => {
  const f = new URL('../runs/r4-dry5/outputs/story-director.json', import.meta.url);
  if (!existsSync(f)) return; // runs/ is local only
  const c = new Set(codes(JSON.parse(readFileSync(f)), { photoCharacters: REFS }));
  for (const k of ['MISSING_CAMERA_DIRECTION', 'MISSING_LOCATION', 'REDESCRIBED_CHARACTER', 'EYES_HIDDEN', 'TOO_MANY_AGE_VARIANTS', 'GUESSED_SKIN_TONE']) assert.ok(c.has(k), k);
});
test('SD input gets photo text (no paths); CA gets photoFile; LS gets location descriptions', () => {
  const sd = selectStoryDirectorInput({ inputs: { answers: { a: 1 }, photoReferences: REFS } });
  assert.deepEqual(sd.photoCharacters, [{ id: 'shaz-child', name: 'Shaz', realPerson: 'Shaz', age: 8, skinTone: 'light olive', description: 'Slim boy, short straight black hair.' }]);
  assert.ok(!JSON.stringify(sd).includes('/Users'));
  const story = good(); story.cast[0].photoRef = 'shaz-child'; story.cast[0].skinTone = 'light olive';
  const state = { inputs: { answers: {}, photoReferences: REFS }, storyDirector: story };
  const ca = selectCharacterArchitectInput(state);
  const n = ca.photoNotes.find((x) => x.elementTag === '@Shaz');
  assert.equal(n.photoFile, '/references/photos/shaz-child.jpg'); assert.match(n.notes, /light olive/);
  assert.ok(!JSON.stringify(ca).includes('/Users'));
  assert.deepEqual(photoFilesFor('character-architect', ca, state), { '/references/photos/shaz-child.jpg': '/Users/shaz/secret/p.jpg' });
  for (const a of ['story-director', 'location-scout', 'seedance-compiler']) assert.deepEqual(photoFilesFor(a, ca, state), {});
  assert.match(systemPromptFor('character-architect', '', { photos: true }), /\/references\/photos\//);
  assert.match(systemPromptFor('location-scout'), /not available/);
  const ls = selectLocationScoutInput({ storyDirector: good() });
  assert.match(ls.settings[0].description, /scuffed wooden table/);
});
test('prepareRunWorkspace copies reference photos read-only into references/photos; loadPhotoReferences validates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v2photo-'));
  try {
    const src = join(dir, 'p.jpg'); writeFileSync(src, 'jpgbytes');
    const { root } = await prepareRunWorkspace({ runsRoot: join(dir, 'runs'), runId: 'r', agent: 'character-architect', input: {}, photoFiles: { '/references/photos/shaz-child.jpg': src } });
    assert.equal(readFileSync(join(root, 'references/photos/shaz-child.jpg'), 'utf8'), 'jpgbytes');
    await assert.rejects(prepareRunWorkspace({ runsRoot: join(dir, 'runs'), runId: 'r2', agent: 'character-architect', input: {}, photoFiles: { '/etc/passwd': src } }), /bad photo path/);
    const f = join(dir, 'proj-photo-refs.json');
    writeFileSync(f, JSON.stringify([{ ...REFS[0], path: src }]));
    assert.equal((await loadPhotoReferences(f)).length, 1);
    assert.equal(defaultPhotoRefsPath(join(dir, 'proj.json')), f);
    assert.deepEqual(await loadPhotoReferences(join(dir, 'missing.json')), []);
    writeFileSync(f, JSON.stringify([{ ...REFS[0], path: join(dir, 'gone.jpg') }]));
    await assert.rejects(loadPhotoReferences(f), /not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('TOO_MANY_ON_SCREEN: max 2 @tags in whatWeSee', () => {
  const d = good(); shot0(d).whatWeSee = '@Shaz slaps a card down; @Sister blinks; @Mom watches.';
  assert.ok(codes(d).includes('TOO_MANY_ON_SCREEN'));
  shot0(d).whatWeSee = '@Shaz slaps a card down; @Sister blinks.'; assert.ok(!codes(d).includes('TOO_MANY_ON_SCREEN'));
});
test('MISSING_TRUE_AGE: an 18-year-old card records the true age', () => {
  const d = good(); d.cast[2].ageNote = null; assert.ok(codes(d).includes('MISSING_TRUE_AGE'));
});
test('RESUME_DIALOGUE: facts go in narration, not in-scene dialogue', () => {
  const d = good(); const s = d.segments[0].shots.find((h) => h.dialogue);
  s.dialogue.line = '{I got a 50k salary!}'; assert.ok(codes(d).includes('RESUME_DIALOGUE'));
  const e = good(); const n = e.segments[1].shots[0]; n.narration.line = '{I was nineteen, 50k a year.}';
  assert.ok(!codes(e).includes('RESUME_DIALOGUE'));
});
test('finale narration length is optional (no FINALE_TOO_THIN)', () => {
  const d = good(); d.segments.at(-1).shots.slice(1).forEach((h) => { delete h.narration; });
  assert.ok(!codes(d).includes('FINALE_TOO_THIN'));
});
