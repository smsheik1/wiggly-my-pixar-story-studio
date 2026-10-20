// Tests for answer tracing. No child processes, no network: every model call
// goes through an injected fake museCall / fake spawn; temp dirs are cleaned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { museCall, OPENCODE_MODEL } from '../scripts/lib/muse-opencode.mjs';
import {
  extractFacts,
  judgeAgent,
  parseJudgement,
  traceAnswers,
  answerTraceMarkdown,
  answerTraceHtml,
  prepareOutput,
  TRACE_START,
  TRACE_END,
} from '../scripts/lib/answer-trace.mjs';
import { upsertSection } from '../scripts/lib/audit.mjs';
import answerTraceJudge from '../scripts/judges/answer-trace.mjs';

const ANSWERS = { answers: { q1: { memory: 'Shaz is 8 and loves Yugioh' } }, subject: 'Shaz' };
const FACTS = [
  { id: 'F1', kind: 'person', text: 'Shaz has an older sister', source: 'q1.memory' },
  { id: 'F2', kind: 'place', text: 'the family lived in Dallas', source: 'q1.memory' },
  { id: 'F3', kind: 'age', text: 'Shaz was 8 years old', source: 'q1.memory' },
];
const OUTPUT = { cast: [{ name: 'Shaz' }], title: 'The Accord' };

/** Fake museCall serving scripted replies; records prompts. */
const scriptFake = (replies) => {
  const calls = [];
  const fn = async (prompt) => {
    calls.push(prompt);
    return replies[Math.min(calls.length - 1, replies.length - 1)];
  };
  fn.calls = calls;
  return fn;
};

/** Fake child_process.spawn: emits stdout chunks then closes. */
const spawnFake = (chunks, exitCode = 0) => {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    child.kill = () => {};
    queueMicrotask(() => {
      for (const c of chunks) child.stdout.emit('data', Buffer.from(c));
      child.emit('close', exitCode, null);
    });
    return child;
  };
  spawnFn.calls = calls;
  return spawnFn;
};

test('extraction is cached: second run makes 0 calls; changed answers make 1', { timeout: 10000 }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'trace-test-'));
  t.after(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });
  const reply = JSON.stringify({
    facts: [
      { id: 'F1', kind: 'age', text: 'Shaz was 8 years old', source: 'q1.memory' },
      { id: 'F-bad', kind: 'person' },
      { id: 'F-dup', kind: 'age', text: '  shaz WAS 8 years   old ', source: 'q1.memory' },
    ],
  });
  const fake = scriptFake([reply]);
  const first = await extractFacts({ answers: ANSWERS, cacheDir, museCall: fake });
  assert.equal(fake.calls.length, 1);
  assert.equal(first.cached, false);
  assert.equal(first.calls, 1);
  assert.deepEqual(
    first.facts.map((f) => f.id),
    ['F1'],
  );

  const second = await extractFacts({ answers: ANSWERS, cacheDir, museCall: fake });
  assert.equal(fake.calls.length, 1);
  assert.equal(second.cached, true);
  assert.equal(second.calls, 0);
  assert.deepEqual(second.facts, first.facts);

  const changed = await extractFacts({ answers: { ...ANSWERS, subject: 'Mia' }, cacheDir, museCall: fake });
  assert.equal(fake.calls.length, 2);
  assert.equal(changed.cached, false);
});

test('judge parsing: fenced JSON, n/a by expectedKinds', { timeout: 10000 }, async () => {
  const fenced = '```json\n' + JSON.stringify({
    facts: [
      { id: 'F1', status: 'kept', evidence: 'older sister' },
      { id: 'F2', status: 'dropped', evidence: '' },
      { id: 'F3', status: 'changed', evidence: 'age 9', note: 'off by one' },
    ],
    invented: [],
  }) + '\n```';
  const fake = scriptFake([fenced]);
  const j = await judgeAgent({ agent: 'character-architect', facts: FACTS, output: OUTPUT, museCall: fake });
  const byId = Object.fromEntries(j.results.map((r) => [r.id, r.status]));
  assert.equal(byId.F1, 'kept');
  assert.equal(byId.F2, 'n/a'); // place is outside Character Architect kinds
  assert.equal(byId.F3, 'changed');
  assert.equal(j.results.find((r) => r.id === 'F3').note, 'off by one');
});

test('judge parsing: missing ids become unknown', { timeout: 10000 }, async () => {
  const fake = scriptFake([JSON.stringify({ facts: [{ id: 'F1', status: 'kept', evidence: 'x' }], invented: [] })]);
  const j = await judgeAgent({ agent: 'story-director', facts: FACTS, output: OUTPUT, museCall: fake });
  const byId = Object.fromEntries(j.results.map((r) => [r.id, r.status]));
  assert.equal(byId.F1, 'kept');
  assert.equal(byId.F2, 'unknown');
  assert.equal(byId.F3, 'unknown');
});

