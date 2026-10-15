import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStagePlay, StagePlayParseError } from '../crew/story-director/schema.mjs';
import { lintStagePlay, lineBudget } from '../crew/linter/check-stage-play.mjs';

const good = () => JSON.parse(readFileSync(new URL('./fixtures/good-stage-play.json', import.meta.url), 'utf8'));
const lintWith = (fn) => { const d = good(); fn(d); return lintStagePlay(d); };
const has = (errs, re) => assert.ok(errs.some(e => re.test(e)), `expected ${re} in:\n${errs.join('\n')}`);

test('good fixture parses and passes the gate', () => {
  assert.doesNotThrow(() => parseStagePlay(good()));
  assert.deepEqual(lintStagePlay(good()), []);
});
test('parse: invalid JSON string throws StagePlayParseError', () => {
  assert.throws(() => parseStagePlay('{nope'), StagePlayParseError);
});
test('parse: missing deckHtml / extra key / bad dialogue format throw with paths', () => {
  const a = good(); delete a.deckHtml;
  assert.throws(() => parseStagePlay(a), e => e instanceof StagePlayParseError && /deckHtml/.test(e.message));
  const b = good(); b.extra = 1;
  assert.throws(() => parseStagePlay(b), StagePlayParseError);
  const c = good(); c.beats[0].dialogue[0].line = 'Shaz: I am a scientist.';
  assert.throws(() => parseStagePlay(c), /@speaker-id/);
});
test('parse: fractional timecode and >30s segment rejected', () => {
  const a = good(); a.beats[0].shots[0].end = 4.5;
  assert.throws(() => parseStagePlay(a), /whole second/);
  const b = good(); b.beats[0].durationSeconds = 31;
  assert.throws(() => parseStagePlay(b), /30 s/);
});
test('gate: part over 30s across beats', () => has(lintWith(d => { d.beats[1].durationSeconds = 16; d.beats[1].shots[1].end = 16; }), /part 1: 31s/));
test('gate: total over 90s', () => has(lintWith(d => {
  for (let i = 0; i < 3; i++) { const b = structuredClone(d.beats[1]); b.beat = 3 + i; b.part = 2 + i; b.durationSeconds = 30; b.shots[1].end = 30;
    b.shots.forEach(s => s.id = `x${i}${s.id}`); b.dialogue[0].shotId = `x${i}b2s1`; d.beats.push(b); } }), /film \d+s > 90s/));
test('gate: gap and overlap', () => {
  has(lintWith(d => { d.beats[0].shots[1].start = 6; }), /gap/);
  has(lintWith(d => { d.beats[0].shots[1].start = 4; }), /overlap/);
});
test('gate: shot under 2s', () => has(lintWith(d => { d.beats[0].shots[0].end = 1; d.beats[0].shots[1].start = 1; }), /< 2s/));
test('gate: timing budget', () => {
  assert.equal(lineBudget(6), 2); assert.equal(lineBudget(7), 3); assert.equal(lineBudget(18), 4); assert.equal(lineBudget(19), null);
  has(lintWith(d => { d.beats[0].dialogue[0].line = '@shaz-child: {I am a scientist and nobody in this house can stop me}'; }), /budget 3s/);
  has(lintWith(d => { d.beats[0].dialogue[0].seconds = 6; }), /6s of dialogue in a 5s shot/);
});
test('gate: tag parity both directions', () => {
  has(lintWith(d => { d.beats[0].dialogue[0].line = '@dad: {Hi.}'; }), /@dad not in cast/);
  has(lintWith(d => { d.beats[0].shots[0].characterIds.push('ghost'); }), /unknown cast id ghost/);
  has(lintWith(d => { d.cast.push({ ...d.cast[0], id: 'uncle', name: 'Uncle' }); }), /cast uncle: never appears/);
  has(lintWith(d => { d.beats[1].dialogue[0].shotId = 'b2s2'; }), /@mom speaks but is not in frame/);
});
test('gate: hijab on female family cast', () => {
  has(lintWith(d => { d.cast[1].look = 'kind woman, long modest dress'; }), /without hijab/);
  has(lintWith(d => { d.cast[1].look = 'kind woman in a hijab with bangs showing'; }), /hair/);
  assert.deepEqual(lintWith(d => { d.cast[1].family = false; d.cast[1].look = 'neighbour in a long coat'; }), []);
});
test('gate: no teen shown under 18', () => {
  has(lintWith(d => { d.cast[2].ageVariant = '16'; }), /teen shown as 16/);
  has(lintWith(d => { d.cast[2].minor = true; }), /minor=true but age 18/);
});
test('gate: single-line Nano Banana storyboard prompt, no banned jargon', () => {
  has(lintWith(d => { d.storyboardPrompt += '\nPanel 3: ...'; }), /single line/);
  has(lintWith(d => { d.storyboardPrompt = 'GPT Image 2 eight-panel colour storyboard sheet'; }), /GPT Image/);
  has(lintWith(d => { d.beats[0].shots[0].action += ', photorealistic'; }), /banned jargon/);
});
