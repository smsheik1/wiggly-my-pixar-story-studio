import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTells, checkWritingTells, doNotWriteList, storyDirectorTexts, seedanceTexts, tellsScore, TELLS_FILE } from '../crew/linter/writing-tells.mjs';
import { loadSkill } from '../config/models.mjs';

const codes = (iss) => iss.map((i) => `${i.severity}:${i.code}`);
const L = (text, finale = false) => ({ text, path: 'x', finale });

test('rubric file has a parseable JSON block with hard and warn lists', () => {
  const t = loadTells();
  assert.equal(t.emDash, '\u2014');
  assert.ok(t.phrases.length >= 10 && t.forcedNegation.length >= 3 && t.words.length >= 10);
  const md = readFileSync(TELLS_FILE, 'utf8');
  for (const s of ['0–5', '51+', 'SCORE:', 'Characters announcing their feelings', 'Kid dialogue that sounds written']) assert.ok(md.includes(s), s);
});
test('hard fails: em dash, forced negation, banned phrase in spoken lines', () => {
  assert.deepEqual(codes(checkWritingTells({ lines: [L('I waited \u2014 and waited.')] })), ['error:WRITING_TELL_EM_DASH']);
  assert.deepEqual(codes(checkWritingTells({ lines: [L("It's not a setback, it's a setup.")] })), ['error:WRITING_TELL_FORCED_NEGATION']);
  assert.deepEqual(codes(checkWritingTells({ lines: [L('At the end of the day, we had fun.')] })), ['error:WRITING_TELL_BANNED_PHRASE']);
});
test('clean real lines pass silently', () => {
  assert.deepEqual(checkWritingTells({ lines: [L('Pause it! My turn to battle!'), L("I'll go first, okay?"), L('We watched GX together, every afternoon.')], directions: [{ text: 'Shaz slaps a card down on the rug.' }] }), []);
});
test('warnings: flagged word, wisdom stack (3+ in finale), filler directions, no contractions, prompt em dash', () => {
  const stack = ['Disney made it look simple, but the world turned out messier.', 'Good people can still make bad choices.', 'You turn into what you think about, so notice the good.'].map((s) => L(s, true));
  assert.deepEqual(codes(checkWritingTells({ lines: stack })), ['warning:WRITING_TELL_WISDOM_STACK']);
  assert.deepEqual(codes(checkWritingTells({ lines: stack.slice(0, 2) })), []);
  assert.deepEqual(codes(checkWritingTells({ lines: [L('Our journey began.')] })), ['warning:WRITING_TELL_FLAGGED_WORD']);
  assert.deepEqual(codes(checkWritingTells({ lines: [L('I am here.'), L('It is late.'), L('I will stay.')] })), ['warning:WRITING_TELL_NO_CONTRACTIONS']);
  assert.deepEqual(codes(checkWritingTells({ directions: [{ text: 'Mia sits, breathing, blinking.' }] })), ['warning:WRITING_TELL_FILLER_DIRECTION']);
  assert.deepEqual(codes(checkWritingTells({ prose: [{ text: 'Warm light \u2014 soft.' }] })), ['warning:WRITING_TELL_EM_DASH_PROMPT']);
  assert.equal(tellsScore([{ severity: 'error', code: 'A' }, { severity: 'warning', code: 'B' }]).score, 5);
});
test('extractors: finale = last segment; seedance brace lines are speech', () => {
  const sd = { segments: [{ shots: [{ dialogue: { line: '{Hi}' }, whatWeSee: 'a' }] }, { shots: [{ narration: { line: '{Bye}' }, whatWeSee: 'b' }] }] };
  const t = storyDirectorTexts(sd);
  assert.deepEqual(t.lines.map((l) => [l.text, l.finale]), [['{Hi}', false], ['{Bye}', true]]);
  const sc = seedanceTexts({ segments: [{ compiledPrompt: 'Shot 1 \u2014 kitchen. @Shaz says: {Hi there}', shots: [{ action: 'x' }] }] });
  assert.deepEqual(sc.lines.map((l) => l.text), ['Hi there']);
  assert.ok(!sc.prose[0].text.includes('Hi there'));
});
test('Story Director and Seedance Compiler skills carry the do-not-write list; others do not', () => {
  const list = doNotWriteList();
  assert.match(list, /No em dashes/);
  assert.ok(loadSkill('story-director').includes('Writing tells: do not write'));
  assert.ok(loadSkill('seedance-compiler').includes('Writing tells: do not write'));
  assert.ok(!loadSkill('location-scout').includes('Writing tells: do not write'));
});