test('judge parsing: bad JSON retries once then errors', { timeout: 10000 }, async () => {
  const fake = scriptFake(['total garbage', 'still garbage']);
  await assert.rejects(() => judgeAgent({ agent: 'story-director', facts: FACTS, output: OUTPUT, museCall: fake }));
  assert.equal(fake.calls.length, 2);
  assert.match(fake.calls[1], /Reply with JSON only\./);
});

test('n/a mapping is literal: only dropped becomes n/a', { timeout: 10000 }, async () => {
  const { results } = parseJudgement(
    'location-scout',
    FACTS,
    { facts: [{ id: 'F1', status: 'kept', evidence: 'x' }, { id: 'F3', status: 'dropped', evidence: '' }], invented: [] },
  );
  const byId = Object.fromEntries(results.map((r) => [r.id, r.status]));
  assert.equal(byId.F1, 'kept'); // kept stands even outside expected kinds
  assert.equal(byId.F3, 'n/a'); // age is outside Location Scout kinds
  assert.equal(byId.F2, 'unknown');
});

test('faithfulness math; storyFaithfulness prefers seedance-compiler', { timeout: 10000 }, async () => {
  const judgements = {
    'story-director': {
      results: [
        { id: 'F1', kind: 'person', status: 'kept', evidence: '' },
        { id: 'F2', kind: 'place', status: 'changed', evidence: '' },
        { id: 'F3', kind: 'age', status: 'dropped', evidence: '' },
      ],
      invented: [],
    },
    'seedance-compiler': {
      results: [
        { id: 'F1', kind: 'person', status: 'kept', evidence: '' },
        { id: 'F2', kind: 'place', status: 'kept', evidence: '' },
        { id: 'F3', kind: 'age', status: 'kept', evidence: '' },
      ],
      invented: [],
    },
  };
  const model = traceAnswers({ facts: FACTS, judgements });
  assert.deepEqual(model.agents['story-director'].counts, { kept: 1, changed: 1, dropped: 1, na: 0, unknown: 0 });
  assert.equal(model.agents['story-director'].faithfulness, 0.333);
  assert.equal(model.storyFaithfulness, 1);

  const sdOnly = traceAnswers({ facts: FACTS, judgements: { 'story-director': judgements['story-director'] } });
  assert.equal(sdOnly.storyFaithfulness, 0.333);

  const empty = traceAnswers({
    facts: FACTS,
    judgements: { 'location-scout': { results: [{ id: 'F1', kind: 'person', status: 'n/a', evidence: '' }], invented: [] } },
  });
  assert.equal(empty.agents['location-scout'].faithfulness, null);
});

test('lost-downstream detection; invented sorted major first', { timeout: 10000 }, async () => {
  const fake = scriptFake([
    JSON.stringify({
      facts: [
        { id: 'F1', status: 'dropped', evidence: '' },
        { id: 'F2', status: 'kept', evidence: 'Dallas' },
        { id: 'F3', status: 'kept', evidence: '8' },
      ],
      invented: [
        { detail: 'a red bicycle', evidence: '', severity: 'minor' },
        { detail: 'a hidden letter', evidence: '', severity: 'major' },
      ],
    }),
  ]);
  const judgements = {
    'story-director': {
      results: FACTS.map((f) => ({ ...f, status: 'kept', evidence: '' })),
      invented: [],
    },
    'seedance-compiler': await judgeAgent({ agent: 'seedance-compiler', facts: FACTS, output: OUTPUT, museCall: fake }),
  };
  const model = traceAnswers({ facts: FACTS, judgements });
  assert.deepEqual(model.lostDownstream, ['F1']);
  assert.deepEqual(
    model.agents['seedance-compiler'].invented.map((d) => d.severity),
    ['major', 'minor'],
  );
});

