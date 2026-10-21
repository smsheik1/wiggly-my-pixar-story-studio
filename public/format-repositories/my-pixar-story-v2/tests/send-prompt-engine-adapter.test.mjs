import test from 'node:test';
import assert from 'node:assert/strict';
import { sendPrompt, panelRefs, spokenAndPlain } from '../crew/seedance-compiler/schema.mjs';

const shots = [[1, 0, 5], [2, 5, 7], [3, 7, 13], [4, 13, 14], [5, 14, 19], [6, 19, 23], [7, 23, 25], [8, 25, 29]].map(([n, a, b]) => ({ shotNumber: n, startSec: a, endSec: b, sceneId: `2.${n}` }));
const seg = {
  references: [{ tag: '@Man', assetKey: 'c1' }, { tag: '@yard', assetKey: 'l1' }, { tag: '@car_inside', assetKey: 'l2' }],
  storyboardPanels: Object.fromEntries(shots.map((s) => [s.sceneId, `p${s.shotNumber}`])), shots,
  compiledPrompt: ['[REFERENCE MATERIALS]', '@Man = man.', '@yard = yard.', '@car_inside = Old coupe interior.', 'Each reference is one person or one object and appears once. No duplicates.', '', '[SHOTS]',
    ...shots.flatMap((s) => [`SHOT ${s.shotNumber} | ${s.startSec}–${s.endSec}s`, 'Camera: medium.', '@Man stands by the coupe watching Yugioh.', '@Man, voiceover: {My Yugioh coupe.}', 'Hard cut.', ''])].join('\n'),
};

test('wan-3.0: refs written "Image N", 10 images max (shortest shot panel dropped, reuses the previous one), quotes kept', () => {
  const pr = panelRefs(seg, 'wan-3.0');
  assert.equal(seg.references.length + pr.length, 10);
  assert.deepEqual(pr.dropped, ['2.4']);
  const { prompt } = sendPrompt(seg, 'wan-3.0');
  assert.match(prompt, /^@Man Image 1 = man\./m);
  assert.doesNotMatch(prompt, /\[Image\d+\]/);
  assert.match(prompt, /SHOT 3 \|[^\n]*\nCamera: medium\.\nComposition from Image 6\./);
  assert.match(prompt, /SHOT 4 \|[^\n]*\nCamera: medium\.\nComposition from Image 6\./);
  assert.match(prompt, /SHOT 8 \|[^\n]*\nCamera: medium\.\nComposition from Image 10\./);
  assert.match(prompt, /Storyboard frames Image 4 to Image 10: in shot order/);
  assert.match(prompt, /voiceover: "My Yu-Gi-Oh coupe\."/);
});

test('seedance-2.5 keeps all panels and [ImageN]', () => {
  assert.equal(panelRefs(seg, 'seedance-2.5').length, 8);
  assert.match(sendPrompt(seg, 'seedance-2.5').prompt, /^@Man \[Image1\] = man\./m);
});

test('spoken spelling for brand names; "two-door coupe" outside spoken lines and tags', () => {
  assert.equal(spokenAndPlain('They watch Yugioh by the faded coupe; @Man: "my coupe, my Yugioh" near @old_coupe_interior.'),
    'They watch Yu-Gi-Oh by the faded two-door coupe; @Man: "my coupe, my Yu-Gi-Oh" near @old_coupe_interior.');
  assert.equal(spokenAndPlain('a two-door coupe'), 'a two-door coupe');
});
