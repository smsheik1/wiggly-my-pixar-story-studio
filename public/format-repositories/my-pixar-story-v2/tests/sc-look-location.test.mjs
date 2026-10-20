import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeItems, dedupeLookLines } from '../crew/seedance-compiler/look-dedupe.mjs';
import { withAssembledPrompts } from '../crew/seedance-compiler/schema.mjs';
import { lockPhrases } from '../crew/linter/shot-locks.mjs';
import { validateSeedancePrompts, shotBlocks } from '../crew/linter/check-seedance-prompts.mjs';

test('dedupeItems: drops an item equal to or contained in another (case-insensitive), keeps the longer, keeps order', () => {
  assert.deepEqual(dedupeItems(['sunglasses pushed up on the forehead', 'Sunglasses pushed up on the forehead']), ['sunglasses pushed up on the forehead']);
  assert.deepEqual(dedupeItems(['mustard yellow cardigan', 'mustard yellow cardigan in soft knit']), ['mustard yellow cardigan in soft knit']);
  assert.deepEqual(dedupeItems(['wears a hijab', 'sage green hijab', 'royal cobalt blue t-shirt with short sleeves', 'royal cobalt blue t-shirt']),
    ['wears a hijab', 'sage green hijab', 'royal cobalt blue t-shirt with short sleeves']);
});
test('dedupeLookLines rewrites Look lines only', () => {
  const t = 'SHOT 1 | 0–4s\nCamera: wide.\nLook @Shaz: sunglasses pushed up on the forehead; sunglasses pushed up on the forehead; royal cobalt blue t-shirt; royal cobalt blue t-shirt with short sleeves.\nProps: a; a.\nHard cut.';
  assert.equal(dedupeLookLines(t), 'SHOT 1 | 0–4s\nCamera: wide.\nLook @Shaz: sunglasses pushed up on the forehead; royal cobalt blue t-shirt with short sleeves.\nProps: a; a.\nHard cut.');
  const s = withAssembledPrompts({ segments: [{ tenBlocks: { block5_shots: t } }] }).segments[0];
  assert.ok(s.compiledPrompt.includes('Look @Shaz: sunglasses pushed up on the forehead; royal cobalt blue t-shirt with short sleeves.'));
  assert.equal(s.tenBlocks.block5_shots, dedupeLookLines(t));
});
test('lockPhrases: a visual tell repeating an accessory is locked once', () => {
  const ph = lockPhrases({ signatureAccessories: ['sunglasses pushed up on the forehead'] }, { visualTell: 'Sunglasses pushed up on the forehead' });
  assert.equal(ph.length, 1);
  assert.equal(lockPhrases({ signatureAccessories: ['sunglasses'] }, { visualTell: 'sunglasses pushed up on the forehead' }).map((x) => x.text).join('|'), 'sunglasses pushed up on the forehead');
});

const shots5 = 'SHOT 1 | 0–4s\nCamera: medium, eye level, static.\nLocation: @dallas_apartment_room.\nOn screen: @AdultShaz.\n@AdultShaz types.\nHard cut.\n\nSHOT 2 | 4–8s\nCamera: medium, eye level, static.\nLocation: @chicago_apartment_room.\nOn screen: @Wife.\n@Wife waves.\nHard cut.';
const sc = { input: { targetEngine: 'seedance-2.0-mini', segments: [] }, output: { totalRuntimeSec: 8, assumptions: [], segments: [{ segmentId: 3, segmentIndex: 1, extendsFrom: null, totalDurationSec: 8,
  references: [{ tag: '@AdultShaz', kind: 'character' }, { tag: '@Wife', kind: 'character' }, { tag: '@dallas_apartment_room', kind: 'location' }, { tag: '@chicago_apartment_room', kind: 'location' }],
  shots: [{ shotNumber: 1, startSec: 0, endSec: 4, cast: ['@AdultShaz'], locationTag: '@dallas_apartment_room' }, { shotNumber: 2, startSec: 4, endSec: 8, cast: ['@Wife'], locationTag: '@chicago_apartment_room' }],
  tenBlocks: { block5_shots: shots5 } }] } };
const locCodes = (d) => validateSeedancePrompts(d, sc.input).issues.filter((i) => i.code === 'SHOT_LOCATION_MISSING');
test('SHOT_LOCATION_MISSING: multi-location clip needs a Location line naming each shot\'s own place', () => {
  const ok = withAssembledPrompts(structuredClone(sc.output));
  assert.equal(locCodes(ok).length, 0);
  const bad = structuredClone(sc.output); bad.segments[0].tenBlocks.block5_shots = bad.segments[0].tenBlocks.block5_shots.replace(/^Location: .*\n/m, '');
  assert.equal(locCodes(withAssembledPrompts(bad)).length, 1);
  const wrong = structuredClone(sc.output); const b5 = wrong.segments[0].tenBlocks;
  b5.block5_shots = b5.block5_shots.replace('Location: @chicago_apartment_room.', 'Location: @dallas_apartment_room.');
  assert.equal(locCodes(withAssembledPrompts(wrong)).length, 1);
  const one = structuredClone(sc.output); one.segments[0].references = one.segments[0].references.filter((r) => r.tag !== '@chicago_apartment_room');
  one.segments[0].tenBlocks.block5_shots = one.segments[0].tenBlocks.block5_shots.replace(/^Location: .*\n/gm, '');
  assert.equal(locCodes(withAssembledPrompts(one)).length, 0);
});
