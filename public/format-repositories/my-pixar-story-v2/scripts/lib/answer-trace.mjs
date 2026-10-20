// Answer tracing: prove the maker's real story survives the pipeline.
// Step 1 extracts concrete facts from the questionnaire answers (one Muse call,
// cached); step 2 judges what each agent did with every fact (one call per
// agent output); step 3 builds a pure model + Markdown/HTML report.
// All model calls go through museCall (OpenCode CLI); tests inject a fake.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { extractJson, RETRY_SUFFIX, museCall as realMuseCall } from './muse-opencode.mjs';
import { inputsFromProject } from '../run-rehearsal.mjs';

export const TRACE_AGENTS = [
  ['story-director', 'Story Director'],
  ['character-architect', 'Character Architect'],
  ['location-scout', 'Location Scout'],
  ['seedance-compiler', 'Seedance Compiler'],
];
export const AGENT_LABEL = Object.fromEntries(TRACE_AGENTS);
// Facts outside an agent's kinds are reported n/a instead of dropped. null = all kinds.
export const EXPECTED_KINDS = {
  'story-director': null,
  'character-architect': ['person', 'age', 'trait', 'relationship', 'object'],
  'location-scout': ['place', 'object', 'event'],
  'seedance-compiler': null,
};
export const TRACE_START = '<!-- v2-answer-trace:start -->';
export const TRACE_END = '<!-- v2-answer-trace:end -->';
const MAX_OUTPUT_BYTES = 60 * 1024;

/** Stable stringify (sorted keys) so the cache key is order-independent. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export const answersSha = (answers) => createHash('sha256').update(canonicalJson(answers)).digest('hex');

const stripPaths = (refs) => (refs ?? []).map(({ path, ...r }) => r);

/** Answers object traced: .answers, .subject, .castDescriptions, .photoReferences[] minus paths. */
export function answersFromInputs(inputs) {
  const a = { answers: inputs.answers ?? {}, subject: inputs.subject ?? '' };
  if (inputs.castDescriptions !== undefined) a.castDescriptions = inputs.castDescriptions;
  if (inputs.photoReferences !== undefined) a.photoReferences = stripPaths(inputs.photoReferences).map(({ photoNote, ...r }) => r); // photo file notes (IMG names, rotation) are not story facts
  return a;
}

export function answersFromProject(project) {
  return answersFromInputs(inputsFromProject(project));
}

/** Accepts a benchmark inputs.json (has .answers) or a studio project json. */
export async function loadAnswersFile(file) {
  const obj = JSON.parse(await readFile(file, 'utf8'));
  if (obj && typeof obj === 'object' && obj.answers && typeof obj.answers === 'object') {
    return answersFromInputs(obj);
  }
  return answersFromProject(obj);
}

export function extractionPrompt(answers) {
  return `Extract every concrete, checkable fact from these questionnaire answers about the maker's real story.

Rules:
- Only concrete, checkable facts (a named person, age, event, object, place, quote, number, relationship, trait, date). One fact per item.
- Keep verbatim quotes verbatim in the "quote" field.
- No interpretation, no themes, no invented connections.
- "id" is F1, F2, ... in order. "kind" is one of: person|age|event|object|place|quote|relationship|trait|date.
- "source" is the answers key path the fact came from (e.g. "scene1Childhood.memory").

Reply with JSON only: { "facts": [{ "id": "F1", "kind": "person", "text": "...", "source": "...", "quote": "<verbatim words>" }] }

ANSWERS:
${JSON.stringify(answers, null, 2)}`;
}

const STRIP_KEYS = new Set(['htmlScriptDocument', 'compiledPrompt', 'generationPayload']);

function truncateStrings(node) {
  const walk = (n) => {
    if (Array.isArray(n)) {
      for (let i = 0; i < n.length; i++) {
        if (typeof n[i] === 'string' && n[i].length > 800) n[i] = `${n[i].slice(0, 800)}…(truncated)`;
        else if (n[i] && typeof n[i] === 'object') walk(n[i]);
      }
    } else if (n && typeof n === 'object') {
      for (const k of Object.keys(n)) {
        if (typeof n[k] === 'string' && n[k].length > 800) n[k] = `${n[k].slice(0, 800)}…(truncated)`;
        else if (n[k] && typeof n[k] === 'object') walk(n[k]);
      }
    }
  };
  walk(node);
}

/** Drop obviously non-story fields (template boilerplate is fine to keep); cap at ~60 KB. */
export function prepareOutput(output) {
  const stripped = {};
  for (const [k, v] of Object.entries(output ?? {})) {
    if (STRIP_KEYS.has(k) || /asset/i.test(k)) continue;
    stripped[k] = v;
  }
  const clean = JSON.parse(JSON.stringify(stripped));
  if (Buffer.byteLength(JSON.stringify(clean), 'utf8') > MAX_OUTPUT_BYTES) truncateStrings(clean);
  return clean;
}

