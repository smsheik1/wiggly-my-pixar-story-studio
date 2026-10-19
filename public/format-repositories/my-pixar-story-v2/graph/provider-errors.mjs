// Provider errors that no retry can fix (r5-dry1: "403 Key limit exceeded (total limit)" was retried 3x per agent).
// A spent key or exhausted credits stops the whole run at once with a clear message: no transient retry,
// no further attempts, no reflection fallback, and parallel siblings are aborted (graph.mjs runStop).
export const FATAL_CODE = 'PROVIDER_KEY_LIMIT';

const statusOf = (e) => Number(e?.status ?? e?.response?.status ?? e?.error?.code ?? /^\s*(\d{3})\b/.exec(String(e?.message ?? ''))?.[1]);
const KEY_LIMIT = /key limit|limit exceeded|credit|insufficient (?:funds|balance)|out of funds|quota|payment required|spending limit|billing/i;

/** True for an OpenRouter key-limit / credit-exhausted error (402, or 403 naming a key/credit limit). */
export function isFatalProviderError(e) {
  if (!e) return false;
  if (e.code === FATAL_CODE || e.fatal === true) return true;
  const s = statusOf(e), msg = String(e?.message ?? e);
  if (s === 402) return true;
  if (s === 403) return KEY_LIMIT.test(msg);
  return /\b40[23]\b/.test(msg) && KEY_LIMIT.test(msg);
}

/** Drop provider key-management URLs (they identify the key) from a message before it is logged. */
export const redactProviderMessage = (m) => String(m ?? '').replace(/https?:\/\/\S*\/keys\/\S+/gi, '<key settings>').replace(/sk-or-[\w-]+/g, '<key>');

/** The one clear message a fatal provider error turns into. */
export function fatalMessage(e) {
  return `OpenRouter key limit / credits exhausted - run stopped immediately, no retries. Raise the key's limit or add credits, then start a new run. Provider said: ${redactProviderMessage(e?.message ?? e).slice(0, 300)}`;
}

/** Error thrown when the run was stopped because a sibling hit a fatal provider error. */
export class RunStoppedError extends Error {
  constructor(reason) { super(reason || 'run stopped after a fatal provider error'); this.name = 'RunStoppedError'; this.code = FATAL_CODE; this.fatal = true; }
}
