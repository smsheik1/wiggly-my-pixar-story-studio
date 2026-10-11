// Department evals ("automated dailies"): golden cases, assertion scoring, replay, baseline
// regressions, the hard live spend cap and recording hygiene. Fakes only: no network, no codex,
// no r4 run data (agent-runs/ is never in CI).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  loadGolden, scoreAssertion, scoreCase, Budget, DEPT_EVAL_HARD_CAP_USD, assertRecordingClean, runDeptEvals,
  roleFingerprint, DEPARTMENTS, cli, worstCaseUsd, selectCases, recorderFetcher,
} from '../evaluation/dept-evals.mjs';
import { loadStudio } from '../runtime/instructions.mjs';

const kit = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const anyEvent = z.any();

const review = (decision, checks = [], recommendation) => ({ action: 'review', review: { decision, checks, ...(recommendation ? { recommendation } : {}) } });
const chk = (criterion, status, evidence = '') => ({ criterion, status, evidence });

async function sandbox(cases) {
  const dir = await mkdtemp(join(tmpdir(), 'dept-eval-test-'));
  const golden = join(dir, 'golden.json');
  await writeFile(golden, JSON.stringify({ version: 1, sourceRun: 'test', notes: 'synthetic', cases }));
  await mkdir(join(dir, 'rec'), { recursive: true });
  return { dir, golden, rec: join(dir, 'rec'), baseline: join(dir, 'baseline.json'), cas: join(dir, 'cas') };
}
const veraCase = (over = {}) => ({ id: 'vera-x', dept: 'vera', priority: 1, source: { key: 'candidates:x', gate: 'review', version: 1 },
  truth: { authority: 'shaz', summary: 'synthetic truth for tests', history: [1] },
  asserts: [{ id: 'rejects', type: 'verdict', oneOf: ['rejected'], why: 't' }, { id: 'no-wrist', type: 'mustNotClaim', pattern: 'wrist', why: 't' }], ...over });

test('1. golden set: valid, real departments, hard assertions, reviewers + a writer covered', { timeout: 10000 }, async () => {
  const g = await loadGolden();
  const depts = new Set(g.cases.map(c => c.dept));
  for (const d of ['vera', 'sage']) assert.ok(depts.has(d), `missing ${d}`);
  assert.ok(depts.has('leo') || depts.has('beau'), 'needs a writer role');
  for (const c of g.cases) {
    assert.ok(c.asserts.some(a => !a.soft), c.id);
    assert.ok(c.truth.history.length > 0, c.id);
    assert.ok(DEPARTMENTS[c.dept]);
  }
  // The headline r4 lessons are encoded as assertions, not prose.
  const ids = g.cases.flatMap(c => c.asserts.map(a => `${c.id}/${a.id}`));
  for (const want of ['vera-adult-sheets-wrist/no-wrist-false-reject', 'vera-adult-sheets-wrist/top-pick-option-2', 'vera-late-teen-text-labels/flags-baked-in-text', 'vera-room-generic/rejects-generic-room', 'sage-room-brief-generic/rejects-generic-brief', 'sage-script-slash-abbrev/rejects-slash-abbrev', 'sage-script-slash-abbrev/names-slash-abbrev', 'sage-script-slash-abbrev/no-other-defects']) assert.ok(ids.includes(want), want);
  // The 'A/C' script case: a failing check about the slash is the expected finding; any other failing check is an invented defect.
  const noOther = g.cases.find(c => c.id === 'sage-script-slash-abbrev').asserts.find(a => a.id === 'no-other-defects');
  assert.equal(scoreAssertion(noOther, review('rejected', [chk('clarity', 'fail', 'Beat 2 says no A/C; TTS reads A slash C.'), chk('timing', 'pass', 'fits')])).pass, true);
  assert.equal(scoreAssertion(noOther, review('rejected', [chk('clarity', 'fail', 'no A/C'), chk('facts', 'fail', 'Beat 3 invents a promise.')])).pass, false);
  // Priority order is total, so the capped live run spends on the most important cases first.
  assert.equal(new Set(g.cases.map(c => c.priority)).size, g.cases.length);
  assert.deepEqual(selectCases(g, { depts: ['vera'] }).map(c => c.dept), ['vera', 'vera', 'vera', 'vera']);
});

