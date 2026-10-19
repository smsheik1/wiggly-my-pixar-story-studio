import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateStoryDirectorOutput, recipientOf, FINALE_MIN_NARRATION_SEC } from '../crew/linter/check-stage-play.mjs';
import { StoryDirectorOutputSchema } from '../crew/story-director/schema.mjs';
import { budgetMessage } from '../crew/linter/speech.mjs';
import { checkWritingTells, doNotWriteList } from '../crew/linter/writing-tells.mjs';

const sd = () => JSON.parse(readFileSync(new URL('../benchmarks/r4-dry6/outputs/story-director.json', import.meta.url), 'utf8'));
const inputs = JSON.parse(readFileSync(new URL('../benchmarks/r4-dry6/inputs.json', import.meta.url), 'utf8'));
const codes = (o, i = inputs) => validateStoryDirectorOutput(o, { ...i, photoCharacters: [] }).issues.map((x) => x.code);
const THESIS = 'The closing idea, in one plain sentence from the answers.';
const withMia = (o) => {
  o.finaleThesis = THESIS;
  o.cast.push({ ...o.cast.find((c) => c.elementTag === '@Wife'), name: 'Mia', elementTag: '@Mia', realPerson: 'Mia', age: 6, ageNote: 'age not given in the answers; shown as a young child' });
  const last = o.segments.at(-1); last.shots[0].whatWeSee = '@DadShaz sits beside @Mia; @Mia listens';
  return o;
};
const setLast = (o, line) => { const s = o.segments.at(-1).shots.at(-1); s.narration = { ...s.narration, line }; return o; };

