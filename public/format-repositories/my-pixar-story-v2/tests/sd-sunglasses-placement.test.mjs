// r4-dry14 SD attempt 3: a signature accessory ("sunglasses pushed up" in the test family's data) next to the @tag in a shot
// failed REDESCRIBED_CHARACTER while role.md said to mention it everywhere. Generic rule: a character's signature accessory lives
// only in cast cards + storyboard panels, never in shot text. The fixture's family data keeps its sunglasses as input data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateStoryDirectorOutput } from '../crew/linter/check-stage-play.mjs';
import { WORDS_PER_SECOND, MAX_LINE_WORDS, SPEECH_PAD_SEC } from '../crew/linter/speech.mjs';

const role = readFileSync(new URL('../crew/story-director/role.md', import.meta.url), 'utf8');
const good = () => JSON.parse(readFileSync(new URL('./fixtures/good-stage-play.json', import.meta.url)));
const codes = (d) => validateStoryDirectorOutput(d).issues.filter((i) => i.severity === 'error').map((i) => i.code);

test('role.md: signature accessories only in cast cards and storyboard panels, never in shot text; eyes visible', () => {
  assert.match(role, /Accessories live ONLY in the cast cards and the storyboard panel lines/);
  assert.match(role, /never mentions the accessory/);
  assert.match(role, /so it never drops out between shots/);
  assert.match(role, /eyes are always visible/);
});
test('shot with "sunglasses pushed up" next to @Shaz still fails REDESCRIBED_CHARACTER', () => {
  const d = good(); d.segments[0].shots[0].whatWeSee = '@Shaz, red plastic sunglasses pushed up, slaps a card down across the kitchen table from @Sister.';
  assert.ok(codes(d).includes('REDESCRIBED_CHARACTER'));
});
test('storyboard panel with "sunglasses pushed up on his forehead" passes', () => {
  const d = good(); d.storyboardSheets[0].panels[0].whatIsInFrame = '@Shaz, red plastic sunglasses pushed up on his forehead, slaps a card down at the table';
  const c = codes(d);
  assert.ok(!c.includes('REDESCRIBED_CHARACTER') && !c.includes('EYES_HIDDEN'), c.join(','));
});
test('role.md states the same speech budget the DIALOGUE_TIMING_BUDGET gate uses', () => {
  assert.equal(WORDS_PER_SECOND, 3); assert.equal(MAX_LINE_WORDS, 18);
  assert.match(role, new RegExp(`${WORDS_PER_SECOND} words per second`));
  assert.match(role, new RegExp(`ceil\\(words / ${WORDS_PER_SECOND} \\+ ${SPEECH_PAD_SEC}\\)`));
  assert.match(role, new RegExp(`longer than ${MAX_LINE_WORDS} words must be split`));
});