test('2. assertions: each type passes and fails on the right evidence', { timeout: 10000 }, () => {
  const wrist = review('rejected', [chk('consistency', 'fail', 'The watch switches to the other wrist in profile.')]);
  const chain = review('rejected', [chk('consistency', 'fail', 'Options 1 and 3 drop the silver chain in all portraits.'), chk('style', 'pass', 'watch on left wrist stays consistent')]);
  const wristRx = '(switch|swap|other|wrong)[^.]{0,60}wrist|wrist[^.]{0,60}(switch|swap|other|wrong)';
  assert.equal(scoreAssertion({ type: 'mustNotClaim', pattern: wristRx }, wrist).pass, false);
  assert.equal(scoreAssertion({ type: 'mustNotClaim', pattern: wristRx }, chain).pass, true, 'a passing check mentioning the wrist is not a claim');
  assert.equal(scoreAssertion({ type: 'mustMention', pattern: 'chain' }, chain).pass, true);
  assert.equal(scoreAssertion({ type: 'mustMention', pattern: 'chain', criteria: ['style'] }, chain).pass, false);
  assert.equal(scoreAssertion({ type: 'verdict', oneOf: ['rejected'] }, chain).pass, true);
  assert.equal(scoreAssertion({ type: 'verdict', oneOf: ['approved', 'provisional'] }, chain).pass, false);
  const rec = review('approved', [chk('style', 'pass')], { selection: 1, ranking: [1, 0], reason: 'clean' });
  assert.equal(scoreAssertion({ type: 'topPick', selection: 1 }, rec).pass, true);
  assert.equal(scoreAssertion({ type: 'topPick', selection: 0 }, rec).pass, false);
  assert.equal(scoreAssertion({ type: 'topPick', selection: 0, ifPresent: true }, chain).pass, true, 'no recommendation allowed when ifPresent');
  assert.equal(scoreAssertion({ type: 'topPick', selection: 0 }, chain).pass, false);
  assert.equal(scoreAssertion({ type: 'mustNotPick', selections: [1] }, rec).pass, false);
  assert.equal(scoreAssertion({ type: 'mustNotPick', selections: [0, 2] }, rec).pass, true);
  const art = { action: 'artifact', content: { direction: 'A lived-in room for a kid who dreams of science, sunglasses on the desk.', beats: [{ narration: 'no A/C' }] } };
  assert.equal(scoreAssertion({ type: 'contentMatches', pattern: 'sunglass' }, art).pass, true);
  assert.equal(scoreAssertion({ type: 'contentNotMatches', pattern: 'ivory walls' }, art).pass, true);
  assert.equal(scoreAssertion({ type: 'contentNotMatches', field: 'beats', pattern: '\\b[A-Za-z]{1,3}/[A-Za-z]{1,3}\\b' }, art).pass, false);
  assert.equal(scoreAssertion({ type: 'contentMatches', field: 'missing', pattern: '.' }, art).pass, false);
});

test('3. scoreCase: not completing fails every hard assertion; soft assertions never fail a case', { timeout: 10000 }, () => {
  const c = veraCase({ asserts: [{ id: 'rejects', type: 'verdict', oneOf: ['rejected'], why: 't' }, { id: 'pick', type: 'topPick', selection: 2, soft: true, why: 't' }] });
  const ok = scoreCase(c, { event: review('rejected', [chk('style', 'fail', 'x')]), valid: true, gateAccepted: true });
  assert.equal(ok.status, 'pass');
  assert.equal(ok.assertions.find(a => a.id === 'pick').pass, false);
  const broken = scoreCase(c, { event: null, valid: false, gateAccepted: false, error: 'INVALID_WORKER_EVENT' });
  assert.equal(broken.status, 'fail');
  assert.equal(broken.assertions[0].id, 'completes');
  assert.match(broken.assertions[0].detail, /INVALID_WORKER_EVENT/);
  const gate = scoreCase(c, { event: review('rejected'), valid: true, gateAccepted: false, error: 'gate' });
  assert.equal(gate.status, 'fail');
});

