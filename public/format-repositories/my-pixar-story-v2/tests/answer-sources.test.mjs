// Answer tracing (CHANGE 4): every SD line cites the family answer it comes from, the gate checks the citation,
// only people the family names are cast, and the self-review critique gets (and logs) the trace as data.
// Made-up family below (Theo, Gran, Wren); zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { validateStoryDirectorOutput } from '../crew/linter/check-stage-play.mjs';
import { checkAnswerSources, checkExtraCast, resolveAnswer, answerPaths, sameWord, numbersIn, traceLines, traceSummary, traceReport, connectiveCap } from '../crew/linter/answer-sources.mjs';
import { StoryDirectorOutputSchema } from '../crew/story-director/schema.mjs';
import { InputShotSchema } from '../crew/seedance-compiler/input.mjs';
import { deepAgentInvoke, REFLECTION, critiqueMessages, parseUntraceable } from '../graph/deep-agent-node.mjs';
import { AGENT_SPECS } from '../graph/graph.mjs';
import { GOOD_INPUT } from './fixtures/good-answers.mjs';

const good = () => JSON.parse(readFileSync(new URL('./fixtures/good-stage-play.json', import.meta.url), 'utf8'));
const codes = (issues) => issues.map((i) => i.code);
const INPUT = {
  subject: 'Theo, story for Wren, (grandparent)',
  answers: {
    childhood: { memory: 'When I was eight my Gran taught me to fish at Lake Moraine. She said patience is just love that waits.' },
    romance: { memory: 'I met June at the Fransisco bus stop. Every Tuesday at 7pm I phoned her from the hallway.' },
    finale: { memory: 'I want Wren to know she can always call me, any time, about anything.' },
  },
  castDescriptions: [{ id: 'june', name: 'June', description: 'short grey curls, round glasses' }],
};
const CAST = [{ elementTag: '@AdultTheo', name: 'Adult Theo', realPerson: 'Theo' }, { elementTag: '@Gran', name: 'Gran', realPerson: 'Gran' },
  { elementTag: '@June', name: 'June', realPerson: 'June' }, { elementTag: '@Wren', name: 'Wren', realPerson: 'Wren' }];
const sd = (lines, { answerSources = ['childhood.memory'], cast = CAST, see = '@AdultTheo sits by the water' } = {}) => ({ cast, segments: [{ segmentId: 1, answerSources,
  shots: lines.map(([line, answer, kind, field = 'narration'], i) => ({ shotNumber: i + 1, whatWeSee: see, [field]: { speaker: '@AdultTheo', line, ...(kind || answer ? { source: { ...(answer ? { answer } : {}), ...(kind ? { kind } : {}) } } : {}) } })) }] });
const run = (lines, opt) => checkAnswerSources(sd(lines, opt), INPUT);

test('the good fixture traces cleanly against its answers, and the full gate passes', () => {
  const r = validateStoryDirectorOutput(good(), GOOD_INPUT);
  assert.equal(r.isValid, true, r.errors.join('\n'));
  assert.deepEqual(codes(r.issues).filter((c) => /SOURCE|LINE_|CONNECTIVE|CAST_NOT/.test(c)), []);
  assert.ok(traceLines(good(), GOOD_INPUT).every((x) => x.problems.length === 0));
});

test('schema: every line needs a source, every part needs answerSources; connective may omit the answer', () => {
  const d = good();
  delete d.segments[0].shots[1].dialogue.source; delete d.segments[1].answerSources;
  const bad = StoryDirectorOutputSchema.safeParse(d);
  assert.equal(bad.success, false);
  const paths = bad.error.issues.map((i) => i.path.join('.'));
  assert.ok(paths.includes('segments.0.shots.1.dialogue.source')); assert.ok(paths.includes('segments.1.answerSources'));
  const c = good(); c.segments[0].shots[1].dialogue.source = { kind: 'connective' };
  assert.equal(StoryDirectorOutputSchema.safeParse(c).success, true);
  const p = good(); p.segments[0].shots[1].dialogue.source = { kind: 'paraphrase' };
  assert.deepEqual(StoryDirectorOutputSchema.safeParse(p).error.issues.map((i) => i.path.join('.')), ['segments.0.shots.1.dialogue.source.answer']);
});

