// Hard spend cap for live runs: polls the OpenRouter key's usage and calls onExceed once spend passes maxUsd.
// The key is only sent to OpenRouter's own /key endpoint and never logged.
export async function keyUsage(apiKey, fetchImpl = fetch) {
  const r = await fetchImpl('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!r.ok) throw new Error(`key usage check failed (HTTP ${r.status})`);
  const d = (await r.json()).data ?? {};
  if (typeof d.usage !== 'number') throw new Error('key usage check returned no usage');
  return { usage: d.usage, remaining: d.limit_remaining ?? null };
}

/** Start the guard. Throws if the starting usage cannot be read (a cap that cannot be checked is no cap). */
export async function startBudgetGuard({ apiKey, maxUsd, intervalMs = 15000, log = console.log, onExceed, fetchImpl = fetch }) {
  if (!(maxUsd > 0)) throw new Error('startBudgetGuard: maxUsd must be > 0');
  const b0 = await keyUsage(apiKey, fetchImpl);
  log(`[budget] cap $${maxUsd.toFixed(2)}; key remaining at start ${b0.remaining === null ? 'n/a' : `$${b0.remaining.toFixed(4)}`}`);
  let fired = false, last = 0;
  const check = async () => {
    try {
      const b = await keyUsage(apiKey, fetchImpl); last = b.usage - b0.usage;
      log(`[budget] spent $${last.toFixed(4)} of $${maxUsd.toFixed(2)}`);
      if (last > maxUsd && !fired) { fired = true; log(`[budget] ABORT: spent $${last.toFixed(4)} > cap $${maxUsd.toFixed(2)}`); onExceed?.(last); }
    } catch (e) { log(`[budget] check failed: ${e.message}`); }
  };
  const timer = setInterval(check, intervalMs); timer.unref?.();
  return { check, stop: () => clearInterval(timer), spent: () => last };
}
