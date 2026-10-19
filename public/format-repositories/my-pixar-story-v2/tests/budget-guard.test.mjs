import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBudgetGuard } from '../scripts/lib/budget.mjs';

const fakeFetch = (usages) => async (url, opt) => {
  assert.equal(url, 'https://openrouter.ai/api/v1/key'); assert.match(opt.headers.Authorization, /^Bearer test-key$/);
  const usage = usages.shift(); return { ok: true, json: async () => ({ data: { usage, limit_remaining: 10 - usage } }) };
};
test('budget guard: fires once when spend passes the cap; never logs the key', async () => {
  const logs = [], fired = [];
  const g = await startBudgetGuard({ apiKey: 'test-key', maxUsd: 2, intervalMs: 1e9, log: (m) => logs.push(m), onExceed: (s) => fired.push(s), fetchImpl: fakeFetch([1, 2.5, 3.5, 4]) });
  await g.check(); assert.deepEqual(fired, []);
  await g.check(); await g.check(); g.stop();
  assert.deepEqual(fired, [2.5]); assert.ok(logs.some((l) => /ABORT/.test(l))); assert.ok(!logs.join('\n').includes('test-key'));
});
test('budget guard: refuses to start when usage cannot be read', async () => {
  await assert.rejects(startBudgetGuard({ apiKey: 'k', maxUsd: 2, fetchImpl: async () => ({ ok: false, status: 401 }) }), /HTTP 401/);
  await assert.rejects(startBudgetGuard({ apiKey: 'k', maxUsd: 0 }), /maxUsd/);
});
