// Trace audit: turns one LangSmith trace (list of runs) into a diagnostic model, Markdown and an HTML section.
// Pure functions over plain run objects so tests run on a saved fixture; fetching lives in scripts/audit-trace.mjs.
import { AGENT_SPECS, isTransient } from '../../graph/graph.mjs';
import { AGENTS } from './report.mjs';

/** OpenRouter USD per token (meta/muse-spark-1.3-contributor, 2026-10-16). Unknown models fall back to the response's own cost. */
export const PRICES = { 'meta/muse-spark-1.3-contributor': { prompt: 1e-7, cacheRead: 2e-9, completion: 2e-7 } };
const ms = (r) => (r.start_time && r.end_time ? Date.parse(z(r.end_time)) - Date.parse(z(r.start_time)) : 0);
const z = (t) => (/[zZ]|[+-]\d\d:\d\d$/.test(t) ? t : `${t}Z`);
const agentOf = (r) => r.extra?.metadata?.agent ?? (r.tags ?? []).find((t) => t.startsWith('agent:'))?.slice(6) ?? null;
const attemptOf = (r) => { const a = r.extra?.metadata?.attempt ?? (r.tags ?? []).find((t) => t.startsWith('attempt:'))?.slice(8); return a == null ? null : +a; };

/** Usage + cost of one llm run. Streaming merges double response_metadata.usage, so tokens come from usage_metadata. */
export function llmUsage(r) {
  const u = r.extra?.metadata?.usage_metadata ?? {};
  const input = u.input_tokens ?? r.prompt_tokens ?? 0, output = u.output_tokens ?? r.completion_tokens ?? 0;
  const cache = u.input_token_details?.cache_read ?? 0, reasoning = u.output_token_details?.reasoning ?? 0;
  const model = r.extra?.metadata?.ls_model_name ?? r.extra?.invocation_params?.model;
  const p = PRICES[model];
  let cost = r.total_cost ?? null;
  if (cost == null && p) cost = (input - cache) * p.prompt + cache * p.cacheRead + output * p.completion;
  if (cost == null) { const c = r.outputs?.generations?.[0]?.[0]?.message?.lc_kwargs?.response_metadata?.usage?.cost; cost = typeof c === 'number' ? c : 0; }
  return { input, output, cache, reasoning, total: input + output, cost };
}

/** Classify a failed attempt: network (transient), timeout, schema, gate, other. */
export function classifyError(msg = '') {
  if (/submit rejected by the output schema|SCHEMA_REJECTED/i.test(msg)) return 'schema';
  if (/MODEL_TIMEOUT|first token|idle for|timed out/i.test(msg)) return 'timeout';
  if (isTransient({ message: msg })) return 'network';
  return 'other';
}
const schemaIssuesFromError = (msg) => [...new Set(msg.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)))].map((message) => ({ code: 'SCHEMA_REJECTED', message }));

/** Re-run the deterministic parse + gate on an attempt's submitted output (gates run outside the traced call). */
export function replayGate(agent, output, inputs = {}, specs = AGENT_SPECS) {
  const spec = specs[agent]; if (!spec || output == null) return null;
  let out;
  try { out = spec.parse(typeof output === 'string' ? output : JSON.stringify(output)); } catch (e) {
    return { isValid: false, kind: 'schema', issues: (e.issues ?? [{ message: e.message }]).map((i) => ({ code: 'SCHEMA_REJECTED', message: `${(i.path ?? []).join('.')}: ${i.message}` })) };
  }
  try {
    const r = spec.gate(out, inputs.input, inputs.state ?? {});
    return { isValid: r.isValid, kind: 'gate', issues: (r.issues ?? []).filter((i) => i.severity === 'error').map((i) => ({ code: i.code, message: i.message })) };
  } catch (e) { return { isValid: false, kind: 'gate', issues: [{ code: 'GATE_REPLAY_FAILED', message: e.message }] }; }
}

