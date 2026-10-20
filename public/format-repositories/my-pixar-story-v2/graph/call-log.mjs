// Per-call usage log for OpenRouter LLM calls: one JSON line per call (step, model, effort, start/end, time to first
// token, prompt/completion/reasoning tokens, cost from OpenRouter usage accounting, generation id) in calls.jsonl, plus a
// per-step summary. Off until configureCallLog(file) is called (the run scripts do it); never records keys or prompts.
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { draftContext } from './best-of.mjs';

let sink = null;
/** Start (file path) or stop (null) logging calls. */
export function configureCallLog(file) { sink = file || null; if (sink) mkdirSync(dirname(sink), { recursive: true }); }
export const callLogFile = () => sink;

const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('') : '');
/** Which pipeline step a request is, read from its own messages (no prompt text is stored). */
export function stepOf(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const sys = text(msgs.find((m) => m.role === 'system')?.content);
  const user = msgs.filter((m) => m.role === 'user').map((m) => text(m.content)).join('\n');
  const draft = draftContext.getStore()?.draftId;
  const d = draft ? ` ${draft}` : '';
  if (/^# Beats/m.test(sys)) return 'plan';
  if (/^# Critique and rewrite the beats/m.test(sys)) return 'beats-critique';
  if (/^# Pick Winner/m.test(sys)) return 'best-of-judge';
  if (/Cold Read/i.test(sys)) return 'cold-read';
  if (/reviewing your own draft/.test(sys)) return 'review';
  if (/Your draft below failed the gate/.test(user)) return `draft${d} repair`;
  if (/^Revise your [\w-]+ draft/m.test(user)) return 'rewrite';
  if (/^You are the Wiggly v2/m.test(sys)) return `draft${d}`;
  return 'other';
}

/** Parse one SSE text chunk into the fields the log needs. */
export function sseUsage(t, acc) {
  for (const line of t.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    let j; try { j = JSON.parse(raw); } catch { continue; }
    if (j.id && !acc.generationId) acc.generationId = j.id;
    if (j.provider && !acc.provider) acc.provider = j.provider;
    const delta = j.choices?.[0]?.delta;
    if (acc.ttftMs == null && delta && (delta.content || delta.reasoning || delta.reasoning_content || delta.tool_calls?.length || delta.reasoning_details?.length)) acc.ttftMs = Date.now() - acc.t0;
    if (j.usage) acc.usage = j.usage;
  }
  return acc;
}

/** Wraps an OpenRouter streaming response: logs one line when the stream ends. */
export function logCall({ agent, body, res, t0 = Date.now() }) {
  if (!sink) return res;
  const acc = { t0, ttftMs: null, usage: null, generationId: null, provider: null };
  const base = { agent, step: stepOf(body), model: body?.model ?? null, effort: body?.reasoning?.effort ?? body?.reasoning_effort ?? null };
  const dec = new TextDecoder();
  const write = (extra = {}) => {
    const u = acc.usage ?? {};
    const line = { ...base, start: new Date(acc.t0).toISOString(), end: new Date().toISOString(), seconds: Math.round((Date.now() - acc.t0) / 100) / 10,
      ttftMs: acc.ttftMs, promptTokens: u.prompt_tokens ?? null, completionTokens: u.completion_tokens ?? null,
      reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? null, cachedTokens: u.prompt_tokens_details?.cached_tokens ?? null,
      costUsd: u.cost ?? null, generationId: acc.generationId, provider: acc.provider, status: res.status, ...extra };
    try { appendFileSync(sink, JSON.stringify(line) + '\n'); } catch { /* logging never breaks a call */ }
  };
  if (!res.body) { write(); return res; }
  let done = false;
  const tap = new TransformStream({
    transform(chunk, ctl) { try { sseUsage(dec.decode(chunk, { stream: true }), acc); } catch { /* ignore */ } ctl.enqueue(chunk); },
    flush() { if (!done) { done = true; write(); } },
  });
  return new Response(res.body.pipeThrough(tap), { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Per-step totals from a calls.jsonl file: [{ step, calls, seconds, promptTokens, completionTokens, reasoningTokens, costUsd }]. */
export function summarizeCalls(file = sink) {
  if (!file || !existsSync(file)) return [];
  const by = new Map();
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let c; try { c = JSON.parse(l); } catch { continue; }
    const k = c.step.replace(/ [ABC]( repair)?$/, '$1');
    const s = by.get(k) ?? { step: k, calls: 0, seconds: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0, models: new Set() };
    s.calls++; s.seconds += c.seconds ?? 0; s.promptTokens += c.promptTokens ?? 0; s.completionTokens += c.completionTokens ?? 0;
    s.reasoningTokens += c.reasoningTokens ?? 0; s.costUsd += c.costUsd ?? 0; if (c.model) s.models.add(c.model);
    by.set(k, s);
  }
  return [...by.values()].map((s) => ({ ...s, seconds: Math.round(s.seconds * 10) / 10, costUsd: Math.round(s.costUsd * 1e6) / 1e6, models: [...s.models] }));
}
