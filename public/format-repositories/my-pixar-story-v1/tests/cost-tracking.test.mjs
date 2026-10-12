// P20: every paid call carries its cost where LangSmith reads it (usage_metadata.total_cost).
// Fake client only: no network, no LangSmith, no codex app-server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTracer, paidJobCost, paidJobTimer } from '../runtime/tracing.mjs';
import { OpenRouterHost, DEFAULT_OPENROUTER_MODEL } from '../runtime/openrouter-host.mjs';

async function env() {
  const dir = await mkdtemp(join(tmpdir(), 'cost-test-'));
  const secretsPath = join(dir, 'secrets.env');
  await writeFile(secretsPath, 'OPENROUTER_API_KEY=test-openrouter-key-123\n');
  return { dir, secretsPath };
}
async function withTracer(opts, fn) {
  const { dir, secretsPath } = await env();
  const fake = { captured: [] };
  const tracer = await createTracer({ secretsPath, runId: 'cost', runDir: dir, client: fake, ...opts });
  try { return await fn(tracer, fake, dir, secretsPath); } finally { await tracer.flush(); await rm(dir, { recursive: true, force: true }); }
}
const ends = (fake, phase) => fake.captured.filter((r) => r.phase === phase);

test('paid job: billed provider amount lands in usage_metadata.total_cost', { timeout: 10000 }, async () => {
  await withTracer({}, async (tracer, fake) => {
    paidJobTimer(tracer, { provider: 'openrouter-decisions', model: 'm', estimatedCostUsd: 0.002, actualCostSource: 'provider' }).ok({ actualCostUsd: 0.00123, actualCostSource: 'provider' });
    const [e] = ends(fake, 'paid-job-end');
    assert.equal(e.usage_metadata.total_cost, 0.00123);
    assert.equal(e.cost_source, 'billed');
  });
});

test('paid job: falls back to the studio rate already in the code, labelled as an estimate', { timeout: 10000 }, async () => {
  await withTracer({}, async (tracer, fake) => {
    paidJobTimer(tracer, { provider: 'meta-muse', estimatedCostUsd: 0.04, actualCostUsd: 0.04, actualCostSource: 'estimate' }).ok();
    paidJobTimer(tracer, { provider: 'x', estimatedCostUsd: 0.5 }).ok();
    const [a, b] = ends(fake, 'paid-job-end');
    assert.equal(a.usage_metadata.total_cost, 0.04); assert.equal(a.cost_source, 'rate-estimate');
    assert.equal(b.usage_metadata.total_cost, 0.5); assert.equal(b.cost_source, 'rate-estimate');
  });
});

test('paid job: free tier records an explicit 0 with a note', { timeout: 10000 }, async () => {
  await withTracer({}, async (tracer, fake) => {
    paidJobTimer(tracer, { provider: 'agy', estimatedCostUsd: 0, actualCostUsd: 0, actualCostSource: 'free' }).ok();
    const [e] = ends(fake, 'paid-job-end');
    assert.equal(e.usage_metadata.total_cost, 0); assert.equal(e.cost_note, 'free tier');
  });
});

test('paid job: no billed amount and no rate => no cost, cost_unknown (never an invented rate)', { timeout: 10000 }, async () => {
  await withTracer({}, async (tracer, fake) => {
    paidJobTimer(tracer, { provider: 'mystery', model: 'z' }).ok();
    const [e] = ends(fake, 'paid-job-end');
    assert.equal(e.usage_metadata, undefined);
    assert.equal(e.cost_unknown, true);
    assert.match(e.cost_note, /cost unknown for mystery\/z/);
  });
  assert.deepEqual(paidJobCost({ outcome: 'provider-error', estimatedCostUsd: 1 }), { cost_note: 'failed request; no cost recorded' });
});

