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

// A model call whose connection dropped mid-stream or failed at the network/gateway level (r5-dry4: Muse Spark calls
// cut at ~6 min with "Network connection lost"). Retried as that single call, not as a whole new attempt.
const STREAM_DROP = /network connection lost|network error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|socket hang up|fetch failed|\bterminated\b|other side closed|premature close|aborted by the server|stream (?:ended|closed) unexpectedly|\b(502|503|504|520|522|524)\b/i;
/** True for a transient network / mid-stream drop (never for a fatal key error, a timeout we raised, or our own abort). */
export function isStreamDrop(e) {
  if (!e || isFatalProviderError(e) || e.code === 'MODEL_TIMEOUT' || e.name === 'AbortError') return false;
  const text = [e.message, e.cause?.message, e.cause?.code, e.code].filter(Boolean).join(' ');
  return STREAM_DROP.test(text);
}

// ---- Single-call retry for dropped streams (r5-dry4) ----
/** Retries of ONE model call after a mid-stream / network drop, before the error reaches the attempt loop. */
export const CALL_RETRIES = 2;
const sleep = (ms, signal) => new Promise((res, rej) => { const t = setTimeout(res, ms); signal?.addEventListener?.('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true }); });
/**
 * Run one model call; when its stream drops (isStreamDrop) retry just that call up to `retries` times, with a short
 * backoff. Anything else (gate/schema problems, our own timeouts and aborts, fatal key errors) is thrown at once.
 */
export async function withCallRetry(call, { retries = CALL_RETRIES, delayMs = 2000, onRetry = () => {}, signal } = {}) {
  for (let n = 0; ; n++) {
    try { return await call(); } catch (e) {
      if (n >= retries || !isStreamDrop(e) || signal?.aborted) throw e;
      onRetry(e, n + 1);
      await sleep(delayMs * (n + 1), signal);
    }
  }
}