export function judgePrompt({ agent, facts, output }) {
  const kinds = EXPECTED_KINDS[agent];
  return `Judge how faithfully the ${agent} agent carried the maker's real story facts into its output.

Definitions:
- kept = the fact is present with the same meaning.
- changed = the fact is present but altered (age, name, place, wording of a quote, order of events).
- dropped = the fact is absent.
- invented = a specific story detail (named person, event, object, place, quote, number) present in the output with no source fact. Generic staging (camera, lighting, wardrobe colour) is NOT invented.
${
  kinds
    ? `Note: this agent is only expected to carry these kinds: ${kinds.join(', ')}. Assess every fact below honestly anyway.`
    : 'This agent should carry every fact below.'
}
Reply with JSON only: { "facts": [{ "id": "F1", "status": "kept|changed|dropped", "evidence": "<short quote from the output or ''>", "note": "<optional>" }], "invented": [{ "detail": "...", "evidence": "...", "severity": "minor|major" }] }

FACTS:
${JSON.stringify(facts, null, 2)}

AGENT OUTPUT:
${JSON.stringify(output, null, 2)}`;
}

const FactItem = z.object({ id: z.string().min(1), kind: z.string().min(1), text: z.string().min(1) }).passthrough();
const ExtractionReply = z.object({ facts: z.array(z.unknown()) }).passthrough();

/** Validate with Zod; drop items missing id/kind/text; dedupe by normalized text. */
export function parseFacts(reply) {
  const data = ExtractionReply.parse(reply);
  const seen = new Set();
  const facts = [];
  for (const item of data.facts) {
    const r = FactItem.safeParse(item);
    if (!r.success) continue;
    const norm = r.data.text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(norm)) continue;
    seen.add(norm);
    facts.push({
      id: r.data.id,
      kind: r.data.kind,
      text: r.data.text,
      ...(typeof r.data.source === 'string' && r.data.source ? { source: r.data.source } : {}),
      ...(typeof r.data.quote === 'string' && r.data.quote ? { quote: r.data.quote } : {}),
    });
  }
  return facts;
}

const JudgeFactItem = z.object({ id: z.string().min(1), status: z.enum(['kept', 'changed', 'dropped']) }).passthrough();
const InventedItem = z.object({ detail: z.string().min(1) }).passthrough();
const JudgeReply = z.object({ facts: z.array(z.unknown()), invented: z.array(z.unknown()).optional() }).passthrough();

/** Missing fact ids become unknown; dropped facts outside expectedKinds become n/a. */
export function parseJudgement(agent, facts, reply) {
  const data = JudgeReply.parse(reply);
  const byId = new Map();
  for (const item of data.facts) {
    const r = JudgeFactItem.safeParse(item);
    if (r.success && !byId.has(r.data.id)) byId.set(r.data.id, r.data);
  }
  const expected = EXPECTED_KINDS[agent];
  const results = facts.map((f) => {
    const hit = byId.get(f.id);
    let status = hit ? hit.status : 'unknown';
    if (status === 'dropped' && expected && !expected.includes(f.kind)) status = 'n/a';
    return {
      id: f.id,
      kind: f.kind,
      status,
      evidence: typeof hit?.evidence === 'string' ? hit.evidence : '',
      ...(typeof hit?.note === 'string' && hit.note ? { note: hit.note } : {}),
    };
  });
  const invented = [];
  for (const item of data.invented ?? []) {
    const r = InventedItem.safeParse(item);
    if (!r.success) continue;
    invented.push({
      detail: r.data.detail,
      evidence: typeof r.data.evidence === 'string' ? r.data.evidence : '',
      severity: r.data.severity === 'major' ? 'major' : 'minor',
    });
  }
  invented.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'major' ? -1 : 1));
  return { results, invented };
}

async function callJson(prompt, museCall) {
  // museCall itself retries once on parse failure; this retry covers injected fakes in tests.
  // Only parse errors retry here: a museCall throw propagates immediately.
  let text = await museCall(prompt);
  try {
    return { reply: extractJson(text), calls: 1 };
  } catch {
    text = await museCall(`${prompt}\n${RETRY_SUFFIX}`);
    return { reply: extractJson(text), calls: 2 };
  }
}