test('answer ids are key paths into answers; unknown ids and missing sources fail', () => {
  assert.deepEqual(answerPaths(INPUT.answers), ['childhood.memory', 'romance.memory', 'finale.memory']);
  assert.match(resolveAnswer(INPUT.answers, 'answers.childhood.memory'), /Lake Moraine/);
  assert.match(resolveAnswer(INPUT.answers, 'childhood'), /patience/, 'an object resolves to its joined text');
  assert.equal(resolveAnswer(INPUT.answers, 'childhood.nope'), null);
  assert.deepEqual(codes(run([['{Patience is just love that waits.}', 'childhood.memry', 'verbatim']])), ['LINE_SOURCE_UNKNOWN']);
  assert.deepEqual(codes(run([['{Patience is just love that waits.}', null, null]])), ['LINE_SOURCE_MISSING']);
  assert.deepEqual(codes(run([['{Patience is just love that waits.}', null, 'paraphrase']])), ['LINE_SOURCE_MISSING']);
  assert.deepEqual(codes(run([['{Patience is just love that waits.}', 'childhood.memory', 'verbatim']])), []);
});

test('lines are written freely from the answer: rewording passes; no word-overlap check; only lines marked verbatim must quote', () => {
  assert.deepEqual(codes(run([['{She said patience is just love that waits.}', 'childhood.memory']])), []);
  assert.deepEqual(codes(run([['{Gran told me patience means waiting, with love.}', 'childhood.memory']])), [], 'natural rewording is fine');
  const fake = run([['{Gran told me waiting with love is patience.}', 'childhood.memory', 'verbatim']]);
  assert.deepEqual(codes(fake), ['LINE_NOT_VERBATIM'], 'a line marked as the family\'s own words must be near word for word'); assert.equal(fake[0].severity, 'error');
  assert.deepEqual(codes(run([['{Gran told me waiting with love is patience.}', 'childhood.memory', 'paraphrase']])), [], 'paraphrase is never word-checked');
  assert.deepEqual(codes(run([['{We raced go-karts down the hill.}', 'childhood.memory']])), [], 'wording is free: no word-overlap check (facts are checked separately)');
});

test('a detail borrowed from a different answer fails and names the answer it is really in (the "8pm" failure)', () => {
  const r = run([['{Wren, call me Tuesday at seven.}', 'finale.memory', 'paraphrase']], { answerSources: ['finale.memory'] });
  const facts = r.filter((i) => i.code === 'LINE_FACT_NOT_IN_SOURCE');
  assert.equal(facts.length, 2, JSON.stringify(r));
  assert.match(facts[0].message, /'Tuesday'.*romance\.memory/); assert.match(facts[1].message, /'7'.*romance\.memory/);
  // Citing the answer the detail really comes from fixes it.
  assert.deepEqual(codes(run([['{Every Tuesday at seven I phoned her.}', 'romance.memory', 'paraphrase']], { answerSources: ['romance.memory'] })), []);
  // An invented detail is in no answer.
  const inv = run([['{We met at a bakery in Paris.}', 'romance.memory', 'paraphrase']], { answerSources: ['romance.memory'] });
  assert.ok(inv.some((i) => i.code === 'LINE_FACT_NOT_IN_SOURCE' && /'Paris'.*never|not in the answer it cites/.test(i.message)));
});

test('common-sense spelling variants match', () => {
  for (const [a, b] of [['Francisco', 'Fransisco'], ['Tuesdays', 'Tuesday'], ["Gran's", 'Gran'], ['phoned', 'phone'], ['GRAN', 'gran']]) assert.ok(sameWord(a, b), `${a}~${b}`);
  assert.ok(!sameWord('cat', 'car'), 'short words need an exact match');
  assert.deepEqual([...numbersIn('7pm, eight, 20k, 1,500')].sort((x, y) => x - y), [7, 8, 20, 1000, 1500, 20000]);
  assert.deepEqual(codes(run([['{I met June at the Francisco bus stop.}', 'romance.memory', 'verbatim']], { answerSources: ['romance.memory'] })), []);
  assert.deepEqual(codes(run([['{Every Tuesday at 7 I phoned her.}', 'romance.memory', 'verbatim']], { answerSources: ['romance.memory'] })), []);
  // Hyphen / space variants of a name.
  const hy = { ...INPUT, answers: { a: { memory: 'We played Sky-Ball every summer.' } } };
  assert.deepEqual(codes(checkAnswerSources(sd([['{We played Skyball all summer.}', 'a.memory', 'paraphrase']], { answerSources: ['a.memory'] }), hy)), []);
});

