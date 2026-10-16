import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateStoryDirectorOutput, answerAnchors, recipientOf, PLATITUDE } from '../crew/linter/check-stage-play.mjs';

const sd = () => JSON.parse(readFileSync(new URL('../benchmarks/r4-dry6/outputs/story-director.json', import.meta.url), 'utf8'));
const inputs = JSON.parse(readFileSync(new URL('../benchmarks/r4-dry6/inputs.json', import.meta.url), 'utf8'));
const codes = (o, i = inputs) => validateStoryDirectorOutput(o, { ...i, photoCharacters: [] }).issues.map((x) => x.code);
const withMia = (o) => {
  o.cast.push({ ...o.cast.find((c) => c.elementTag === '@Wife'), name: 'Mia', elementTag: '@Mia', realPerson: 'Mia', age: 6, ageNote: 'age not given in the answers; shown as a young child' });
  const last = o.segments.at(-1); last.shots[0].whatWeSee = '@DadShaz sits beside @Mia; @Mia listens';
  return o;
};
const setLast = (o, line) => { const s = o.segments.at(-1).shots.at(-1); s.narration = { ...s.narration, line }; return o; };

test('r4-dry6 finale fails both new rules', { timeout: 10000 }, () => {
  const c = codes(sd());
  assert.ok(c.includes('RECIPIENT_NOT_IN_FINALE')); assert.ok(c.includes('GENERIC_FINAL_LINE'));
});
test('Mia on screen in the finale + a specific last line passes both', { timeout: 10000 }, () => {
  const c = codes(setLast(withMia(sd()), '{Think about the good things, Mia. Like Mama, every week at eight.}'));
  assert.ok(!c.includes('RECIPIENT_NOT_IN_FINALE')); assert.ok(!c.includes('GENERIC_FINAL_LINE'));
});
test('platitudes fail even with an anchor', { timeout: 10000 }, () => {
  assert.ok(codes(setLast(withMia(sd()), '{Men and women differ.}')).includes('GENERIC_FINAL_LINE'));
  assert.ok(codes(setLast(withMia(sd()), '{Life is messy, like Yugioh.}')).includes('GENERIC_FINAL_LINE'));
  assert.ok(PLATITUDE.test('Men and women are different'));
});
test('recipient name alone is not an anchor; no answers or no recipient skips the rules', { timeout: 10000 }, () => {
  assert.ok(codes(setLast(withMia(sd()), '{I love you, Mia.}')).includes('GENERIC_FINAL_LINE'));
  const c = codes(sd(), { subject: 'Shaz' });
  assert.ok(!c.includes('RECIPIENT_NOT_IN_FINALE')); assert.ok(!c.includes('GENERIC_FINAL_LINE'));
  assert.equal(recipientOf('Shaz, story for Mia, (parent)'), 'Mia');
  assert.ok(answerAnchors(inputs.answers).has('yugioh'));
});

test('a last line copied from a role-file example fails GENERIC_FINAL_LINE (copy)', { timeout: 10000 }, async () => {
  const { roleExampleLines } = await import('../crew/linter/check-stage-play.mjs');
  const ex = roleExampleLines(); assert.ok(ex.length > 5);
  assert.ok(!ex.some((x) => /Like Mama, every week at eight/.test(x)), 'old copied sample removed from the role');
  const r = validateStoryDirectorOutput(setLast(withMia(sd()), "{I don't have to ask anymore.}"), { ...inputs, photoCharacters: [] });
  assert.ok(r.issues.some((i) => i.code === 'GENERIC_FINAL_LINE' && /copies an example/.test(i.message)));
});
test('FINALE_PLATITUDE covers every finale line, not just the last', { timeout: 10000 }, () => {
  const o = setLast(withMia(sd()), '{Think about the good things, Mia. Like Mama, every week at eight.}');
  o.segments.at(-1).shots[1].narration = { speaker: '@DadShaz', line: '{Men and women are different. Do not let the world convince you.}' };
  const iss = validateStoryDirectorOutput(o, { ...inputs, photoCharacters: [] }).issues.filter((i) => i.code === 'FINALE_PLATITUDE');
  assert.equal(iss.length, 1); assert.match(iss[0].path, /shots\.1\.narration/);
  const r8 = JSON.parse(readFileSync(new URL('../benchmarks/r4-dry8/outputs/story-director.json', import.meta.url), 'utf8'));
  assert.ok(codes(r8).includes('FINALE_PLATITUDE'));
});
test('Seedance Compiler and Story Director: 64k output budget at xhigh', { timeout: 10000 }, async () => {
  const { V2_MODELS } = await import('../config/models.mjs');
  for (const a of ['story-director', 'seedance-compiler']) { assert.equal(V2_MODELS[a].maxTokens, 64000); assert.equal(V2_MODELS[a].effort, 'xhigh'); }
});