test('replay mode: recorded cost is reported as 0 and kept as recorded_cost_usd', { timeout: 10000 }, async () => {
  await withTracer({ metadata: { mode: 'replay' } }, async (tracer, fake) => {
    const h = tracer.llm({ model: 'm' });
    h.end({ usage_metadata: { input_tokens: 10, output_tokens: 5, total_cost: 0.0045 } });
    paidJobTimer(tracer, { provider: 'openrouter-decisions', actualCostSource: 'provider' }).ok({ actualCostUsd: 0.002, actualCostSource: 'provider' });
    const [l] = ends(fake, 'llm-end');
    assert.equal(l.usage_metadata.total_cost, 0); assert.equal(l.recorded_cost_usd, 0.0045); assert.equal(l.usage_metadata.input_tokens, 10);
    const [p] = ends(fake, 'paid-job-end');
    assert.equal(p.usage_metadata.total_cost, 0); assert.equal(p.recorded_cost_usd, 0.002);
  });
});

test('cost survives trace-budget stripping', { timeout: 10000 }, async () => {
  await withTracer({ limits: { maxRunBytes: 10 } }, async (tracer, fake) => {
    paidJobTimer(tracer, { provider: 'meta-muse', estimatedCostUsd: 0.04, actualCostUsd: 0.04, actualCostSource: 'estimate', big: 'x'.repeat(5000) }).ok();
    const [e] = ends(fake, 'paid-job-end');
    assert.equal(e.budgetExhausted, true);
    assert.equal(e.usage_metadata.total_cost, 0.04);
  });
});

function host(dir, secretsPath, tracer, usage) {
  return new OpenRouterHost({
    cwd: dir, secretsPath, model: DEFAULT_OPENROUTER_MODEL, tracer,
    fetcher: async (url, init) => {
      let taskId = 't';
      try { const b = JSON.parse(init.body); const m = b.messages?.at(-1); taskId = JSON.parse(typeof m.content === 'string' ? m.content : m.content[0].text).task?.taskId ?? taskId; } catch {}
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'gen-1', usage, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ eventJson: JSON.stringify({ taskId, actor: 'reviewer', action: 'review', review: { perception: 'direct-image', decision: 'approved', checks: [] } }) }) } }] }) };
    },
  });
}

test('OpenRouter llm: billed usage.cost on the llm run only (parent turn carries no usage_metadata)', { timeout: 10000 }, async () => {
  await withTracer({}, async (tracer, fake, dir, secretsPath) => {
    const h = host(dir, secretsPath, tracer, { prompt_tokens: 100, completion_tokens: 20, cost: 0.0007 });
    const cap = await h.profile();
    const worker = { workerId: 'w', name: 'Vera', role: 'visual-reviewer', modelVersion: DEFAULT_OPENROUTER_MODEL, capabilityVersion: cap, backend: 'openrouter' };
    await h.runTask({ taskId: 'task-1', step: 'sheet', gate: 'review', crewWorker: worker, artifact: { id: 'a', content: {} } }, { worker, callTool: async () => {} });
    await tracer.flush();
    const llm = ends(fake, 'llm-end');
    assert.ok(llm.length >= 1);
    assert.equal(llm[0].usage_metadata.total_cost, 0.0007);
    assert.equal(llm[0].cost_source, 'billed');
    const parents = fake.captured.filter((r) => /^(crew-turn|agent-call)-end$/.test(r.phase));
    for (const p of parents) assert.equal(p.usage_metadata?.total_cost ?? null, null, `${p.phase} must not double count`);
  });
});

test('OpenRouter llm: missing usage.cost => no total_cost and cost_unknown (not a silent 0)', { timeout: 10000 }, async () => {
  await withTracer({}, async (tracer, fake, dir, secretsPath) => {
    const h = host(dir, secretsPath, tracer, { prompt_tokens: 100, completion_tokens: 20 });
    const cap = await h.profile();
    const worker = { workerId: 'w', name: 'Vera', role: 'visual-reviewer', modelVersion: DEFAULT_OPENROUTER_MODEL, capabilityVersion: cap, backend: 'openrouter' };
    await h.runTask({ taskId: 'task-2', step: 'sheet', gate: 'review', crewWorker: worker, artifact: { id: 'a', content: {} } }, { worker, callTool: async () => {} });
    await tracer.flush();
    const [l] = ends(fake, 'llm-end');
    assert.equal(l.usage_metadata.total_cost, undefined);
    assert.equal(l.usage_metadata.input_tokens, 100);
    assert.equal(l.cost_unknown, true);
  });
});