test('connective lines: short and fact-free are fine; facts, length and too many are flagged', () => {
  assert.deepEqual(codes(run([['{Later that day.}', null, 'connective'], ['{Patience is just love that waits.}', 'childhood.memory', 'verbatim']])), []);
  const fact = run([['{Back at Moraine.}', null, 'connective']]);
  assert.deepEqual(codes(fact), ['LINE_FACT_NOT_IN_SOURCE']); assert.match(fact[0].message, /connective.*cite that answer/);
  assert.deepEqual(codes(run([['{And so the long quiet afternoon went on and on and on, slow and warm.}', null, 'connective']])), ['CONNECTIVE_LINE_LONG']);
  assert.equal(connectiveCap(5), 2); assert.equal(connectiveCap(20), 4);
  const many = run([['{Later.}', null, 'connective'], ['{Then.}', null, 'connective'], ['{After that.}', null, 'connective'], ['{Patience is just love that waits.}', 'childhood.memory', 'verbatim']]);
  assert.deepEqual(codes(many), ['CONNECTIVE_LINES_HIGH']); assert.equal(many[0].severity, 'warning'); assert.match(many[0].message, /1\.1, 1\.2, 1\.3/);
});

test('every part lists the answers it depicts; shots showing named details from other answers warn', () => {
  assert.deepEqual(codes(run([['{Patience is just love that waits.}', 'childhood.memory', 'verbatim']], { answerSources: [] })), ['SEGMENT_SOURCE_MISSING']);
  assert.deepEqual(codes(run([['{Patience is just love that waits.}', 'childhood.memory', 'verbatim']], { answerSources: ['childhood.mem'] })), ['SEGMENT_SOURCE_UNKNOWN']);
  const w = run([['{Patience is just love that waits.}', 'childhood.memory', 'verbatim']], { see: '@AdultTheo waits at the Fransisco bus stop at 7pm' });
  assert.deepEqual(codes(w), ['SHOT_FACT_NOT_IN_SOURCE']); assert.equal(w[0].severity, 'warning');
  assert.deepEqual(codes(run([['{Patience is just love that waits.}', 'childhood.memory', 'verbatim']], { see: 'the two of them fish at Lake Moraine' })), []);
});

test('no answers in the input: nothing to trace against, the checks stay silent (unit fixtures)', () => {
  assert.deepEqual(checkAnswerSources(sd([['{Anything.}', null, null]]), {}), []);
  assert.deepEqual(checkExtraCast({ cast: [{ elementTag: '@Zed', name: 'Zed', realPerson: 'Zed' }] }, { answers: {} }), []);
});

test('extra cast: a card whose person the family never names fails; names, relations, notes, photos and subject count', () => {
  const card = (name, realPerson = name, tag = `@${name.replace(/\s/g, '')}`) => ({ elementTag: tag, name, realPerson });
  const input = { ...INPUT, photoCharacters: [{ id: 'p1', name: 'Uncle Bo', realPerson: 'Bo', skinTone: 'warm brown', description: 'tall man with a beard' }] };
  const ok = [card('Adult Theo', 'Theo'), card('Gran'), card('June'), card('Wren'), card('Bo'), card('Grandma', 'Grandma')];
  assert.deepEqual(checkExtraCast({ cast: ok }, input), []);
  const r = checkExtraCast({ cast: [...ok, card('Son', 'Son'), card('Max')] }, input);
  assert.deepEqual(r.map((i) => [i.code, i.path]), [['CAST_NOT_IN_ANSWERS', 'cast.6'], ['CAST_NOT_IN_ANSWERS', 'cast.7']]);
  assert.match(r[0].message, /@Son.*not named anywhere/);
  // relation words: "my mother" in the answers covers an @Mom card; "my sis" covers @Sister
  const rel = { answers: { a: 'My mother sang while my sis drew.' } };
  assert.deepEqual(checkExtraCast({ cast: [card('Mom'), card('Sister')] }, rel), []);
  // wired into the Story Director gate
  assert.ok(codes(validateStoryDirectorOutput({ ...good(), cast: [...good().cast, { ...good().cast[0], elementTag: '@Nephew', name: 'Nephew', realPerson: 'Nephew' }] }, GOOD_INPUT).issues).includes('CAST_NOT_IN_ANSWERS'));
});