test('4. budget: hard cap is $0.10 and can only be lowered; a request that could cross it is never sent', { timeout: 10000 }, async () => {
  assert.equal(new Budget(5).cap, DEPT_EVAL_HARD_CAP_USD);
  assert.equal(new Budget('nope').cap, DEPT_EVAL_HARD_CAP_USD);
  assert.equal(new Budget(0.02).cap, 0.02);
  const body = JSON.stringify({ model: 'meta/muse-spark-1.3-contributor', max_tokens: 32000, messages: [{ role: 'user', content: 'x'.repeat(4000) }] });
  const worst = worstCaseUsd(body, 'meta/muse-spark-1.3-contributor');
  assert.ok(worst > 0.0064 && worst < 0.0075, String(worst));
  let sent = 0;
  const ok = async () => { sent++; return new Response(JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.001 } }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const b = new Budget(0.02);
  const f = b.wrap(ok, 'meta/muse-spark-1.3-contributor');
  await f('u', { body }); await f('u', { body });
  assert.equal(sent, 2); assert.ok(Math.abs(b.spent - 0.002) < 1e-9);
  // spent 0.002 + worst ~0.0068 fits; then at 0.0128+ the next worst would exceed 0.02
  b.spent = 0.0135;
  await assert.rejects(f('u', { body }), /DEPT_EVAL_CAP_REACHED/);
  assert.equal(sent, 2, 'refused request never reached the network');
  // non-2xx costs nothing; a thrown fetch is charged its worst case
  const b2 = new Budget(0.1);
  await b2.wrap(async () => new Response('{}', { status: 500 }), 'm')('u', { body });
  assert.equal(b2.spent, 0);
  await assert.rejects(b2.wrap(async () => { throw new Error('net'); }, 'meta/muse-spark-1.3-contributor')('u', { body }), /net/);
  assert.ok(b2.spent > 0.006);
  assert.equal(b2.reserved, 0);
});

test('5. recordings refuse media bytes, keys and secrets', { timeout: 10000 }, () => {
  assert.ok(assertRecordingClean({ a: 'data:image/png;sha256,' + 'a'.repeat(64), b: 'fine' }));
  assert.throws(() => assertRecordingClean({ a: 'data:image/png;base64,iVBORw0KGgo=' }), /UNSAFE/);
  assert.throws(() => assertRecordingClean({ a: 'Authorization: Bearer abcdefghijklmnop' }), /UNSAFE/);
  assert.throws(() => assertRecordingClean({ a: 'sk-or-v1-abcdef123456' }), /UNSAFE/);
  assert.throws(() => assertRecordingClean({ a: 'my-secret-value-1' }, ['my-secret-value-1']), /UNSAFE/);
  assert.throws(() => assertRecordingClean({ a: 'A'.repeat(2500) }), /UNSAFE/);
});

