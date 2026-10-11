import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Budget, worstCaseUsd, actualUsd, DEPT_EVAL_HARD_CAP_USD, runDeptEvals } from '../evaluation/dept-evals.mjs';
import { loadStudio } from '../runtime/instructions.mjs';

const bodyFor = (maxTokens = 32000, textLen = 4000) => JSON.stringify({ model: 'x', max_tokens: maxTokens, messages: [{ role: 'user', content: 'x'.repeat(textLen) }] });
const jsonResp = (usage, status = 200) => new Response(JSON.stringify({ usage }), { status, headers: { 'content-type': 'application/json' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('1. three parallel worst-0.04 requests under a 0.10 cap all complete; peak never exceeds cap', { timeout: 20000 }, async () => {
  const b = new Budget(0.10);
  const body = bodyFor(32000, 4000);
  const worst = worstCaseUsd(body, 'deepseek/deepseek-v4.1-flash');
  assert.ok(worst > 0.03 && worst < 0.05, `worst ${worst} should be ~0.04`);
  const fake = async () => { await sleep(30); return jsonResp({ prompt_tokens: 100, completion_tokens: 100, cost: 0.005 }); };
  const f = b.wrap(fake, 'deepseek/deepseek-v4.1-flash');
  const results = await Promise.all([f('u', { body }), f('u', { body }), f('u', { body })]);
  assert.equal(results.length, 3);
  assert.ok(Math.abs(b.spent - 0.015) < 1e-9, `spent ${b.spent}`);
  assert.equal(b.reserved, 0);
  assert.equal(b.refused, 0);
  assert.ok(b.peak <= 0.10 + 1e-9, `peak ${b.peak} must never exceed the cap`);
});

test('2. worst alone exceeding the remaining cap with nothing in flight refuses immediately', { timeout: 20000 }, async () => {
  const b = new Budget(0.10);
  b.spent = 0.09;
  const body = bodyFor(32000, 4000);
  let sent = false;
  const f = b.wrap(async () => { sent = true; return jsonResp({ cost: 0.001 }); }, 'deepseek/deepseek-v4.1-flash');
  const t0 = Date.now();
  await assert.rejects(f('u', { body }), /DEPT_EVAL_CAP_REACHED/);
  assert.ok(Date.now() - t0 < 1000, 'refused immediately, no hang');
  assert.equal(sent, false);
});

test('3. throw charges worst, HTTP 500 without usage charges 0, waiters wake after each settle', { timeout: 20000 }, async () => {
  const b = new Budget(0.10);
  const body = bodyFor(32000, 4000);
  const worst = worstCaseUsd(body, 'deepseek/deepseek-v4.1-flash');
  let calls = 0;
  const fake = async () => {
    calls++;
    if (calls === 1) { await sleep(20); throw new Error('net-down'); }
    if (calls === 2) { await sleep(10); return new Response('oops', { status: 500 }); }
    await sleep(10);
    return jsonResp({ prompt_tokens: 10, completion_tokens: 10, cost: 0.002 });
  };
  const f = b.wrap(fake, 'deepseek/deepseek-v4.1-flash');
  // Third request waits (2 in flight already reserve ~0.08; third needs to wait for a settle).
  const p1 = f('u', { body }).catch(e => e);
  const p2 = f('u', { body }).catch(e => e);
  const p3 = f('u', { body }).catch(e => e);
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.ok(r1 instanceof Error && /net-down/.test(r1.message));
  assert.ok(!(r2 instanceof Error), '500 returns a response, charges 0');
  assert.ok(!(r3 instanceof Error), 'waiter wakes and completes');
  assert.ok(Math.abs(b.spent - (worst + 0 + 0.002)) < 1e-9, `spent ${b.spent} should be worst+0+0.002`);
  assert.equal(b.reserved, 0);
});

test('4. isAborted while waiting rejects with DEPT_EVAL_CASE_ABORTED, no hang', { timeout: 20000 }, async () => {
  const b = new Budget(0.10);
  const body = bodyFor(32000, 4000);
  const slow = async () => { await sleep(300); return jsonResp({ cost: 0.001 }); };
  const fSlow = b.wrap(slow, 'deepseek/deepseek-v4.1-flash');
  let aborted = false;
  const fWait = b.wrap(slow, 'deepseek/deepseek-v4.1-flash', { isAborted: () => aborted });
  const p1 = fSlow('u', { body });
  const p2 = fSlow('u', { body });
  // Fill the cap so the third must wait: 2 x ~0.04 reserved = ~0.08; third worst ~0.04 would exceed.
  await sleep(10);
  setTimeout(() => { aborted = true; }, 40);
  await assert.rejects(fWait('u', { body }), /DEPT_EVAL_CASE_ABORTED/);
  await Promise.all([p1, p2]);
  assert.equal(b.reserved, 0);
});

test('5. missing usage.cost falls back to token pricing', { timeout: 20000 }, async () => {
  const b = new Budget(0.10);
  const body = bodyFor(16000, 100);
  const f = b.wrap(async () => jsonResp({ prompt_tokens: 10000, completion_tokens: 1000 }), 'deepseek/deepseek-v4.1-flash');
  await f('u', { body });
  // deepseek fallback: (10000*0.30 + 1000*1.20)/1e6 = 0.0042
  assert.ok(Math.abs(b.spent - 0.0042) < 1e-9, `spent ${b.spent}`);
});

test('6. live runDeptEvals with cheap actuals and conservative worst cases skips nothing', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eval-settle-'));
  try {
    const golden = join(dir, 'golden.json');
    const cases = Array.from({ length: 6 }, (_, i) => ({
      id: `vera-s${i}`, dept: 'vera', priority: i + 1,
      source: { key: 'candidates:x', gate: 'review', version: 1 },
      truth: { authority: 'shaz', summary: 'synthetic truth for tests', history: [1] },
      asserts: [{ id: 'rejects', type: 'verdict', oneOf: ['rejected'], why: 't' }],
    }));
    await writeFile(golden, JSON.stringify({ version: 1, sourceRun: 'test', notes: 'synthetic', cases }));
    const rec = join(dir, 'rec');
    const baseline = join(dir, 'baseline.json');
    const cas = join(dir, 'cas');
    const secrets = join(dir, 'secrets.env');
    await writeFile(secrets, 'OPENROUTER_API_KEY=sk-or-v1-testkeytestkey123\n');
    const review = { action: 'review', review: { decision: 'rejected', checks: [{ criterion: 'style', status: 'fail', evidence: 'labels' }] } };
    const realFetch = async () => new Response(JSON.stringify({ model: 'm', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 100, completion_tokens: 100, cost: 0.002 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const execute = async (c, { fetcher }) => {
      for (let k = 0; k < 2; k++) {
        await fetcher('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', max_tokens: 32000, messages: [{ role: 'user', content: 'x'.repeat(4000) }] }) });
      }
      return { event: review, valid: true, gateAccepted: true, error: null };
    };
    const { z } = await import('zod');
    const card = await runDeptEvals({ mode: 'live', confirmSpend: true, maxUsd: 0.10, concurrency: 3, secretsPath: secrets, statesOverride: [], realFetch, execute,
      goldenPath: golden, recordingsDir: rec, baselinePath: baseline, cassettesDir: cas, eventSchema: z.any() });
    assert.deepEqual(card.cases.map(c => c.status), ['pass', 'pass', 'pass', 'pass', 'pass', 'pass'], JSON.stringify(card.cases.map(c => [c.id, c.status, c.detail])));
    assert.ok(card.spendUsd <= 0.10 + 1e-9, String(card.spendUsd));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('7. head-to-head does not skip an item whose actual remaining budget fits', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'h2h-settle-'));
  try {
    const secretsPath = join(dir, 'secrets.env');
    await writeFile(secretsPath, 'OPENROUTER_API_KEY=ISOLATED\n');
    const baseStudio = loadStudio();
    const bgBrief = { id: 'backgroundBrief:childhood-room@1', key: 'backgroundBrief:childhood-room', kind: 'backgroundBrief', version: 1, digest: 'b'.repeat(64), content: { direction: 'room', sceneIds: ['s1'], knownDetails: [], proposedDetails: [], continuityNotes: '', references: [] }, valid: true, authoredBy: 'author-brief', approvedBy: { message: 'approved' } };
    const bgPrompt = { id: 'backgroundPrompt:childhood-room@1', key: 'backgroundPrompt:childhood-room', kind: 'backgroundPrompt', version: 1, digest: 'p'.repeat(64), content: { prompt: '1980s childhood room', recipeSha256: 'r'.repeat(64), briefDigest: 'b'.repeat(64), changeSummary: 'initial' }, valid: true, authoredBy: 'author-prompt' };
    const state = { id: 'proj-h2h', step: 'backgroundPrompt', gate: 'review', locationId: 'childhood-room', sequence: 1, reviewMode: 'supervised', studio: baseStudio, artifacts: [bgBrief, bgPrompt], jobs: [], history: [], feedback: [], reviewDisagreements: 0 };
    const { taskFor } = await import('../runtime/workflow.mjs');
    const { estimateTaskCost } = await import('../evaluation/crew-head-to-head.mjs');
    void estimateTaskCost(taskFor(state), 'meta/muse-spark-1.3-contributor');
    // First item costs $0.019 (over its estimate), leaving $0.001 of a $0.02 cap:
    // enough for the second item's actual $0.0002, so it must not be 'skipped (cap)'.
    let calls = 0;
    const fetcher = async (url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      const cost = calls === 1 ? 0.019 : 0.0002;
      const { taskFor: tf } = await import('../runtime/workflow.mjs');
      const taskId = tf(state).taskId;
      const event = { taskId, actor: 'reviewer', action: 'review', artifactId: bgPrompt.id, artifactDigest: bgPrompt.digest, review: { decision: 'approved', perception: 'direct-text', modelVersion: body.model, checks: ['brief-fit', 'style', 'spatial-action', 'continuity'].map(criterion => ({ criterion, status: 'pass', evidence: 'ok', location: 'text', quotes: ['1980s childhood room'] })) } };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: body.model, usage: { prompt_tokens: 100, completion_tokens: 50, cost }, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ eventJson: JSON.stringify(event) }) } }] }) };
    };
    const { runHeadToHead } = await import('../evaluation/crew-head-to-head.mjs');
    const res = await runHeadToHead({ runDir: dir, secretsPath, outDir: join(dir, 'out'), confirmSpend: true, fetcher, stateList: [state],
      models: ['meta/muse-spark-1.3-contributor'], tasks: ['sage-prompt-review'], repeat: 2, maxUsd: 0.02 });
    assert.equal(res.results.length, 2);
    assert.equal(res.results[0].valid, true, res.results[0].gateError);
    assert.notEqual(res.results[1].status, 'skipped (cap)', JSON.stringify(res.results[1]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