/** Step 1: one Muse call per answers file, cached by sha256 of the canonical answers JSON. */
export async function extractFacts({ answers, cacheDir = '.cache/answer-facts', museCall = realMuseCall, log = () => {} }) {
  const sha = answersSha(answers);
  const cacheFile = join(cacheDir, `${sha}.json`);
  if (existsSync(cacheFile)) {
    return { facts: JSON.parse(await readFile(cacheFile, 'utf8')), cached: true, sha, calls: 0 };
  }
  const prompt = extractionPrompt(answers);
  const t0 = Date.now();
  const { reply, calls } = await callJson(prompt, museCall);
  const facts = parseFacts(reply);
  log(`extraction: ${facts.length} facts in ${Date.now() - t0}ms`);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFile, JSON.stringify(facts, null, 2), 'utf8');
  return { facts, cached: false, sha, calls, promptChars: prompt.length };
}

/** Step 2: one Muse call for one agent's output. */
export async function judgeAgent({ agent, facts, output, museCall = realMuseCall, log = () => {} }) {
  const prepared = prepareOutput(output);
  const prompt = judgePrompt({ agent, facts, output: prepared });
  const t0 = Date.now();
  const { reply, calls } = await callJson(prompt, museCall);
  const { results, invented } = parseJudgement(agent, facts, reply);
  log(`${agent}: ${results.length} facts judged in ${Date.now() - t0}ms`);
  return { agent, results, invented, calls, promptChars: prompt.length };
}

const faithfulnessOf = (counts) => {
  const denom = counts.kept + counts.changed + counts.dropped;
  return denom ? Number((counts.kept / denom).toFixed(3)) : null;
};

/** Step 3 (pure): judgements -> model. */
export function traceAnswers({ facts, judgements }) {
  const agents = {};
  for (const [agent, j] of Object.entries(judgements ?? {})) {
    const counts = { kept: 0, changed: 0, dropped: 0, na: 0, unknown: 0 };
    for (const r of j.results ?? []) {
      if (r.status === 'n/a') counts.na++;
      else if (r.status === 'kept' || r.status === 'changed' || r.status === 'dropped') counts[r.status]++;
      else counts.unknown++;
    }
    agents[agent] = { counts, faithfulness: faithfulnessOf(counts), invented: [...(j.invented ?? [])] };
  }
  const rows = (facts ?? []).map((f) => ({
    id: f.id,
    kind: f.kind,
    text: f.text,
    statuses: Object.fromEntries(
      Object.entries(judgements ?? {}).map(([a, j]) => [a, j.results?.find((r) => r.id === f.id)?.status ?? 'unknown']),
    ),
  }));
  const sc = judgements?.['seedance-compiler'];
  const sd = judgements?.['story-director'];
  // What reaches the film: SC when judged, else SD.
  const storyFaithfulness = sc ? agents['seedance-compiler'].faithfulness : sd ? agents['story-director'].faithfulness : null;
  const lostDownstream = rows
    .filter(
      (f) =>
        f.statuses['story-director'] === 'kept' &&
        sc &&
        f.statuses['seedance-compiler'] !== 'kept' &&
        f.statuses['seedance-compiler'] !== 'n/a',
    )
    .map((f) => f.id);
  return { facts: rows, agents, storyFaithfulness, lostDownstream };
}

