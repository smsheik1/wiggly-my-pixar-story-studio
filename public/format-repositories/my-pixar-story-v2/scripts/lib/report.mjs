// Run recorder + HTML views: runs/<runId>/report.html and a 'v2 dry run' section inside the progress tracker.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const AGENTS = [['story-director', 'Story Director'], ['character-architect', 'Character Architect'], ['location-scout', 'Location Scout'], ['seedance-compiler', 'Seedance Compiler']];
export const defaultTrackerPath = () => process.env.WIGGLY_PROGRESS_FILE || join(homedir(), 'wiggly-progress.html');
const START = '<!-- v2-dry-run:start -->', END = '<!-- v2-dry-run:end -->';

export function createRecorder({ runId, placeholderAssets = false, onChange = () => {} }) {
  const model = { runId, status: 'running', placeholderAssets, langsmithUrl: null, startedAt: new Date().toISOString(),
    agents: Object.fromEntries(AGENTS.map(([k]) => [k, { status: 'waiting', attempts: [] }])) };
  const onEvent = (e) => {
    const a = model.agents[e.agent]; if (!a) return;
    if (e.type === 'start' || e.type === 'attempt') a.status = 'running';
    if (e.type === 'attempt') a.attempts.push({ attempt: e.attempt, input: e.input, output: null, issues: [], isValid: null, at: new Date().toISOString() });
    if (e.type === 'attempt-result') Object.assign(a.attempts.at(-1) ?? {}, { output: e.output, issues: e.issues ?? [], isValid: !!e.isValid });
    if (e.type === 'passed') a.status = 'passed';
    if (e.type === 'failed') { a.status = 'failed'; if (!a.attempts.length) a.attempts.push({ attempt: 0, input: null, output: null, issues: e.issues ?? [], isValid: false }); }
    onChange(model);
  };
  return { model, onEvent, finish: (state, url) => { model.status = state.status; model.langsmithUrl = url ?? null; model.pending = state.pendingApproval ?? [];
    for (const [k, a] of Object.entries(model.agents)) if (a.status === 'running') a.status = 'failed';
    onChange(model); } };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const show = (v, max) => { let t = typeof v === 'string' ? v : JSON.stringify(v, null, 2); if (t === undefined || v === null) t = '—'; return max && t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more chars; full in report.html)` : t; };
const COLORS = { waiting: '#555', running: '#2563eb', passed: '#16a34a', failed: '#dc2626' };
const gateText = (at) => (at.issues?.length ? at.issues.map((i) => `${i.severity === 'error' ? '✖' : '!'} [${i.code}] ${i.message}`).join('\n') : (at.isValid ? '✔ all checks passed' : '—'));

function cards(model, { max, sideBySide }) {
  return AGENTS.map(([k, label]) => {
    const a = model.agents[k];
    const ic = a.status === 'passed' ? "<span class='ic ok'>✔</span>" : a.status === 'running' ? "<span class='spin'></span>" : a.status === 'failed' ? "<span class='ic' style='color:#f87171'>✖</span>" : "<span class='ic'>·</span>";
    const atts = a.attempts.map((at) => {
      const head = `Attempt ${at.attempt}${at.isValid === true ? ' — passed' : at.isValid === false ? ' — failed' : ' — running'}`;
      const cols = [['Input', show(at.input, max)], ['Output', show(at.output, max)], ['Gate', gateText(at)]];
      const body = sideBySide ? `<div class='v2grid'>${cols.map(([h, t]) => `<div><b>${h}</b><pre>${esc(t)}</pre></div>`).join('')}</div>`
        : cols.map(([h, t]) => `<details data-k='${esc(`${model.runId}:${k}:${at.attempt}:${h}`)}'><summary>${h}</summary><pre>${esc(t)}</pre></details>`).join('');
      return `<details class='dl' data-k='${esc(`${model.runId}:${k}:${at.attempt}`)}'${sideBySide ? ' open' : ''}><summary>${esc(head)}</summary>${body}</details>`;
    }).join('');
    return `<li class='${a.status === 'running' ? 'active' : a.status === 'waiting' ? 'pending' : 'done'}'><div class='row'>${ic}<b>${label}</b><span class='tag' style='background:${COLORS[a.status]}'>${a.status}</span></div>${atts}</li>`;
  }).join('');
}
const header = (m) => `<p class='muted'>Run <b>${esc(m.runId)}</b> · status <b>${esc(m.status)}</b>${m.placeholderAssets ? " · <span class='tag' style='background:#b45309'>placeholder assets (not real images)</span>" : ''}${m.pending?.length ? ` · awaiting approval: ${esc(m.pending.join(', '))}` : ''}</p>`
  + (m.langsmithUrl ? `<p><a style='color:#9cc4ff' href='${esc(m.langsmithUrl)}'>LangSmith trace</a></p>` : "<p class='muted'>LangSmith: not traced</p>");

export function trackerSection(model) {
  const live = model.status === 'running';
  return `${START}<section id='v2-dry-run'><h1>v2 dry run</h1>${header(model)}<ul>${cards(model, { max: 20000 })}</ul>
<script>(()=>{const s=document.getElementById('v2-dry-run');s.querySelectorAll('details[data-k]').forEach(d=>{if(localStorage.getItem('v2o:'+d.dataset.k))d.open=true;d.addEventListener('toggle',()=>d.open?localStorage.setItem('v2o:'+d.dataset.k,1):localStorage.removeItem('v2o:'+d.dataset.k));});${live ? "setTimeout(()=>location.reload(),5000);" : ''}})();</script></section>${END}`;
}

/** Insert/replace the v2 section; leaves every other byte of the tracker as it was. Atomic write. */
export function upsertTracker(model, path = defaultTrackerPath()) {
  if (!existsSync(path)) return false;
  const html = readFileSync(path, 'utf8');
  const sec = trackerSection(model);
  let next;
  if (html.includes(START) && html.includes(END)) next = html.slice(0, html.indexOf(START)) + sec + html.slice(html.indexOf(END) + END.length);
  else if (html.includes('<div class="now">')) next = html.replace('<div class="now">', `${sec}\n<div class="now">`);
  else next = html.replace('</body>', `${sec}</body>`);
  writeFileSync(`${path}.tmp`, next); renameSync(`${path}.tmp`, path);
  return true;
}

export function reportHtml(model) {
  return `<!doctype html><html><head><meta charset='utf-8'><title>v2 run ${esc(model.runId)}</title><style>body{background:#111;color:#ddd;font-family:-apple-system,Helvetica,sans-serif;max-width:1400px;margin:30px auto;padding:0 20px}
h1{color:#fff;font-size:22px}ul{list-style:none;padding:0}li{padding:10px;margin:8px 0;border-radius:10px;background:#161b22}.row{display:flex;align-items:center;gap:10px;font-size:19px}.ic{width:22px;text-align:center}.ok{color:#4ade80}
.tag{color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;text-transform:uppercase}.muted{color:#888}.dl summary{cursor:pointer;color:#9cc4ff;margin:6px 0}
.v2grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}.v2grid pre{white-space:pre-wrap;word-break:break-word;font-size:12px;background:#0b0f16;padding:10px;border-radius:8px;max-height:600px;overflow:auto}.spin{width:14px;height:14px;border:3px solid #444;border-top-color:#2563eb;border-radius:50%;display:inline-block}</style></head><body>
<h1>v2 run report</h1>${header(model)}<ul>${cards(model, { sideBySide: true })}</ul></body></html>`;
}
