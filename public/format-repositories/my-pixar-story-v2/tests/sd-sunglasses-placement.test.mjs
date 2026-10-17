// r4-dry14 SD attempt 3: "sunglasses pushed up" next to @Shaz in a shot failed REDESCRIBED_CHARACTER while role.md said
// to mention them everywhere. Rule: sunglasses only in cast cards + storyboard panels, never in shot text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateStoryDirectorOutput } from '../crew/linter/check-stage-play.mjs';
import { WORDS_PER_SECOND, MAX_LINE_WORDS } from '../crew/linter/speech.mjs';

const role = readFileSync(new URL('../crew/story-director/role.md', import.meta.url), 'utf8');
const good = () => JSON.parse(readFileSync(new URL('./fixtures/good-stage-play.json', import.meta.url)));
const codes = (d) => validateStoryDirectorOutput(d).issues.filter((i) => i.severity === 'error').map((i) => i.code);

test('role.md: sunglasses only in cast cards and storyboard panels, never in shot text', () => {
  assert.match(role, /sunglasses live ONLY in the cast cards and the storyboard panel lines/);
  assert.match(role, /never mentions sunglasses/);
  assert.doesNotMatch(role, /sunglasses are pushed up on his forehead everywhere/);
  assert.doesNotMatch(role, /pushes his sunglasses/);
});
test('shot with "sunglasses pushed up" next to @Shaz still fails REDESCRIBED_CHARACTER', () => {
  const d = good(); d.segments[0].shots[0].whatWeSee = '@Shaz, red plastic sunglasses pushed up, slaps a card down across the kitchen table from @Sister.';
  assert.ok(codes(d).includes('REDESCRIBED_CHARACTER'));
});
test('storyboard panel with "sunglasses pushed up on his forehead" passes', () => {
  const d = good(); d.storyboardSheets[0].panels[0].whatIsInFrame = '@Shaz, red plastic sunglasses pushed up on his forehead, slaps a card down at the table';
  const c = codes(d);
  assert.ok(!c.includes('REDESCRIBED_CHARACTER') && !c.includes('SUNGLASSES_OVER_EYES'), c.join(','));
});
test('role.md states the same speech budget the DIALOGUE_TIMING_BUDGET gate uses', () => {
  assert.equal(WORDS_PER_SECOND, 3); assert.equal(MAX_LINE_WORDS, 18);
  assert.match(role, new RegExp(`${WORDS_PER_SECOND} words per second`));
  assert.match(role, new RegExp(`ceil\\(words / ${WORDS_PER_SECOND}\\)`));
  assert.match(role, new RegExp(`longer than ${MAX_LINE_WORDS} words must be split`));
});
