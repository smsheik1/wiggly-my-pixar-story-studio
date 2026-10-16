// One storyboard sheet per part (max 8 panels); every shot drawn exactly once, in order, with real part/shot labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateStoryDirectorOutput, sheetLayout } from '../crew/linter/check-stage-play.mjs';
import { StoryDirectorOutputSchema, storyboardSheetsOf } from '../crew/story-director/schema.mjs';

const good = () => JSON.parse(readFileSync(new URL('./fixtures/good-stage-play.json', import.meta.url), 'utf8'));
const codes = (d) => validateStoryDirectorOutput(d).issues.filter((i) => i.severity === 'error').map((i) => i.code);
const SB = /^(STORYBOARD|NO_STORYBOARD)/;
const sbCodes = (d) => codes(d).filter((c) => SB.test(c));
// Build a valid sheet for `shots` of part `seg`, cloning panel content from the fixture.
const sheet = (d, seg, nums) => {
  const tpl = d.storyboardSheets[0].panels[0]; const { countWord, layout } = sheetLayout(nums.length);
  const panels = nums.map((n, i) => ({ ...tpl, panelNumber: i + 1, shotNumberRef: n }));
  return { segmentId: seg, targetEngine: 'nano-banana-2.1', panels,
    fullPrompt: `A ${countWord} colour storyboard sheet arranged in ${layout} on a warm off-white page, polished 3D Pixar-style render. ` +
      panels.map((p) => `Panel ${p.panelNumber} [Part ${seg}, shot ${p.shotNumberRef}]: ${p.shotSizeAndAngle}. ${p.whatIsInFrame}.`).join(' ') };
};

test('fixture: one sheet per part covers every shot once and passes', () => {
  const d = good();
  assert.deepEqual(d.storyboardSheets.map((s) => [s.segmentId, s.panels.map((p) => p.shotNumberRef)]), [[1, [1, 2, 3, 4, 5, 6]], [2, [1, 2, 3]]]);
  assert.deepEqual(sbCodes(d), []);
  assert.equal(StoryDirectorOutputSchema.safeParse(d).success, true);
});
test('missing shot -> STORYBOARD_SHOT_MISSING (names the part and shot)', () => {
  const d = good(); d.storyboardSheets[1] = sheet(d, 2, [1, 2]);
  assert.ok(sbCodes(d).includes('STORYBOARD_SHOT_MISSING'));
  assert.match(validateStoryDirectorOutput(d).issues.find((i) => i.code === 'STORYBOARD_SHOT_MISSING').message, /Part 2 shot 3/);
});
test('duplicate shot -> STORYBOARD_DUPLICATE_SHOT', () => {
  const d = good(); d.storyboardSheets[1] = sheet(d, 2, [1, 2, 3, 3]);
  assert.ok(sbCodes(d).includes('STORYBOARD_DUPLICATE_SHOT'));
});
test('a shot that does not exist (or wrong part) -> STORYBOARD_UNKNOWN_SHOT', () => {
  const d = good(); d.storyboardSheets[1] = sheet(d, 2, [1, 2, 3, 4]);
  assert.ok(sbCodes(d).includes('STORYBOARD_UNKNOWN_SHOT'));
});
test('over 8 panels -> STORYBOARD_PANEL_COUNT and schema rejects; a 9+ shot part splits 8 + rest and passes', () => {
  const d = good(); const shots = d.segments[0].shots;
  // Make part 1 eleven 2-second shots.
  d.segments[0].shots = Array.from({ length: 11 }, (_, i) => ({ ...shots[i % shots.length], shotNumber: i + 1, startSec: i * 2, endSec: i * 2 + 2, dialogue: undefined, narration: undefined }));
  d.segments[0].targetDurationSec = 22;
  const nums = d.segments[0].shots.map((s) => s.shotNumber);
  const big = good(); big.segments = d.segments; big.storyboardSheets = [sheet(d, 1, nums), d.storyboardSheets[1]];
  assert.ok(sbCodes(big).includes('STORYBOARD_PANEL_COUNT'));
  assert.equal(StoryDirectorOutputSchema.safeParse(big).success, false);
  d.storyboardSheets = [sheet(d, 1, nums.slice(0, 8)), sheet(d, 1, nums.slice(8)), d.storyboardSheets[1]];
  assert.deepEqual(sbCodes(d), []);
});
test('out of order -> STORYBOARD_SHOT_ORDER', () => {
  const d = good(); d.storyboardSheets.reverse();
  assert.ok(sbCodes(d).includes('STORYBOARD_SHOT_ORDER'));
});
test('labels must use the real part/shot numbers; sheet text must state its size and layout', () => {
  let d = good(); d.storyboardSheets[1].fullPrompt = d.storyboardSheets[1].fullPrompt.replace('[Part 2, shot 3]', '[shot 9]');
  assert.ok(sbCodes(d).includes('STORYBOARD_PANEL_LABEL'));
  d = good(); d.storyboardSheets[1].fullPrompt = d.storyboardSheets[1].fullPrompt.replace('three-panel', 'eight-panel');
  assert.ok(sbCodes(d).includes('STORYBOARD_SHEET_SIZE_TEXT'));
  d = good(); d.storyboardSheets[1].fullPrompt += ' Panel 4 [Part 2, shot 4]: empty slot.';
  assert.ok(sbCodes(d).includes('STORYBOARD_PANEL_LABEL'));
  d = good(); d.storyboardSheets[0].panels[1].panelNumber = 5;
  assert.ok(sbCodes(d).includes('STORYBOARD_PANEL_NUMBERING'));
});
test('layout wording: 8 two even rows, 5-7 two rows, <=4 one row', () => {
  assert.deepEqual(sheetLayout(8), { countWord: 'eight-panel', layout: 'two even rows of four panels' });
  assert.equal(sheetLayout(6).layout, 'two rows, four panels on the top row and two on the bottom row');
  assert.equal(sheetLayout(3).layout, 'a single row of three panels');
  assert.equal(sheetLayout(1).layout, 'a single panel');
});
test('old single-sheet storyboardPrompt outputs are still readable', () => {
  const d = good(); const old = d.storyboardSheets[0]; delete d.storyboardSheets; d.storyboardPrompt = { targetEngine: old.targetEngine, fullPrompt: old.fullPrompt, panels: old.panels };
  assert.deepEqual(storyboardSheetsOf(d).map((s) => s.segmentId), [1]);
  assert.ok(sbCodes(d).includes('STORYBOARD_SHOT_MISSING'), 'old 8-panel boards miss the later parts');
});