/** Build the audit model from a trace's runs. root = the 'wiggly-v2 rehearsal' run. */
/** validationErrors (runs/<id>/outputs/state.json) are the run-time gate record; preferred over replay when given. */
export function auditTrace(runs, { specs = AGENT_SPECS, validationErrors = [] } = {}) {
  const root = runs.find((r) => !r.parent_run_id) ?? runs[0];
  const byId = new Map(runs.map((r) => [r.id, r]));
  const llms = runs.filter((r) => r.run_type === 'llm');
  const agents = Object.fromEntries(AGENTS.map(([k, label]) => [k, { label, attempts: 0, ms: 0, tokens: 0, cost: 0, llmCalls: 0, wasted: { network: 0, timeout: 0, schema: 0, gate: 0, other: 0 }, inAttemptSchemaRejects: 0, toolsBound: new Set(), toolsCalled: new Set() }]));
  let tokens = 0, cost = 0;
  const steps = [];
  for (const r of llms) {
    const u = llmUsage(r); tokens += u.total; cost += u.cost;
    const a = agents[agentOf(r)];
    if (a) { a.tokens += u.total; a.cost += u.cost; a.llmCalls++; for (const t of r.extra?.options?.tools ?? []) a.toolsBound.add(t.function?.name ?? t.name); }
    steps.push({ kind: 'llm', name: `${agentOf(r) ?? '?'} #${attemptOf(r) ?? '?'} model call`, agent: agentOf(r), attempt: attemptOf(r), ms: ms(r), tokens: u.total, input: u.input, output: u.output, reasoning: u.reasoning });
  }
  for (const r of runs.filter((x) => x.run_type === 'tool')) {
    const ag = agentOf(r); const a = agents[ag];
    if (a) a.toolsCalled.add(r.name);
    if (a && /^submit_/.test(r.name) && /SUBMISSION REJECTED/.test(JSON.stringify(r.outputs ?? ''))) a.inAttemptSchemaRejects++;
    steps.push({ kind: 'tool', name: `${ag ?? '?'} #${attemptOf(r) ?? '?'} ${r.name}`, agent: ag, attempt: attemptOf(r), ms: ms(r), tokens: 0 });
  }
  const rejected = [];
  const attemptRuns = runs.filter((r) => /^[a-z-]+ attempt \d+$/.test(r.name ?? '')).sort((x, y) => Date.parse(z(x.start_time)) - Date.parse(z(y.start_time)));
  for (const r of attemptRuns) {
    const [agent] = r.name.split(' attempt '); const a = agents[agent]; if (!a) continue;
    const attempt = +r.name.split(' attempt ')[1];
    a.attempts++; a.ms += ms(r);
    if (r.error) {
      const msg = String(r.error); const kind = classifyError(msg);
      a.wasted[kind]++;
      const issues = kind === 'schema' ? schemaIssuesFromError(msg) : [{ code: kind === 'network' ? 'NETWORK' : kind === 'timeout' ? 'MODEL_TIMEOUT' : 'AGENT_RUN_FAILED', message: msg.split('\n')[0].slice(0, 300) }];
      rejected.push({ agent, attempt, kind, issues, ms: ms(r) });
      continue;
    }
    // A returned attempt was rejected by the gate iff the same agent ran a later attempt; the last one passed
    // (or the node escalated). The gate is replayed only to recover the codes; it is current code, so a gate
    // changed since the run may disagree; that is reported instead of guessed.
    const superseded = attemptRuns.some((x) => x.name.startsWith(`${agent} attempt `) && +x.name.split(' attempt ')[1] > attempt);
    const escalated = root?.outputs?.escalations?.some?.((e) => e.agent === agent) && attempt === Math.max(...attemptRuns.filter((x) => x.name.startsWith(`${agent} attempt `)).map((x) => +x.name.split(' attempt ')[1]));
    if (!superseded && !escalated) continue;
    const rec = validationErrors.find((v) => v.node === agent && v.attempt === attempt && (v.errors ?? []).some((e) => e.code !== 'AGENT_RUN_FAILED'));
    if (rec) {
      const issues = rec.errors.filter((e) => (e.severity ?? 'error') === 'error').map((e) => ({ code: e.code, message: e.message }));
      const k = issues.every((i) => i.code === 'SCHEMA_REJECTED') ? 'schema' : 'gate';
      a.wasted[k]++; rejected.push({ agent, attempt, kind: k, issues, ms: ms(r), source: 'run' }); continue;
    }
    const g = replayGate(agent, r.outputs?.output ?? r.outputs, r.inputs ?? {}, specs);
    const kind = g && !g.isValid ? g.kind : 'gate';
    const issues = g && !g.isValid ? g.issues : [{ code: 'GATE_REPLAY_PASSED', message: 'rejected at run time, but the current gate passes this output (gate or schema changed since the run)' }];
    a.wasted[kind]++; rejected.push({ agent, attempt, kind, issues, ms: ms(r) });
  }
  for (const a of Object.values(agents)) {
    a.toolsUnused = [...a.toolsBound].filter((t) => !a.toolsCalled.has(t)).sort();
    a.toolsBound = [...a.toolsBound].sort(); a.toolsCalled = [...a.toolsCalled].sort();
    a.wastedTotal = Object.values(a.wasted).reduce((s, n) => s + n, 0);
  }
  const top = (k) => [...steps].sort((x, y) => y[k] - x[k]).slice(0, 3);
  void byId;
  return { traceId: root?.trace_id ?? root?.id, runId: (root?.tags ?? []).find((t) => t.startsWith('runId:'))?.slice(6) ?? root?.extra?.metadata?.runId ?? null,
    status: root?.status, start: root?.start_time ? z(root.start_time) : null, wallMs: ms(root ?? {}), tokens, cost, llmCalls: llms.length, agents,
    slowest: top('ms'), heaviest: top('tokens'), rejected };
}