test('6. replay: recorded outcome re-scored; missing, stale (prompt changed) and baseline regressions', { timeout: 20000 }, async () => {
  const s = await sandbox([veraCase(), veraCase({ id: 'vera-y', priority: 2 })]);
  try {
    const studio = loadStudio();
    const fp = await roleFingerprint('visual-reviewer', studio);
    const good = { caseId: 'vera-x', recordedAt: 't', fingerprint: fp.digest, fingerprintParts: fp.parts, costUsd: 0.01, wallMs: 1000, requests: [{}, {}], outcome: { event: review('rejected', [chk('style', 'fail', 'text labels')]), valid: true, gateAccepted: true, error: null } };
    await writeFile(join(s.rec, 'vera-x.json'), JSON.stringify(good));
    const opts = { goldenPath: s.golden, recordingsDir: s.rec, baselinePath: s.baseline, cassettesDir: s.cas, studio, eventSchema: anyEvent };
    let card = await runDeptEvals({ ...opts, updateBaseline: true });
    assert.deepEqual(card.cases.map(c => c.status), ['pass', 'missing']);
    assert.equal(card.exitCode, 0);
    assert.equal(card.spendUsd, 0);
    const base = JSON.parse(await readFile(s.baseline, 'utf8'));
    assert.deepEqual(base.cases['vera-x'].passing.sort(), ['completes', 'no-wrist', 'rejects']);
    assert.equal((await runDeptEvals({ ...opts, strict: true })).exitCode, 1, '--strict fails on missing');
    // The agent now (re-recorded) repeats the false wrist claim: regression, exit 1.
    await writeFile(join(s.rec, 'vera-x.json'), JSON.stringify({ ...good, outcome: { ...good.outcome, event: review('rejected', [chk('consistency', 'fail', 'wrist')]) } }));
    card = await runDeptEvals(opts);
    assert.equal(card.cases[0].status, 'fail');
    assert.deepEqual(card.regressions, [{ id: 'vera-x', dept: 'vera', lost: ['no-wrist'] }]);
    assert.equal(card.exitCode, 1);
    // Vera's skill changed since recording: stale, not a silent pass.
    await writeFile(join(s.rec, 'vera-x.json'), JSON.stringify({ ...good, fingerprint: 'old', fingerprintParts: { ...fp.parts, skill: { path: 'crew/vera/SKILL.md', sha256: 'old' } } }));
    card = await runDeptEvals(opts);
    assert.equal(card.cases[0].status, 'stale');
    assert.match(card.cases[0].detail, /skill/);
    assert.equal(card.exitCode, 0);
    // Scorecard lists departments with no golden cases instead of hiding them.
    assert.equal(card.byDept.june.goldenCases, 0);
  } finally { await rm(s.dir, { recursive: true, force: true }); }
});

test('7. live: refuses without --confirm-spend or --run; never calls the network when refused', { timeout: 10000 }, async () => {
  const s = await sandbox([veraCase()]);
  try {
    let calls = 0;
    const realFetch = async () => { calls++; throw new Error('network'); };
    const a = await runDeptEvals({ mode: 'live', goldenPath: s.golden, recordingsDir: s.rec, baselinePath: s.baseline, realFetch, runDir: '/nonexistent' });
    assert.equal(a.exitCode, 2); assert.match(a.refused, /CONFIRM|confirm-spend/i);
    const b = await runDeptEvals({ mode: 'live', confirmSpend: true, goldenPath: s.golden, recordingsDir: s.rec, baselinePath: s.baseline, realFetch });
    assert.equal(b.exitCode, 2); assert.match(b.refused, /RUN_REQUIRED/);
    assert.equal(calls, 0);
  } finally { await rm(s.dir, { recursive: true, force: true }); }
});

