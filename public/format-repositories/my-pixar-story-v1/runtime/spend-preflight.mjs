// r5: the OpenRouter key carried its own spend limit that nobody knew about.
// Before a run and before each paid step, read the key's remaining limit
// (GET /api/v1/key, a free metadata lookup that needs no user permission) and
// pause cleanly with a blocker instead of failing mid-call.
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readOpenRouterKey } from './openrouter-host.mjs';

export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
export const DEFAULT_SPEND_FLOOR_USD = 0.25;

export function spendFloorUsd(env = process.env) {
  const n = Number(env.WIGGLY_SPEND_FLOOR_USD);
  return Number.isFinite(n) && n >= 0 && env.WIGGLY_SPEND_FLOOR_USD !== undefined && env.WIGGLY_SPEND_FLOOR_USD !== '' ? n : DEFAULT_SPEND_FLOOR_USD;
}

// Returns {ok, remainingUsd, limitUsd, requiredUsd, reason?, blocker?}. Never throws on
// a lookup failure: an unreadable limit is recorded as a warning, not a block.
export async function checkSpendPreflight({ secretsPath, key, estimatedCostUsd = 0, floorUsd = spendFloorUsd(), step = 'run', fetcher = fetch } = {}) {
  const apiKey = key ?? await readOpenRouterKey(secretsPath);
  let body;
  try {
    const response = await fetcher(OPENROUTER_KEY_URL, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return { ok: true, checked: false, step, warning: `OpenRouter key lookup returned HTTP ${response.status}; limit not verified.` };
    body = await response.json();
  } catch (e) {
    return { ok: true, checked: false, step, warning: `OpenRouter key lookup failed (${String(e?.message ?? e).replaceAll(apiKey, '[redacted]').slice(0, 200)}); limit not verified.` };
  }
  const data = body?.data ?? {};
  const limitUsd = typeof data.limit === 'number' ? data.limit : null;
  const remainingUsd = typeof data.limit_remaining === 'number' ? data.limit_remaining : (limitUsd == null ? null : limitUsd - (Number(data.usage) || 0));
  const estimate = Math.max(0, Number(estimatedCostUsd) || 0);
  const requiredUsd = Math.max(estimate, floorUsd);
  if (remainingUsd == null) return { ok: true, checked: true, step, limitUsd: null, remainingUsd: null, requiredUsd, unlimited: true };
  if (remainingUsd + 1e-9 < requiredUsd) {
    const reason = remainingUsd + 1e-9 < estimate ? 'below-step-estimate' : 'below-floor';
    const blocker = {
      kind: 'spend-preflight', step, reason, remainingUsd, limitUsd, estimatedCostUsd: estimate, floorUsd,
      problem: `OpenRouter key has $${remainingUsd.toFixed(2)} left of its $${limitUsd?.toFixed(2) ?? '?'} limit; ${step} needs at least $${requiredUsd.toFixed(2)} (${reason === 'below-step-estimate' ? 'step estimate' : 'safety floor'}).`,
      solution: 'Raise the key limit at https://openrouter.ai/settings/keys (or lower WIGGLY_SPEND_FLOOR_USD), then resume the run. Nothing was submitted.',
    };
    return { ok: false, checked: true, step, limitUsd, remainingUsd, requiredUsd, reason, blocker };
  }
  return { ok: true, checked: true, step, limitUsd, remainingUsd, requiredUsd };
}

// Record a spend blocker where the progress page and the operator look: a
// blocker file plus one line in the run's event log.
export async function recordSpendBlocker(runDir, blocker, now = new Date()) {
  const entry = { at: now.toISOString(), type: 'blocker', ...blocker };
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'spend-blocker.json'), JSON.stringify(entry, null, 2), { mode: 0o600 });
  await appendFile(join(runDir, 'events.log'), JSON.stringify(entry) + '\n', { mode: 0o600 });
  return entry;
}

export class SpendPreflightBlocked extends Error {
  constructor(blocker) { super(`SPEND_PREFLIGHT_BLOCKED: ${blocker.problem} ${blocker.solution}`); this.code = 'SPEND_PREFLIGHT_BLOCKED'; this.blocker = blocker; }
}

// Shared runner hook: check, record and raise a clean blocker before any paid call.
export async function requireSpendHeadroom({ runDir, ...options }) {
  const result = await checkSpendPreflight(options);
  if (!result.ok) { await recordSpendBlocker(runDir, result.blocker); throw new SpendPreflightBlocked(result.blocker); }
  return result;
}
