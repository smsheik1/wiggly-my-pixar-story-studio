// Storyboard Artist: schema, gates (coverage, plate, cast, wardrobe, twins, prop leak), sheet compile, graph routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemorySaver, Command } from '@langchain/langgraph';
import { parseStoryboard, StoryboardParseError } from '../crew/storyboard-artist/schema.mjs';
import { selectStoryboardArtistInput } from '../crew/storyboard-artist/input.mjs';
import { compileSheets, SB_SHEET_OPENING, SB_SHEET_LAYOUT, sbPanelLabel } from '../crew/storyboard-artist/compile.mjs';
import { validateStoryboard, accessoriesIn } from '../crew/linter/check-storyboard.mjs';
import { makeAnimaticApprovalNode, animaticRoute } from '../graph/graph.mjs';
import { draftStoryboard } from './fixtures/storyboard-draft.mjs';

// Generic synthetic cast: two siblings, a parent with headwear, a kid with eyewear.
const state = () => ({
  storyDirector: { segments: [
    { segmentId: 1, shots: [
      { shotNumber: 1, startSec: 0, endSec: 4, location: 'Kitchen', framing: 'wide', cameraAngle: 'eye level', whatWeSee: '@Kid and @Sib at the table', onScreen: ['@Kid', '@Sib'], narration: { speaker: '@Kid', line: '{Hi.}' } },
      { shotNumber: 2, startSec: 4, endSec: 7, framing: 'medium', whatWeSee: '@Parent hands @Sib a plate', onScreen: ['@Parent', '@Sib'] },
    ] },
    { segmentId: 2, shots: [{ shotNumber: 1, startSec: 0, endSec: 5, location: 'Garage', whatWeSee: 'an empty garage', onScreen: [] }] },
  ] },
  characterArchitect: { output: { characters: [
    { elementTag: '@Kid', imageTag: '@Image 1', name: 'Kid', age: 8, gender: 'male', skinTone: 'warm brown', outfits: [{ segmentIds: [1], description: 'red t-shirt, blue shorts, sunglasses pushed up on the forehead' }], visualTell: 'sunglasses pushed up on the forehead' },
    { elementTag: '@Sib', imageTag: '@Image 2', name: 'Sib', age: 16, gender: 'female', skinTone: 'warm brown', outfits: [{ segmentIds: [1], description: 'green hoodie, grey jeans' }], visualTell: 'long hair worn uncovered' },
    { elementTag: '@Parent', imageTag: '@Image 3', name: 'Parent', age: 40, gender: 'female', skinTone: 'warm brown', outfits: [{ segmentIds: [1], description: 'navy dress with a navy hijab' }] },
  ] } },
  locationScout: { output: { locations: [
    { elementTag: '@Loc 1', settingName: 'Kitchen', sceneIds: ['1.1', '1.2'] }, { elementTag: '@Loc 2', settingName: 'Garage', sceneIds: ['2.1'] },
  ] } },
});
const input = () => selectStoryboardArtistInput(state());
const good = () => draftStoryboard(input());
const codes = (o) => validateStoryboard(o, input()).issues.filter((i) => i.severity === 'error').map((i) => i.code);