test('8. live (fake network): records clean recordings + cassettes, stops at the cap, infra errors are not recorded', { timeout: 20000 }, async () => {
  const s = await sandbox([veraCase(), veraCase({ id: 'vera-y', priority: 2 }), veraCase({ id: 'vera-z', priority: 3 }), veraCase({ id: 'vera-w', priority: 4 })]);
  try {
    const secrets = join(s.dir, 'secrets.env');
    await writeFile(secrets, 'OPENROUTER_API_KEY=sk-or-v1-testkeytestkey123\n');
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    let network = 0;
    const realFetch = async (_url, init) => {
      network++;
      assert.ok(!String(init.headers?.Authorization ?? '').includes('undefined'));
      return new Response(JSON.stringify({ model: 'meta/muse-spark-1.3-contributor', choices: [{ message: { role: 'assistant', content: '{"eventJson":"{}"}', reasoning: 'secret thoughts' } }], usage: { prompt_tokens: 3000, completion_tokens: 28000, cost: 0.006 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    // Fake executor: sends one real-shaped request (with an inline image) through the provided fetcher.
    const execute = async (c, { fetcher }) => {
      if (c.id === 'vera-w') return { event: null, valid: false, gateAccepted: false, error: 'OPENROUTER_REQUEST_FAILED: HTTP 502' };
      try {
        await fetcher('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer sk-or-v1-testkeytestkey123', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'meta/muse-spark-1.3-contributor', max_tokens: 32000, messages: [{ role: 'user', content: [{ type: 'text', text: 'packet at /tmp/x' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] }] }) });
      } catch (e) { return { event: null, valid: false, gateAccepted: false, error: `OPENROUTER_REQUEST_FAILED: ${e.message}` }; }
      return { event: review('rejected', [chk('style', 'fail', 'labels')]), valid: true, gateAccepted: true, error: null };
    };
    const card = await runDeptEvals({ mode: 'live', confirmSpend: true, maxUsd: 0.015, concurrency: 1, secretsPath: secrets, statesOverride: [], realFetch, execute,
      goldenPath: s.golden, recordingsDir: s.rec, baselinePath: s.baseline, cassettesDir: s.cas, eventSchema: anyEvent });
    // $0.006 per request, ~$0.0068 worst case: two fit under $0.015, the third is refused before sending.
    assert.deepEqual(card.cases.map(c => c.status), ['pass', 'pass', 'skipped', 'error']);
    assert.equal(network, 2);
    assert.ok(card.spendUsd <= 0.015 + 1e-9, String(card.spendUsd));
    assert.equal(card.refusedRequests, 1);
    const recs = (await readdir(s.rec)).sort();
    assert.deepEqual(recs, ['vera-x.json', 'vera-y.json'], 'skipped and infra-error cases are not recorded');
    const text = await readFile(join(s.rec, 'vera-x.json'), 'utf8');
    assert.doesNotMatch(text, /base64|sk-or-v1-testkey|secret thoughts/);
    const cassette = await readFile(join(s.cas, 'vera-x', 'cassette.jsonl'), 'utf8');
    assert.doesNotMatch(cassette, /;base64,|sk-or-v1-testkey/);
    assert.match(cassette, /data:image\/png;sha256,[a-f0-9]{64}/);
    // The recording replays offline to the same verdict for free.
    const replay = await runDeptEvals({ goldenPath: s.golden, recordingsDir: s.rec, baselinePath: s.baseline, cassettesDir: s.cas, eventSchema: anyEvent, caseIds: ['vera-x'] });
    assert.equal(replay.cases[0].status, 'pass');
    assert.equal(replay.spendUsd, 0);
  } finally { await rm(s.dir, { recursive: true, force: true }); }
});

test('9. recorder strips reasoning and keeps request digests only', { timeout: 10000 }, async () => {
  const entries = [];
  const f = recorderFetcher(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'x', reasoning: 'hidden', reasoning_details: [{ text: 'hidden' }] } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } }), entries);
  await f('u', { body: JSON.stringify({ messages: [{ content: 'data:image/png;base64,iVBORw0KGgo=' }] }) });
  assert.equal(entries.length, 1);
  assert.match(entries[0].requestSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(entries[0].message), ['content', 'tool_calls']);
  assert.doesNotMatch(JSON.stringify(entries), /hidden|base64/);
});

test('10. CLI and runner: replay is the default, usage errors exit 2, --list works', { timeout: 20000 }, async () => {
  const lines = []; const errs = [];
  assert.equal(await cli([], { out: s => lines.push(s), err: s => errs.push(s) }), 2);
  assert.equal(await cli(['--dept', 'nobody'], { out: s => lines.push(s), err: s => errs.push(s) }), 2);
  assert.equal(await cli(['--live', '--replay', '--all'], { out: s => lines.push(s), err: s => errs.push(s) }), 2);
  assert.equal(await cli(['--list'], { out: s => lines.push(s), err: s => errs.push(s) }), 0);
  assert.match(lines.join(''), /vera-adult-sheets-wrist/);
  const s = await sandbox([veraCase()]);
  try {
    const { stdout } = await run(process.execPath, ['runner.mjs', 'dept-eval', '--all', '--golden', s.golden, '--recordings', s.rec, '--baseline', s.baseline, '--out', join(s.dir, 'out')], { cwd: kit, timeout: 15000 });
    assert.match(stdout, /MISSING/);
    const card = JSON.parse(await readFile(join(s.dir, 'out', 'scorecard.json'), 'utf8'));
    assert.equal(card.mode, 'replay-offline');
    assert.match(await readFile(join(s.dir, 'out', 'scorecard.md'), 'utf8'), /Department evals scorecard/);
  } finally { await rm(s.dir, { recursive: true, force: true }); }
});