test('the gate wires the trace in, and the Seedance slice drops the source field', () => {
  const d = good(); d.segments[0].shots[1].dialogue.source.answer = 'scene9.memory';
  const r = validateStoryDirectorOutput(d, GOOD_INPUT);
  assert.equal(r.isValid, false); assert.ok(codes(r.issues).includes('LINE_SOURCE_UNKNOWN'));
  const line = good().segments[0].shots[1].dialogue;
  const sh = InputShotSchema.parse({ sceneId: '1.2', shotNumber: 2, startSec: 0, endSec: 3, location: 'Kitchen', whatWeSee: '@Theo looks up at the window', dialogue: line });
  assert.equal(sh.dialogue.line, line.line); assert.ok(!('source' in sh.dialogue), 'source is not needed downstream');
});

test('trace as data: summary rows, plain table, critique prompt includes it and asks for untraceable lines as JSON', () => {
  const t = traceSummary(good(), GOOD_INPUT);
  assert.deepEqual([t.lines, t.withProblems, t.connective, t.connectiveCap], [7, 0, 0, 2]);
  assert.deepEqual(Object.keys(t.rows[0]), ['where', 'field', 'kind', 'answer', 'score', 'problems', 'line']);
  assert.equal(traceSummary(good(), {}), null); assert.equal(traceReport(good(), {}), '');
  const table = traceReport(good(), GOOD_INPUT);
  assert.match(table, /7 lines, 0 with problems/); assert.match(table, /1\.2 \| dialogue \| verbatim \| scene1Childhood\.memory \| 100% \| ok/);
  const msgs = critiqueMessages({ agent: 'story-director', skill: 'rules', input: GOOD_INPUT, draft: good(), round: 1, rounds: 2, trace: table });
  assert.match(msgs[1].content, /Line-by-line trace/); assert.match(msgs[1].content, /"untraceable"/); assert.match(msgs[1].content, /VERDICT: REVISE or VERDICT: SHIP\.$/);
  assert.ok(!/untraceable/.test(critiqueMessages({ agent: 'story-director', skill: 'r', input: {}, draft: {}, round: 1, rounds: 1 })[1].content), 'no trace, no ask');
  assert.deepEqual(parseUntraceable('1. bad\n```json\n{"untraceable": [{"where": "2.1", "line": "{x}", "why": "invented", "fix": "cut"}]}\n```\nVERDICT: REVISE'), [{ where: '2.1', line: '{x}', why: 'invented', fix: 'cut' }]);
  assert.equal(parseUntraceable('no block'), null); assert.equal(parseUntraceable('```json\n{bad json\n```'), null);
  const spec = AGENT_SPECS['story-director'].trace(good(), GOOD_INPUT);
  assert.match(spec.text, /Answer trace/); assert.equal(spec.data.lines, 7);
});

class ScriptedModel extends BaseChatModel {
  constructor(script) { super({}); this.modelName = 'isolated-scripted-model'; this.script = script; this.calls = []; }
  getName() { return 'ChatOpenAI'; }
  _llmType() { return 'isolated-scripted-test'; }
  bindTools() { return this; }
  async _generate(messages) { this.calls.push(messages); const step = this.script.shift(); assert.ok(step, 'model called after expected termination'); return { generations: [{ text: '', message: step(messages) }] }; }
}
const submit = (args) => new AIMessage({ content: '', tool_calls: [{ name: 'submit_story_director', args, id: 's' + Math.random().toString(36).slice(2, 7), type: 'tool_call' }] });

test('reflection logs the trace and the critic\'s untraceable list per round', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'wiggly-v2-trace-'));
  try {
    const seen = [];
    const m = new ScriptedModel([
      () => submit(good()),
      (msgs) => { seen.push(msgs.map((x) => x.content).join('\n')); return new AIMessage('1. Shot 2.1 adds nothing.\n```json\n{"untraceable": [{"where": "2.1", "line": "{She never once laughed at me.}", "why": "wrong source", "fix": "scene5LegacyFinale.memory"}]}\n```\nVERDICT: REVISE'); },
      () => submit(good()),
    ]);
    const trace = (o) => AGENT_SPECS['story-director'].trace(o, GOOD_INPUT);
    const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 't' })({ agent: 'story-director', config: { model: 'x', reflectionRounds: 1 }, input: GOOD_INPUT, attempt: 1, trace });
    assert.match(seen[0], /Answer trace \(deterministic\): 7 lines/);
    const e = out[REFLECTION].log[0];
    assert.equal(e.trace.lines, 7); assert.equal(e.trace.withProblems, 0);
    assert.deepEqual(e.untraceable.map((u) => u.where), ['2.1']);
  } finally { await rm(runs, { recursive: true, force: true }); }
});