test('r4-dry6 finale: recipient missing and no finaleThesis; no concrete-detail rule any more', { timeout: 10000 }, () => {
  const c = codes(sd());
  assert.ok(c.includes('RECIPIENT_NOT_IN_FINALE')); assert.ok(c.includes('MISSING_FINALE_THESIS'));
});
test('a plain full sentence with no named object, place or time is a valid last line', { timeout: 10000 }, () => {
  for (const line of ['{I love you, Mia.}', '{You become what you think about, so think about good things.}', '{Be patient with people who love you differently.}']) {
    const c = codes(setLast(withMia(sd()), line));
    assert.ok(!c.includes('GENERIC_FINAL_LINE'), line); assert.ok(!c.includes('RECIPIENT_NOT_IN_FINALE')); assert.ok(!c.includes('MISSING_FINALE_THESIS'));
  }
  assert.equal(recipientOf('Shaz, story for Mia, (parent)'), 'Mia');
});
test('finaleThesis must exist and be non-empty (gate + schema)', { timeout: 10000 }, () => {
  const o = setLast(withMia(sd()), '{I love you, Mia.}');
  o.finaleThesis = '   '; assert.ok(codes(o).includes('MISSING_FINALE_THESIS'));
  delete o.finaleThesis; assert.ok(codes(o).includes('MISSING_FINALE_THESIS'));
  const fx = JSON.parse(readFileSync(new URL('./fixtures/good-stage-play.json', import.meta.url), 'utf8'));
  assert.equal(StoryDirectorOutputSchema.safeParse(fx).success, true);
  assert.equal(StoryDirectorOutputSchema.parse(fx).finaleThesis, fx.finaleThesis, 'finaleThesis survives parsing (not stripped)');
  delete fx.finaleThesis; assert.equal(StoryDirectorOutputSchema.safeParse(fx).success, false);
  assert.equal(StoryDirectorOutputSchema.safeParse({ ...fx, finaleThesis: ' ' }).success, false);
});
test('a last line copied from a role-file example still fails GENERIC_FINAL_LINE (copy)', { timeout: 10000 }, async () => {
  const { roleExampleLines } = await import('../crew/linter/check-stage-play.mjs');
  const ex = roleExampleLines(); assert.ok(ex.length > 5);
  const r = validateStoryDirectorOutput(setLast(withMia(sd()), "{I don't have to ask anymore.}"), { ...inputs, photoCharacters: [] });
  assert.ok(r.issues.some((i) => i.code === 'GENERIC_FINAL_LINE' && /copies an example/.test(i.message)));
});
test('FINALE_PLATITUDE covers every finale line, not just the last (invented generalisations)', { timeout: 10000 }, () => {
  const o = setLast(withMia(sd()), '{I love you, Mia.}');
  o.segments.at(-1).shots[1].narration = { speaker: '@DadShaz', line: '{Life is short and love is all that matters.}' };
  const iss = validateStoryDirectorOutput(o, { ...inputs, photoCharacters: [] }).issues.filter((i) => i.code === 'FINALE_PLATITUDE');
  assert.equal(iss.length, 1); assert.match(iss[0].path, /shots\.1\.narration/);
  // Without the answers to compare against, r4-dry8's generalisation is still flagged.
  const r8 = JSON.parse(readFileSync(new URL('../benchmarks/r4-dry8/outputs/story-director.json', import.meta.url), 'utf8'));
  assert.ok(codes(r8, {}).includes('FINALE_PLATITUDE'));
});
test("FINALE_PLATITUDE exempts a line that quotes the family's own answer word for word or nearly", { timeout: 10000 }, async () => {
  const { quotesAnswer } = await import('../crew/linter/check-stage-play.mjs');
  const answers = { finale: { wish: 'I want her to know that life is messier than the movies. Call me whenever you want.' }, other: ['Family is loud at our house.'] };
  assert.ok(quotesAnswer('{I want her to know that life is messier than the movies.}', answers), 'verbatim');
  assert.ok(quotesAnswer('{Life is messier than the movies.}', answers), 'trimmed filler');
  assert.ok(quotesAnswer('{I want you to know that life is messier than the movies.}', answers), 'near-verbatim (one word changed)');
  assert.ok(quotesAnswer('{Family is loud at our house.}', answers), 'answers nested in arrays');
  assert.ok(!quotesAnswer('{Life is short, so hug the people you love.}', answers), 'invented generalisation');
  assert.ok(!quotesAnswer('{Love is patient.}', answers), 'platitude the family never wrote');
  assert.ok(!quotesAnswer('{Life is messier.}', {}), 'no answers, no exemption');
  // Real r4 data: the maker wrote this generalisation, so the near-verbatim narration line is kept.
  const r8 = JSON.parse(readFileSync(new URL('../benchmarks/r4-dry8/outputs/story-director.json', import.meta.url), 'utf8'));
  assert.ok(!codes(r8).includes('FINALE_PLATITUDE'));
  const o = setLast(withMia(sd()), '{I love you, Mia.}');
  o.segments.at(-1).shots[1].narration = { speaker: '@DadShaz', line: '{Life is messier than the movies.}' };
  assert.ok(!validateStoryDirectorOutput(o, { answers, photoCharacters: [] }).issues.some((i) => i.code === 'FINALE_PLATITUDE'));
  o.segments.at(-1).shots[1].narration.line = '{Life is short, so hug the people you love.}';
  assert.ok(validateStoryDirectorOutput(o, { answers, photoCharacters: [] }).issues.some((i) => i.code === 'FINALE_PLATITUDE'));
});
test('FINALE_TOO_THIN needs 10s of finale narration (was 15)', { timeout: 10000 }, () => {
  assert.equal(FINALE_MIN_NARRATION_SEC, 10);
  const fx = () => JSON.parse(readFileSync(new URL('./fixtures/good-stage-play.json', import.meta.url), 'utf8'));
  const narrSec = (d) => d.segments.at(-1).shots.filter((h) => h.narration).reduce((n, h) => n + h.endSec - h.startSec, 0);
  const keep = (d, secs) => { let n = 0; for (const h of d.segments.at(-1).shots) { if (h.narration && n + h.endSec - h.startSec <= secs) n += h.endSec - h.startSec; else delete h.narration; } return d; };
  const ten = keep(fx(), 10); assert.equal(narrSec(ten), 10); assert.ok(!codes(ten, {}).includes('FINALE_TOO_THIN'));
  const six = keep(fx(), 6); assert.ok(narrSec(six) < 10); assert.ok(codes(six, {}).includes('FINALE_TOO_THIN'));
});
test('the finale rules are generic: no maker-specific details in role rules or checker keywords', { timeout: 10000 }, () => {
  const role = readFileSync(new URL('../crew/story-director/role.md', import.meta.url), 'utf8');
  const rules = role.split('\n').filter((l) => /finale|last line|finaleThesis/i.test(l) && l.startsWith('* **'));
  assert.ok(rules.length >= 2);
  const finaleRules = rules.filter((l) => /ONE idea|last line says/.test(l));
  assert.equal(finaleRules.length, 2);
  for (const l of finaleRules) assert.ok(!/Yugioh|Honda|eight o'clock|8pm|Chicago|Dallas|Disney|sunglasses|Mia|Shaz|maxim/i.test(l), l.slice(0, 80));
  assert.ok(/whole/.test(finaleRules[0]) && /slogan/.test(finaleRules[0]) && /shot that shows it/.test(finaleRules[0]) && /callback/.test(finaleRules[0]));
  assert.ok(role.includes('"finaleThesis"'));
  assert.ok(!/15.20 seconds of narration|one concrete detail/.test(role));
  const checker = readFileSync(new URL('../crew/linter/check-stage-play.mjs', import.meta.url), 'utf8');
  assert.ok(!/facetime|yugioh|honda|answerAnchors|NUM_WORDS/i.test(checker));
});
test('wisdom runs are broken by an on-screen action, never an inserted memory', { timeout: 10000 }, () => {
  const L = (text) => ({ text, path: 'x', finale: true });
  const iss = checkWritingTells({ lines: ['Good people can still make bad choices.', 'You turn into what you think about.', 'Always be kind to people.'].map(L) });
  assert.equal(iss.length, 1); assert.match(iss[0].message, /on-screen action/); assert.match(iss[0].message, /not an inserted memory/);
  const list = doNotWriteList(); assert.match(list, /two wisdom or advice lines in a row in the finale; break a run with an on-screen action/);
  assert.ok(!/put a moment, action or callback/.test(list));
});
test('speech-rate fixes lengthen or split the shot, never shorten the words', { timeout: 10000 }, () => {
  const m = budgetMessage('Segment 2, shot 1 (0s-3s)', 12, 3);
  assert.match(m, /lengthen this shot to 5s/); assert.match(m, /1s lead-in and tail/); assert.match(m, /split the line across two shots/); assert.match(m, /Never shorten or paraphrase/);
  assert.ok(!/cut the line/.test(m));
  const role = readFileSync(new URL('../crew/story-director/role.md', import.meta.url), 'utf8');
  assert.match(role, /Never shorten, paraphrase or compress the family's words to fit a shot length/);
});
test('output budgets at xhigh: Story Director 128k (r5-dry1 hit 64.2k of 64k), CA and SC 64k', { timeout: 10000 }, async () => {
  const { V2_MODELS } = await import('../config/models.mjs');
  assert.equal(V2_MODELS['story-director'].maxTokens, 128000);
  for (const a of ['character-architect', 'seedance-compiler']) assert.equal(V2_MODELS[a].maxTokens, 64000);
  assert.equal(V2_MODELS['story-director'].effort, 'high'); // r5-dry4: xhigh draft calls were cut at ~6 min
  for (const a of ['character-architect', 'seedance-compiler']) assert.equal(V2_MODELS[a].effort, 'xhigh');
});