test('markdown/html sections render; report.html upsert is idempotent', { timeout: 10000 }, async () => {
  const model = traceAnswers({
    facts: FACTS,
    judgements: {
      'story-director': { results: FACTS.map((f) => ({ ...f, status: 'kept', evidence: '' })), invented: [] },
      'seedance-compiler': {
        results: FACTS.map((f) => ({ ...f, status: f.id === 'F1' ? 'dropped' : 'kept', evidence: '' })),
        invented: [{ detail: 'a hidden letter', evidence: 'letter', severity: 'major' }],
      },
    },
  });
  const md = answerTraceMarkdown(model);
  assert.match(md, /storyFaithfulness/);
  assert.match(md, /✔/);
  assert.match(md, /✖/);
  assert.match(md, /Lost downstream/);
  assert.match(md, /hidden letter/);

  const html = answerTraceHtml(model);
  assert.ok(html.includes(TRACE_START) && html.includes(TRACE_END));

  const page = "<html><head></head><body><p>hi</p></body></html>";
  const once = upsertSection(page, html, { start: TRACE_START, end: TRACE_END });
  const twice = upsertSection(once, html, { start: TRACE_START, end: TRACE_END });
  assert.equal(twice, once);
  assert.equal(once.split(TRACE_START).length - 1, 1);
  assert.ok(once.includes('<p>hi</p>'));
});

test('prepareOutput strips non-story fields and caps at ~60KB', { timeout: 10000 }, async () => {
  const big = 'x'.repeat(2000);
  const out = prepareOutput({ cast: [{ name: 'Shaz' }], htmlScriptDocument: big, compiledPrompt: big, generationPayload: big, assetMap: big, long: big.repeat(100) });
  assert.ok(!('htmlScriptDocument' in out) && !('compiledPrompt' in out) && !('generationPayload' in out) && !('assetMap' in out));
  assert.deepEqual(out.cast, [{ name: 'Shaz' }]);
  assert.ok(Buffer.byteLength(JSON.stringify(out), 'utf8') <= 61 * 1024);
});

test('judge hook returns storyFaithfulness from cache without calling museCall', { timeout: 10000 }, async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'trace-test-'));
  t.after(async () => {
    await rm(runDir, { recursive: true, force: true });
  });
  const counts = { kept: 3, changed: 1, dropped: 0, na: 1, unknown: 0 };
  await writeFile(
    join(runDir, 'answer-trace.json'),
    JSON.stringify({ storyFaithfulness: 0.75, agents: { 'story-director': { counts, faithfulness: 0.75, invented: [] } } }),
    'utf8',
  );
  const failIfCalled = async () => {
    throw new Error('museCall must not be called when the cache is present');
  };
  const res = await answerTraceJudge.run({ outputs: {}, inputs: {}, runDir }, { museCall: failIfCalled });
  assert.equal(res.score, 0.75);
  assert.deepEqual(res.details, { 'story-director': counts });
});

test('museCall builds the exact argv and never references OPENROUTER', { timeout: 10000 }, async () => {
  const prompt = 'Reply with JSON only: {"facts": []}';
  const inner = JSON.stringify({ facts: [] });
  const spawnFn = spawnFake(['{"type":"start"}\n', `${JSON.stringify({ text: `prefix ${inner} suffix` })}\n`]);
  const text = await museCall(prompt, { spawnFn });
  assert.equal(text, `prefix ${inner} suffix`);
  assert.equal(spawnFn.calls.length, 1);
  const [{ cmd, args, opts }] = spawnFn.calls;
  assert.equal(cmd, 'opencode');
  assert.deepEqual(args, ['run', '-m', OPENCODE_MODEL, '--variant', 'xhigh', '--format', 'json', prompt]);
  assert.ok(!opts.shell);
  assert.equal(OPENCODE_MODEL, 'opencode/muse-spark-1.3-contributor-free');

  const src = await readFile(new URL('../scripts/lib/muse-opencode.mjs', import.meta.url), 'utf8');
  assert.ok(!src.includes('OPENROUTER'));
});

test('museCall retries once on non-JSON then throws', { timeout: 10000 }, async () => {
  const spawnFn = spawnFake(['not json at all\n']);
  await assert.rejects(() => museCall('{"facts": []}?', { spawnFn }), /not JSON after retry/);
  assert.equal(spawnFn.calls.length, 2);
  assert.match(spawnFn.calls[1].args.at(-1), /Reply with JSON only\./);
});

test('museCall surfaces opencode failure with a clear message', { timeout: 10000 }, async () => {
  const spawnFn = spawnFake(['boom\n'], 1);
  await assert.rejects(() => museCall('hi', { spawnFn }), /opencode run failed/);
});

test('assistantTextFromStream ignores reasoning parts and keeps only text parts', { timeout: 10000 }, async () => {
  const { assistantTextFromStream } = await import('../scripts/lib/muse-opencode.mjs');
  const s = [JSON.stringify({ type: 'reasoning', part: { type: 'reasoning', text: 'thinking {not json}' } }), JSON.stringify({ type: 'text', part: { type: 'text', text: '{"facts":[]}' } })].join('\n');
  assert.equal(assistantTextFromStream(s), '{"facts":[]}');
});