const SYM = { kept: '✔', changed: '~', dropped: '✖', 'n/a': '·', unknown: '?' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Step 3 (pure): model -> Markdown report. */
export function answerTraceMarkdown(model) {
  const L = ['# Answer trace', ''];
  L.push(`storyFaithfulness: ${model.storyFaithfulness ?? 'n/a'} (what reaches the film)`, '');
  L.push('| Agent | Kept | Changed | Dropped | n/a | Unknown | Faithfulness |', '|---|---|---|---|---|---|---|');
  for (const [agent] of TRACE_AGENTS) {
    const a = model.agents?.[agent];
    if (!a) continue;
    L.push(`| ${agent} | ${a.counts.kept} | ${a.counts.changed} | ${a.counts.dropped} | ${a.counts.na} | ${a.counts.unknown} | ${a.faithfulness ?? 'n/a'} |`);
  }
  L.push('', '## Facts', '');
  L.push(`| ID | Kind | Fact | ${TRACE_AGENTS.map(([a]) => a).join(' | ')} |`);
  L.push('|---|---|---|---|---|---|---|');
  for (const f of model.facts ?? []) {
    const cells = TRACE_AGENTS.map(([a]) => `${SYM[f.statuses[a] ?? 'unknown']} ${f.statuses[a] ?? 'unknown'}`);
    L.push(`| ${f.id} | ${f.kind} | ${f.text} | ${cells.join(' | ')} |`);
  }
  L.push('');
  if ((model.lostDownstream ?? []).length) {
    L.push('## Lost downstream (kept by Story Director, lost by Seedance Compiler)', '');
    for (const id of model.lostDownstream) {
      const f = model.facts.find((x) => x.id === id);
      L.push(`- ${id}: ${f?.text ?? ''}`);
    }
    L.push('');
  }
  L.push('## Invented details', '');
  for (const [agent] of TRACE_AGENTS) {
    const inv = model.agents?.[agent]?.invented ?? [];
    if (!inv.length) continue;
    L.push(`### ${agent}`, '');
    for (const d of inv) L.push(`- [${d.severity}] ${d.detail}${d.evidence ? ` — "${d.evidence}"` : ''}`);
    L.push('');
  }
  return L.join('\n');
}

/** Step 3 (pure): model -> HTML section (insert with upsertSection). */
export function answerTraceHtml(model) {
  const agentRows = TRACE_AGENTS.filter(([a]) => model.agents?.[a])
    .map(([a, label]) => {
      const g = model.agents[a];
      return `<tr><td>${esc(label)}</td><td>${g.counts.kept}</td><td>${g.counts.changed}</td><td>${g.counts.dropped}</td><td>${g.counts.na}</td><td>${g.counts.unknown}</td><td>${g.faithfulness ?? 'n/a'}</td></tr>`;
    })
    .join('');
  const factRows = (model.facts ?? [])
    .map((f) => {
      const cells = TRACE_AGENTS.map(([a]) => {
        const s = f.statuses[a] ?? 'unknown';
        return `<td title="${esc(s)}">${SYM[s] ?? '?'}</td>`;
      }).join('');
      return `<tr><td>${esc(f.id)}</td><td>${esc(f.kind)}</td><td>${esc(f.text)}</td>${cells}</tr>`;
    })
    .join('');
  const lost = (model.lostDownstream ?? [])
    .map((id) => {
      const f = model.facts.find((x) => x.id === id);
      return `<li>${esc(id)}: ${esc(f?.text ?? '')}</li>`;
    })
    .join('');
  const invented = TRACE_AGENTS.map(([a, label]) => {
    const inv = model.agents?.[a]?.invented ?? [];
    if (!inv.length) return '';
    return `<h3>${esc(label)}</h3><ul>${inv.map((d) => `<li>[${d.severity}] ${esc(d.detail)}${d.evidence ? ` — &ldquo;${esc(d.evidence)}&rdquo;` : ''}</li>`).join('')}</ul>`;
  }).join('');
  return `${TRACE_START}<section id='v2-answer-trace' style='background:#161b22;border-radius:10px;padding:12px;margin:12px 0'><h2 style='color:#fff'>Answer trace: storyFaithfulness ${model.storyFaithfulness ?? 'n/a'}</h2>
<table style='border-collapse:collapse;font-size:13px' cellpadding='4'><tr><th>Agent</th><th>Kept</th><th>Changed</th><th>Dropped</th><th>n/a</th><th>Unknown</th><th>Faithfulness</th></tr>${agentRows}</table>
<table style='border-collapse:collapse;font-size:13px' cellpadding='4'><tr><th>ID</th><th>Kind</th><th>Fact</th>${TRACE_AGENTS.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr>${factRows}</table>
${lost ? `<p><b>Lost downstream:</b></p><ul>${lost}</ul>` : ''}
${invented}</section>${TRACE_END}`;
}

const TOKENS = (chars) => Math.ceil(chars / 4);

/** Orchestrate steps 1-3. dryRun reports calls + prompt sizes without calling. */
export async function traceRun({
  answers,
  outputs,
  cacheDir = '.cache/answer-facts',
  museCall = realMuseCall,
  dryRun = false,
  log = () => {},
}) {
  const present = TRACE_AGENTS.map(([a]) => a).filter((a) => outputs?.[a] != null);
  if (dryRun) {
    const calls = [];
    const sha = answersSha(answers);
    let facts = [];
    let estimated = false;
    if (existsSync(join(cacheDir, `${sha}.json`))) {
      facts = JSON.parse(await readFile(join(cacheDir, `${sha}.json`), 'utf8'));
    } else {
      const prompt = extractionPrompt(answers);
      calls.push({ label: 'extraction', chars: prompt.length, tokens: TOKENS(prompt.length) });
      estimated = true;
    }
    for (const agent of present) {
      const prompt = judgePrompt({ agent, facts, output: prepareOutput(outputs[agent]) });
      calls.push({ label: `judge:${agent}${estimated ? ' (facts pending, size grows)' : ''}`, chars: prompt.length, tokens: TOKENS(prompt.length) });
    }
    return { dryRun: true, calls };
  }
  const { facts } = await extractFacts({ answers, cacheDir, museCall, log });
  const judgements = {};
  for (const agent of present) {
    judgements[agent] = await judgeAgent({ agent, facts, output: outputs[agent], museCall, log });
  }
  const model = traceAnswers({ facts, judgements });
  return { model, markdown: answerTraceMarkdown(model), html: answerTraceHtml(model) };
}
