// Liveness: per agent/attempt phase, token count, elapsed and last activity; watchdog timeouts; heartbeat text.
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';

export const DEFAULT_TIMEOUTS = { firstTokenMs: 5 * 60_000, idleMs: 3 * 60_000, stallMs: 90_000 };
const LABELS = { 'story-director': 'Story Director', 'character-architect': 'Character Architect', 'location-scout': 'Location Scout', 'seedance-compiler': 'Seedance Compiler' };
const dur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
const PHASE = { 'waiting-for-first-token': 'waiting for first token', thinking: 'thinking', writing: 'writing', 'tool-call': 'tool call', done: 'done' };

export function createLiveness({ now = Date.now, stallMs = DEFAULT_TIMEOUTS.stallMs } = {}) {
  const entries = new Map();
  const key = (agent, attempt) => `${agent}#${attempt}`;
  const L = {
    begin(agent, attempt) { const t = now(); const e = { agent, attempt, phase: 'waiting-for-first-token', tokens: 0, firstTokenAt: null, startedAt: t, lastActivity: t, active: true }; entries.set(key(agent, attempt), e); return e; },
    get: (agent, attempt) => entries.get(key(agent, attempt)),
    activity(agent, attempt, { phase, tokens = 0 } = {}) {
      const e = entries.get(key(agent, attempt)); if (!e || !e.active) return;
      const t = now(); e.lastActivity = t; if (phase) e.phase = phase; e.tokens += tokens;
      if (tokens && !e.firstTokenAt) e.firstTokenAt = t;
    },
    end(agent, attempt) { const e = entries.get(key(agent, attempt)); if (e) { e.active = false; e.phase = 'done'; } },
    active: () => [...entries.values()].filter((e) => e.active),
    status(e) { const t = now(); return { ...e, elapsedMs: t - e.startedAt, idleMs: t - e.lastActivity, stalled: t - e.lastActivity >= stallMs }; },
    line(e) {
      const s = L.status(e);
      return `${LABELS[e.agent] ?? e.agent} — attempt ${e.attempt} — ${PHASE[e.phase] ?? e.phase}… ${e.tokens.toLocaleString('en-US')} tokens · ${dur(s.elapsedMs)} · last activity ${dur(s.idleMs)} ago${s.stalled ? ' · STALLED?' : ''}`;
    },
  };
  return L;
}

/** Callback handler: maps LangChain model/tool events (inherited agent/attempt metadata) into liveness activity. */
export class LivenessHandler extends BaseCallbackHandler {
  name = 'wiggly-liveness';
  constructor(liveness) { super(); this.l = liveness; this.runs = new Map(); }
  #track(runId, parentRunId, metadata) {
    const m = metadata?.agent ? metadata : this.runs.get(parentRunId);
    if (m?.agent) this.runs.set(runId, { agent: m.agent, attempt: m.attempt });
    return this.runs.get(runId);
  }
  #act(runId, a) { const k = this.runs.get(runId); if (k) this.l.activity(k.agent, k.attempt, a); }
  handleChainStart(_c, _i, runId, parentRunId, _tags, metadata) { this.#track(runId, parentRunId, metadata); }
  handleChatModelStart(_l, _m, runId, parentRunId, _x, _tags, metadata) { this.#track(runId, parentRunId, metadata); this.#act(runId, {}); }
  handleLLMStart(_l, _p, runId, parentRunId, _x, _tags, metadata) { this.#track(runId, parentRunId, metadata); this.#act(runId, {}); }
  handleLLMNewToken(token, _idx, runId, _p, _t, fields) {
    const msg = fields?.chunk?.message;
    const ak = msg?.additional_kwargs ?? {};
    const reasoning = ak.reasoning ?? ak.reasoning_content ?? (Array.isArray(msg?.content) ? msg.content.filter((b) => b?.type === 'reasoning').map((b) => b.reasoning ?? b.text ?? '').join('') : '');
    const tool = (msg?.tool_call_chunks ?? []).length > 0;
    const phase = tool ? 'tool-call' : (reasoning && !token) ? 'thinking' : 'writing';
    this.#act(runId, { phase, tokens: (token || reasoning || tool) ? 1 : 0 });
  }
  handleToolStart(_t, _i, runId, parentRunId, _tags, metadata) { this.#track(runId, parentRunId, metadata); this.#act(runId, { phase: 'tool-call' }); }
  handleToolEnd(_o, runId) { this.#act(runId, {}); }
}

/** Run fn(signal) under a watchdog: reject if no first token within firstTokenMs or no activity for idleMs. */
export function withWatchdog(fn, { liveness, agent, attempt, firstTokenMs = DEFAULT_TIMEOUTS.firstTokenMs, idleMs = DEFAULT_TIMEOUTS.idleMs, pollMs = 1000, now = Date.now }) {
  const ac = new AbortController();
  const e = liveness.begin(agent, attempt);
  let timer;
  const dog = new Promise((_, reject) => {
    timer = setInterval(() => {
      const t = now();
      let why = null;
      if (!e.firstTokenAt && t - e.startedAt >= firstTokenMs) why = `no first token within ${Math.round(firstTokenMs / 1000)}s`;
      else if (t - e.lastActivity >= idleMs) why = `no activity for ${Math.round(idleMs / 1000)}s`;
      if (why) { clearInterval(timer); const err = new Error(`model call timed out (${why})`); err.code = 'MODEL_TIMEOUT'; ac.abort(err); reject(err); }
    }, pollMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(() => fn(ac.signal)), dog]).finally(() => { clearInterval(timer); liveness.end(agent, attempt); });
}