const fmtMs = (n) => { const s = Math.round(n / 1000); return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; };
const fmtUsd = (n) => `$${n.toFixed(4)}`;
const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const W = ['network', 'timeout', 'schema', 'gate', 'other'];

export function auditMarkdown(m) {
  const L = [`# Trace audit: ${m.runId ?? m.traceId}`, '', `Trace \`${m.traceId}\` · status ${m.status} · started ${m.start}`, '',
    `**Total:** ${fmtK(m.tokens)} tokens · ${fmtUsd(m.cost)} · ${fmtMs(m.wallMs)} wall-clock · ${m.llmCalls} model calls`, '',
    '## Per agent', '', '| Agent | Attempts | Time | Tokens | Cost | Wasted (net/timeout/schema/gate/other) | In-attempt submit rejects |', '|---|---|---|---|---|---|---|'];
  for (const a of Object.values(m.agents)) L.push(`| ${a.label} | ${a.attempts} | ${fmtMs(a.ms)} | ${fmtK(a.tokens)} | ${fmtUsd(a.cost)} | ${a.wastedTotal} (${W.map((k) => a.wasted[k]).join('/')}) | ${a.inAttemptSchemaRejects} |`);
  L.push('', '## Top 3 slowest steps', '', ...m.slowest.map((s, i) => `${i + 1}. ${s.name}: ${fmtMs(s.ms)}`));
  L.push('', '## Top 3 token-heaviest steps', '', ...m.heaviest.map((s, i) => `${i + 1}. ${s.name}: ${fmtK(s.tokens)} (in ${fmtK(s.input)} / out ${fmtK(s.output)}, reasoning ${fmtK(s.reasoning)})`));
  L.push('', '## Rejected attempts', '');
  if (!m.rejected.length) L.push('None.');
  for (const r of m.rejected) { L.push(`- **${m.agents[r.agent].label} attempt ${r.attempt}** (${r.kind}, ${fmtMs(r.ms)})`); for (const i of r.issues.slice(0, 8)) L.push(`  - [${i.code}] ${i.message}`); if (r.issues.length > 8) L.push(`  - …and ${r.issues.length - 8} more`); }
  L.push('', '## Tools bound but never called', '');
  for (const a of Object.values(m.agents)) L.push(`- ${a.label}: ${a.toolsUnused.length ? a.toolsUnused.join(', ') : 'none'}`);
  L.push('', '_Gate codes come from the run\'s state.json; when missing they are re-derived by replaying the current code gate on the traced output._', '');
  return L.join('\n');
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const AUDIT_START = '<!-- v2-audit:start -->', AUDIT_END = '<!-- v2-audit:end -->';
export function auditHtml(m) {
  const row = (a) => `<tr><td>${esc(a.label)}</td><td>${a.attempts}</td><td>${fmtMs(a.ms)}</td><td>${fmtK(a.tokens)}</td><td>${fmtUsd(a.cost)}</td><td>${a.wastedTotal} (${W.map((k) => `${k} ${a.wasted[k]}`).join(', ')})</td><td>${esc(a.toolsUnused.join(', ') || 'none')}</td></tr>`;
  const rej = m.rejected.length ? m.rejected.map((r) => `<li><b>${esc(m.agents[r.agent].label)} attempt ${r.attempt}</b> (${r.kind})<ul>${r.issues.slice(0, 8).map((i) => `<li>[${esc(i.code)}] ${esc(i.message)}</li>`).join('')}</ul></li>`).join('') : '<li>None</li>';
  return `${AUDIT_START}<section id='v2-audit' style='background:#161b22;border-radius:10px;padding:12px;margin:12px 0'><h2 style='color:#fff'>Trace audit: ${esc(m.runId ?? m.traceId)}</h2>
<p><b>${fmtK(m.tokens)}</b> tokens · <b>${fmtUsd(m.cost)}</b> · <b>${fmtMs(m.wallMs)}</b> wall-clock · ${m.llmCalls} model calls</p>
<table style='border-collapse:collapse;font-size:13px' cellpadding='4'><tr><th>Agent</th><th>Attempts</th><th>Time</th><th>Tokens</th><th>Cost</th><th>Wasted</th><th>Unused tools</th></tr>${Object.values(m.agents).map(row).join('')}</table>
<p><b>Slowest:</b> ${m.slowest.map((s) => `${esc(s.name)} ${fmtMs(s.ms)}`).join(' · ')}<br><b>Token-heaviest:</b> ${m.heaviest.map((s) => `${esc(s.name)} ${fmtK(s.tokens)}`).join(' · ')}</p>
<details><summary style='cursor:pointer;color:#9cc4ff'>Rejected attempts (${m.rejected.length})</summary><ul>${rej}</ul></details></section>${AUDIT_END}`;
}

/** Insert/replace the audit section in an HTML file: after the v2 dry-run section if present, else before </body>. */
export function upsertSection(html, section, { start = AUDIT_START, end = AUDIT_END, after = '<!-- v2-dry-run:end -->' } = {}) {
  if (html.includes(start) && html.includes(end)) return html.slice(0, html.indexOf(start)) + section + html.slice(html.indexOf(end) + end.length);
  if (after && html.includes(after)) return html.replace(after, `${after}\n${section}`);
  return html.includes('</body>') ? html.replace('</body>', `${section}</body>`) : html + section;
}

/** Keep only what the audit needs (fixtures + memory); drops photo paths. */
export function slimRun(r) {
  const keepIn = /^[a-z-]+ attempt \d+$/.test(r.name ?? '');
  let inputs; if (keepIn && r.inputs) { inputs = { input: r.inputs.input, state: r.inputs.state }; if (inputs.state?.inputs?.photoReferences) inputs.state = { ...inputs.state, inputs: { ...inputs.state.inputs, photoReferences: inputs.state.inputs.photoReferences.map(({ path, ...x }) => x) } }; }
  const out = { id: r.id, trace_id: r.trace_id, parent_run_id: r.parent_run_id ?? null, name: r.name, run_type: r.run_type, status: r.status, error: r.error ?? null,
    start_time: r.start_time, end_time: r.end_time, tags: r.tags, total_tokens: r.total_tokens, prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens, total_cost: r.total_cost ?? null,
    extra: { metadata: { agent: r.extra?.metadata?.agent, attempt: r.extra?.metadata?.attempt, runId: r.extra?.metadata?.runId, ls_model_name: r.extra?.metadata?.ls_model_name, usage_metadata: r.extra?.metadata?.usage_metadata },
      ...(r.run_type === 'llm' ? { options: { tools: (r.extra?.options?.tools ?? []).map((t) => ({ function: { name: t.function?.name ?? t.name } })) } } : {}) } };
  if (inputs) out.inputs = inputs;
  if (keepIn) out.outputs = r.outputs;
  if (r.run_type === 'tool' && /^submit_/.test(r.name)) out.outputs = { output: String(JSON.stringify(r.outputs ?? '')).slice(0, 400) };
  return out;
}