test('input slice: shot ids, durations, plate per shot, line text', () => {
  const i = input();
  assert.deepEqual(i.shots.map((s) => [s.shotId, s.durationSec, s.locationTag]), [['1.1', 4, '@Loc 1'], ['1.2', 3, '@Loc 1'], ['2.1', 5, '@Loc 2']]);
  assert.equal(i.shots[0].line.text, 'Hi.');
});
test('schema: valid draft parses; bad shot id and >8 panels rejected', () => {
  assert.ok(parseStoryboard(JSON.stringify(good())));
  const o = good(); o.sheets[0].panels[0].shotId = 'one';
  assert.throws(() => parseStoryboard(o), StoryboardParseError);
  const o2 = good(); o2.sheets[0].panels = Array.from({ length: 9 }, () => o2.sheets[0].panels[0]);
  assert.throws(() => parseStoryboard(o2), StoryboardParseError);
  assert.throws(() => parseStoryboard('{nope'), StoryboardParseError);
});
test('gate: draft passes', () => assert.deepEqual(codes(good()), []));
test('gate: missing / duplicate shot, wrong part, wrong plate, cast mismatch', () => {
  let o = good(); o.sheets[0].panels.pop(); assert.ok(codes(o).includes('SB_SHOT_MISSING'));
  o = good(); o.sheets[0].panels[1] = { ...o.sheets[0].panels[0], panelNumber: 2 }; assert.ok(codes(o).includes('SB_SHOT_DUPLICATE'));
  o = good(); o.sheets[1].panels[0].locationTag = '@Loc 1'; assert.ok(codes(o).includes('SB_LOCATION_MISMATCH'));
  o = good(); o.sheets[0].segmentId = 2; assert.ok(codes(o).includes('SB_WRONG_PART'));
  o = good(); o.sheets[0].panels[0].characters.pop(); assert.ok(codes(o).includes('SB_CAST_MISMATCH'));
  o = good(); o.sheets[0].panels[0].panelNumber = 3; assert.ok(codes(o).includes('SB_PANEL_NUMBER'));
});
test('gate WARDROBE: each character wears their own approved outfit', () => {
  const o = good(); o.sheets[0].panels[0].characters[1].wardrobe = 'yellow raincoat';
  assert.ok(codes(o).includes('SB_WARDROBE_MISMATCH'));
});
test('gate TWINS: two characters in one panel never share an outfit', () => {
  const o = good(); const [a, b] = o.sheets[0].panels[0].characters; b.wardrobe = a.wardrobe;
  assert.ok(codes(o).includes('SB_TWIN_OUTFITS'));
});
test('gate PROP_LEAK: a signature accessory stays on its owner', () => {
  let o = good(); o.sheets[0].panels[0].characters[1].props = ['sunglasses on her forehead']; // Kid's eyewear on the sibling
  assert.ok(codes(o).includes('SB_PROP_LEAK'));
  o = good(); o.sheets[0].panels[1].characters[1].props = ['a navy hijab']; // parent's headwear copied onto the sibling
  assert.ok(codes(o).includes('SB_PROP_LEAK'));
  o = good(); o.sheets[0].panels[0].characters[0].props = ['sunglasses']; // owner may carry it
  assert.ok(!codes(o).includes('SB_PROP_LEAK'));
  o = good(); o.sheets[0].panels[1].characters[1].pose = 'hair loose, no hijab, reaching for the plate'; // stated absence is fine
  assert.ok(!codes(o).includes('SB_PROP_LEAK'));
  assert.deepEqual([...accessoriesIn('without glasses, wearing a cap')], ['cap']);
});
test('compile: one sheet per part, 8-slot layout text, labels, references in attach order', () => {
  const sheets = compileSheets(parseStoryboard(good()), input());
  assert.deepEqual(sheets.map((s) => s.sheetId), ['1', '2']);
  const s = sheets[0];
  assert.deepEqual(s.references.map((r) => [r.position, r.tag]), [[1, '@Kid'], [2, '@Sib'], [3, '@Parent'], [4, '@Loc 1']]);
  assert.ok(s.fullPrompt.includes(SB_SHEET_OPENING) && s.fullPrompt.includes(SB_SHEET_LAYOUT) && s.fullPrompt.includes('16:9'));
  assert.ok(s.fullPrompt.includes(sbPanelLabel(1, '1.1')) && s.fullPrompt.includes('Panel 8 [empty]'));
  assert.ok(s.fullPrompt.includes('Kid (reference image 1)') && s.fullPrompt.includes('(reference image 4)'));
  assert.ok(!/[\r\n]/.test(s.fullPrompt));
  assert.deepEqual(s.panels.map((p) => [p.row, p.col]), [[0, 0], [0, 1]]);
});
test('animatic gate: approve freezes SD timings; rejections route to SD or the Storyboard Artist', async () => {
  const n = makeAnimaticApprovalNode();
  const st = state();
  assert.deepEqual((await n(st)).pendingApproval, ['animatic']);
  const ok = await n({ ...st, animaticApproval: { decision: 'approve' } });
  assert.deepEqual(ok.approvedShotTimings.map((t) => [t.shotId, t.durationSec, t.timelineStartSec]), [['1.1', 4, 0], ['1.2', 3, 4], ['2.1', 5, 7]]);
  assert.equal(animaticRoute({ ...ok, status: 'running' }), 'seedance-compiler');
  const r1 = await n({ ...st, animaticApproval: { decision: 'reject', target: 'story-director', notes: 'shot 1.2 drags' } });
  assert.equal(animaticRoute(r1), 'story-director'); assert.equal(r1.revisionNotes['story-director'], 'shot 1.2 drags');
  const r2 = await n({ ...st, animaticApproval: { decision: 'reject', notes: 'panel 1.1 wrong outfit' } });
  assert.equal(animaticRoute(r2), 'storyboard-artist');
});
