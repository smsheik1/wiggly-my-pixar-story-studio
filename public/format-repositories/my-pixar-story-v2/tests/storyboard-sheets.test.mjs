// One storyboard sheet per part, always 8 panels (two rows of four, unused slots empty); every shot drawn exactly once, in order, labelled "P.S".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateStoryDirectorOutput, panelLabel, emptyPanelLine, SHEET_OPENING, SHEET_LAYOUT } from '../crew/linter/check-stage-play.mjs';
import { StoryDirectorOutputSchema, storyboardSheetsOf } from '../crew/story-director/schema.mjs';

const good = () => JSON.parse(readFileSync(new URL('./fixtures/good-stage-play.json', import.meta.url), 'utf8'));
const codes = (d) => validateStoryDirectorOutput(d).issues.filter((i) => i.severity === 'error').map((i) => i.code);
const SB = /^(STORYBOARD|NO_STORYBOARD)/;
const sbCodes = (d) => codes(d).filter((c) => SB.test(c));
// Build a valid sheet for `shots` of part `seg`, cloning panel content from the fixture.
const sheet = (d, seg, nums) => {
  const tpl = d.storyboardSheets[0].panels[0];
  const panels = nums.map((n, i) => ({ ...tpl, panelNumber: i + 1, shotNumberRef: n }));
  const empties = []; for (let k = panels.length + 1; k <= 8; k++) empties.push(emptyPanelLine(k));
  return { segmentId: seg, targetEngine: 'nano-banana-2.1', panels,
    fullPrompt: `${SHEET_OPENING} arranged in ${SHEET_LAYOUT} on a warm off-white page, polished 3D Pixar-style render. ` +
      panels.map((p) => `${panelLabel(p.panelNumber, seg, p.shotNumberRef)} ${p.shotSizeAndAngle}. ${p.whatIsInFrame}.`).join(' ') + ' ' + empties.join(' ') };
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
test('label format is enforced: exact "P.S" labels, no brackets or codes; sheet says eight-panel two rows of four', () => {
  let d = good(); d.storyboardSheets[1].fullPrompt = d.storyboardSheets[1].fullPrompt.replace('labelled "2.3"', 'labelled "9"');
  assert.ok(sbCodes(d).includes('STORYBOARD_PANEL_LABEL'));
  d = good(); d.storyboardSheets[1].fullPrompt = d.storyboardSheets[1].fullPrompt.replace('Panel 3, labelled "2.3":', 'Panel 3 [Part 2, shot 3]:');
  assert.ok(sbCodes(d).includes('STORYBOARD_PANEL_LABEL'));
  d = good(); d.storyboardSheets[1].fullPrompt += ' Small code P2S3 in the corner.';
  assert.ok(sbCodes(d).includes('STORYBOARD_PANEL_LABEL'));
  d = good(); d.storyboardSheets[1].fullPrompt = d.storyboardSheets[1].fullPrompt.replace('eight-panel', 'three-panel');
  assert.ok(sbCodes(d).includes('STORYBOARD_SHEET_SIZE_TEXT'));
  d = good(); d.storyboardSheets[1].fullPrompt = d.storyboardSheets[1].fullPrompt.replace('two even rows of four panels', 'a single row of three panels');
  assert.ok(sbCodes(d).includes('STORYBOARD_SHEET_SIZE_TEXT'));
  d = good(); d.storyboardSheets[0].panels[1].panelNumber = 5;
  assert.ok(sbCodes(d).includes('STORYBOARD_PANEL_NUMBERING'));
  assert.equal(panelLabel(4, 1, 4), 'Panel 4, labelled "1.4":');
});
test('a 7-shot part gives 8 panel lines with 1 empty slot (no label) and passes', () => {
  const d = good(); const shots = d.segments[0].shots;
  d.segments[0].shots = Array.from({ length: 7 }, (_, i) => ({ ...shots[i % shots.length], shotNumber: i + 1, startSec: i * 2, endSec: i * 2 + 2, dialogue: undefined, narration: undefined }));
  d.segments[0].targetDurationSec = 14;
  d.storyboardSheets[0] = sheet(d, 1, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(sbCodes(d), []);
  const fp = d.storyboardSheets[0].fullPrompt;
  assert.equal([...fp.matchAll(/Panel (\d+)(, labelled "\d+\.\d+":| \[empty\]:)/g)].length, 8);
  assert.equal([...fp.matchAll(/\[empty\]/g)].length, 1);
  assert.ok(fp.includes(emptyPanelLine(8)) && !/Panel 8, labelled/.test(fp));
  assert.equal(d.storyboardSheets[0].panels.length, 7);
  // empty slot missing or not word for word -> STORYBOARD_EMPTY_SLOT
  const bad = structuredClone(d); bad.storyboardSheets[0].fullPrompt = fp.replace(emptyPanelLine(8), 'Panel 8 [empty]: blank.');
  assert.ok(sbCodes(bad).includes('STORYBOARD_EMPTY_SLOT'));
  // a 3-shot sheet (fixture part 2) has 5 empty slots
  assert.equal([...good().storyboardSheets[1].fullPrompt.matchAll(/\[empty\]/g)].length, 5);
});
test('old single-sheet storyboardPrompt outputs are still readable', () => {
  const d = good(); const old = d.storyboardSheets[0]; delete d.storyboardSheets; d.storyboardPrompt = { targetEngine: old.targetEngine, fullPrompt: old.fullPrompt, panels: old.panels };
  assert.deepEqual(storyboardSheetsOf(d).map((s) => s.segmentId), [1]);
  assert.ok(sbCodes(d).includes('STORYBOARD_SHOT_MISSING'), 'old 8-panel boards miss the later parts');
});
