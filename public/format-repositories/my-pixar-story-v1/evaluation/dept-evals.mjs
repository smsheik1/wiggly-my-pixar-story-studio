// Department evals ("automated dailies"): golden cases from real r4 ground truth, run
// against the CURRENT role prompt, skill, rubric and model, scored by machine-checkable
// assertions, compared with a saved baseline.
//
//   node runner.mjs dept-eval --all                      # replay (free, offline): recordings only
//   node runner.mjs dept-eval --dept vera,sage           # replay a subset
//   node runner.mjs dept-eval --all --run <r4 dir>       # full local replay: real host loop, cassette fetcher
//   node runner.mjs dept-eval --all --live --confirm-spend --run <r4 dir> --secrets secrets.env [--max-usd 0.10]
//
// Replay never touches the network. Live is the only paid mode; it needs --confirm-spend and is
// hard-capped at DEPT_EVAL_HARD_CAP_USD in code (--max-usd can lower, never raise it).
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
export const DEPT_EVAL_DIR = join(here, 'dept-evals');
export const GOLDEN_PATH = join(DEPT_EVAL_DIR, 'golden.json');
export const RECORDINGS_DIR = join(DEPT_EVAL_DIR, 'recordings');
export const BASELINE_PATH = join(DEPT_EVAL_DIR, 'baseline.json');
export const CASSETTES_DIR = join(here, 'local', 'dept-evals', 'cassettes');
export const DEPT_EVAL_HARD_CAP_USD = 0.10;
export const CASE_TIMEOUT_MS = 15 * 60 * 1000;
// Same per-request timeout the studio runner gives the OpenRouter crew (runner.mjs, 600000 ms).
// The host default (180 s) is shorter than some Muse xhigh turns, so evals timed out where a run would not.
export const DEPT_EVAL_HOST_TIMEOUT_MS = 600000;

// Every crew department, so the scorecard shows gaps (zero cases) instead of hiding them.
export const DEPARTMENTS = {
  vera: 'visual-reviewer', june: 'scene-reviewer', sage: 'text-reviewer', ava: 'audio-reviewer',
  leo: 'script-writer', beau: 'background-product-owner', theo: 'pixar-prompter', cleo: 'cast-designer',
  pia: 'sheet-prompter', sam: 'shot-planner', cam: 'composition-writer', mo: 'motion-director',
  vin: 'video-prompt-engineer', finn: 'sound-designer', eli: 'film-editor', max: 'generation-planner', nora: 'voice-director',
};

const sha = s => createHash('sha256').update(s).digest('hex');
export const INFRA_ERROR = /OPENROUTER_REQUEST_FAILED|usage limit reached|credits exhausted|DEPT_EVAL_TIMEOUT|DEPT_EVAL_CASE_ABORTED|OPENROUTER_AUTH_FAILED/;

// ---------- golden cases ----------
const Assertion = z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('verdict'), oneOf: z.array(z.enum(['approved', 'provisional', 'rejected', 'inconclusive'])).min(1), soft: z.boolean().optional(), why: z.string() }).strict(),
  z.object({ id: z.string(), type: z.literal('mustMention'), pattern: z.string(), criteria: z.array(z.string()).optional(), status: z.enum(['fail', 'pass', 'inconclusive', 'any']).optional(), soft: z.boolean().optional(), why: z.string() }).strict(),
  z.object({ id: z.string(), type: z.literal('mustNotClaim'), pattern: z.string(), status: z.enum(['fail', 'inconclusive', 'any']).optional(), soft: z.boolean().optional(), why: z.string() }).strict(),
  z.object({ id: z.string(), type: z.literal('topPick'), selection: z.number().int().nonnegative(), ifPresent: z.boolean().optional(), soft: z.boolean().optional(), why: z.string() }).strict(),
  z.object({ id: z.string(), type: z.literal('mustNotPick'), selections: z.array(z.number().int().nonnegative()).min(1), soft: z.boolean().optional(), why: z.string() }).strict(),
  z.object({ id: z.string(), type: z.literal('contentMatches'), pattern: z.string(), field: z.string().optional(), soft: z.boolean().optional(), why: z.string() }).strict(),
  z.object({ id: z.string(), type: z.literal('contentNotMatches'), pattern: z.string(), field: z.string().optional(), soft: z.boolean().optional(), why: z.string() }).strict(),
]);
export const GoldenCase = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  dept: z.enum(Object.keys(DEPARTMENTS)),
  priority: z.number().int().positive(),
  source: z.object({ key: z.string(), gate: z.enum(['author', 'review', 'owner-review']), version: z.number().int().positive().nullable() }).strict(),
  truth: z.object({ authority: z.enum(['shaz', 'operator-for-shaz', 'objective']), summary: z.string().min(10), history: z.array(z.number().int().nonnegative()) }).strict(),
  asserts: z.array(Assertion).min(1),
}).strict();
export const GoldenSet = z.object({ version: z.literal(1), sourceRun: z.string(), notes: z.string(), cases: z.array(GoldenCase).min(1) }).strict().superRefine((g, ctx) => {
  const ids = g.cases.map(c => c.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate case id' });
  for (const c of g.cases) {
    const aids = c.asserts.map(a => a.id);
    if (new Set(aids).size !== aids.length) ctx.addIssue({ code: 'custom', message: `${c.id}: duplicate assertion id` });
    if (!c.asserts.some(a => !a.soft)) ctx.addIssue({ code: 'custom', message: `${c.id}: needs at least one hard assertion` });
    for (const a of c.asserts) if ('pattern' in a) { try { new RegExp(a.pattern, 'i'); } catch { ctx.addIssue({ code: 'custom', message: `${c.id}/${a.id}: bad regex` }); } }
  }
});
export async function loadGolden(path = GOLDEN_PATH) { return GoldenSet.parse(JSON.parse(await readFile(path, 'utf8'))); }

export function selectCases(golden, { depts = null, caseIds = null } = {}) {
  let cases = [...golden.cases].sort((a, b) => a.priority - b.priority);
  if (depts?.length) cases = cases.filter(c => depts.includes(c.dept));
  if (caseIds?.length) cases = cases.filter(c => caseIds.includes(c.id));
  return cases;
}

// ---------- scoring ----------
const checkText = c => [c.criterion, c.status, c.evidence, c.finding, c.repair, ...(c.quotes ?? [])].filter(v => typeof v === 'string').join(' \n ');
const pick = (obj, field) => field ? field.split('.').reduce((v, k) => v?.[k], obj) : obj;

export function scoreAssertion(a, event) {
  const review = event?.review ?? null;
  const checks = review?.checks ?? [];
  const rx = 'pattern' in a ? new RegExp(a.pattern, 'i') : null;
  const rec = review?.recommendation ?? null;
  switch (a.type) {
    case 'verdict': {
      const got = review?.decision ?? null;
      return { pass: a.oneOf.includes(got), detail: `decision ${got ?? 'none'} (expected ${a.oneOf.join('|')})` };
    }
    case 'mustMention': {
      const status = a.status ?? 'fail';
      const hit = checks.find(c => (status === 'any' || c.status === status) && (!a.criteria || a.criteria.includes(c.criterion)) && rx.test(checkText(c)));
      return { pass: !!hit, detail: hit ? `found in ${hit.criterion}=${hit.status}` : `no ${status} check${a.criteria ? ` in ${a.criteria.join('/')}` : ''} matching /${a.pattern}/` };
    }
    case 'mustNotClaim': {
      const status = a.status ?? 'fail';
      const hit = checks.find(c => (status === 'any' ? c.status !== 'pass' : c.status === status) && rx.test(checkText(c)));
      return { pass: !hit, detail: hit ? `claimed in ${hit.criterion}=${hit.status}: "${String(hit.evidence ?? '').slice(0, 160)}"` : 'not claimed' };
    }
    case 'topPick': {
      if (!rec) return { pass: !!a.ifPresent, detail: 'no recommendation given' + (a.ifPresent ? ' (allowed)' : '') };
      return { pass: rec.selection === a.selection, detail: `selection ${rec.selection} (expected ${a.selection})` };
    }
    case 'mustNotPick': {
      const s = rec?.selection;
      return { pass: s == null || !a.selections.includes(s), detail: s == null ? 'no recommendation' : `selection ${s}` };
    }
    case 'contentMatches':
    case 'contentNotMatches': {
      const value = pick(event?.content, a.field);
      if (value === undefined) return { pass: false, detail: `content${a.field ? '.' + a.field : ''} missing` };
      const hit = rx.exec(JSON.stringify(value));
      const pass = a.type === 'contentMatches' ? !!hit : !hit;
      return { pass, detail: hit ? `matched "${hit[0]}"` : 'no match' };
    }
  }
  return { pass: false, detail: 'unknown assertion' };
}

// outcome: { event, valid, gateAccepted, error }
export function scoreCase(caseDef, outcome) {
  const completes = !!(outcome?.event && outcome.valid && outcome.gateAccepted);
  const assertions = [{ id: 'completes', type: 'completes', soft: false, pass: completes, detail: completes ? 'valid event, gate accepted' : `did not complete: ${String(outcome?.error ?? 'no event').slice(0, 200)}` }];
  for (const a of caseDef.asserts) {
    const r = completes ? scoreAssertion(a, outcome.event) : { pass: false, detail: 'not evaluated (did not complete)' };
    assertions.push({ id: a.id, type: a.type, soft: !!a.soft, pass: r.pass, detail: r.detail, why: a.why });
  }
  const pass = assertions.filter(x => !x.soft).every(x => x.pass);
  return { status: pass ? 'pass' : 'fail', assertions };
}

const ROLE_RECIPES = {
  'sheet-prompter': ['sheetPrompt'],
  'cast-designer': ['characterPrompt'],
  'pixar-prompter': ['backgroundPrompt'],
};

// ---------- fingerprint: what the eval actually tests for a role ----------
export async function roleFingerprint(role, studio) {
  const { WORKER_PACKET_INSTRUCTION, wigglyToolDefinition } = await import('../runtime/crew.mjs');
  const { modelTraits } = await import('../runtime/openrouter-host.mjs');
  const { digest } = await import('../runtime/contracts.mjs');
  const agent = studio.config.agents[role];
  const rubricPath = studio.config.reviewers[role] ?? null;
  const roleStages = ROLE_RECIPES[role] ?? [];
  const recipePaths = [...new Set(roleStages.map(stage => studio.config.recipes[stage]).filter(Boolean))];
  const recipes = Object.fromEntries(recipePaths.map(p => [p, studio.documents[p].sha256]));
  const craft = studio.config.craft
    ? Object.fromEntries((studio.config.craft.sections[role] ?? []).map(entry => [
        entry,
        studio.documents[`${studio.config.craft.path}#${entry}`].sha256,
      ]))
    : {};
  const parts = {
    model: agent.model,
    backend: agent.backend ?? 'codex',
    tools: agent.tools,
    skill: { path: agent.skill, sha256: studio.documents[agent.skill].sha256 },
    rubric: rubricPath ? { path: rubricPath, sha256: studio.documents[rubricPath].sha256 } : null,
    recipes,
    craft,
    traits: modelTraits(agent.model),
    packetInstruction: sha(WORKER_PACKET_INSTRUCTION),
    tool: digest(wigglyToolDefinition().inputSchema),
  };
  return { digest: digest(parts), parts };
}

// ---------- budget (live only) ----------
const PRICES = { 'meta/muse-spark-1.3-contributor': { in: 0.10, out: 0.20 } };
const FALLBACK_PRICE = { in: 0.30, out: 1.20 };
export function worstCaseUsd(body, model) {
  const price = PRICES[model] ?? FALLBACK_PRICE;
  let parsed = {}; try { parsed = typeof body === 'string' ? JSON.parse(body) : (body ?? {}); } catch {}
  const raw = typeof body === 'string' ? body : JSON.stringify(parsed);
  const images = (raw.match(/data:image\//g) ?? []).length;
  const textChars = raw.replace(/data:[^"]*/g, '').length;
  const maxOut = Number(parsed.max_tokens) || 32000;
  // Deliberately conservative: ~3 chars/token and 3,000 tokens per image, plus the full output cap.
  return ((textChars / 3 + images * 3000) / 1e6) * price.in + (maxOut / 1e6) * price.out;
}
export function actualUsd(usage, model) {
  if (Number.isFinite(Number(usage?.cost)) && Number(usage.cost) > 0) return Number(usage.cost);
  const price = PRICES[model] ?? FALLBACK_PRICE;
  return ((Number(usage?.prompt_tokens) || 0) * price.in + (Number(usage?.completion_tokens) || 0) * price.out) / 1e6;
}
// Shared across concurrent cases: reserve the worst case before sending, settle with the
// actual cost on completion, and wait for in-flight requests instead of skipping when the
// cap would be crossed by conservative reservations. A request that fails mid-flight is
// charged its worst case.
export class Budget {
  constructor(capUsd) {
    const cap = Number(capUsd);
    this.cap = Math.min(Number.isFinite(cap) && cap > 0 ? cap : DEPT_EVAL_HARD_CAP_USD, DEPT_EVAL_HARD_CAP_USD);
    this.spent = 0; this.reserved = 0; this.refused = 0;
    this.inFlight = 0; this.waiters = []; this.peak = 0;
  }
  _track() { const s = this.spent + this.reserved; if (s > this.peak) this.peak = s; }
  _notify() { const w = this.waiters; this.waiters = []; for (const waiter of w) { try { clearInterval(waiter.timer); } catch {} try { waiter.resolve(); } catch {} } }
  _waitForSettle(isAborted) {
    return new Promise((resolve, reject) => {
      const waiter = {};
      waiter.resolve = () => { try { clearInterval(waiter.timer); } catch {} resolve(); };
      waiter.timer = setInterval(() => {
        if (isAborted()) {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          try { clearInterval(waiter.timer); } catch {}
          reject(Object.assign(new Error('DEPT_EVAL_CASE_ABORTED: case timed out; no further requests.'), { stopDispatch: true }));
        }
      }, 20);
      this.waiters.push(waiter);
    });
  }
  wrap(fetcher, model, { isAborted = () => false } = {}) {
    return async (url, init) => {
      if (isAborted()) throw Object.assign(new Error('DEPT_EVAL_CASE_ABORTED: case timed out; no further requests.'), { stopDispatch: true });
      const worst = worstCaseUsd(init?.body, model);
      for (;;) {
        if (isAborted()) throw Object.assign(new Error('DEPT_EVAL_CASE_ABORTED: case timed out; no further requests.'), { stopDispatch: true });
        // Atomic check-and-reserve: no await between the check and reserved += worst.
        if (this.spent + this.reserved + worst <= this.cap) {
          this.reserved += worst; this.inFlight++; this._track();
          break;
        }
        if (this.inFlight === 0) {
          this.refused++;
          throw Object.assign(new Error(`DEPT_EVAL_CAP_REACHED: next request could cost $${worst.toFixed(4)}; spent $${this.spent.toFixed(4)} + in flight $${this.reserved.toFixed(4)} of $${this.cap.toFixed(2)}.`), { stopDispatch: true, capReached: true });
        }
        await this._waitForSettle(isAborted);
      }
      let charged = worst;
      try {
        const resp = await fetcher(url, init);
        try {
          const data = await resp.clone().json();
          if (data?.usage) charged = actualUsd(data.usage, model);
          else charged = resp.ok ? worst : 0;
        } catch { charged = resp.ok ? worst : 0; }
        return resp;
      } finally { this.reserved -= worst; this.inFlight--; this.spent += charged; this._track(); this._notify(); }
    };
  }
}

// ---------- recordings (committed; no media, no secrets) ----------
// Collects one compact entry per model request: a digest of the normalized request and the
// response message (reasoning stripped). Media inside requests is already a sha256 after normalizing.
export function recorderFetcher(fetcher, entries, { secrets = [], aliases = {} } = {}) {
  return async (url, init = {}) => {
    const { normalizeForCassette } = await import('../runtime/cassette.mjs');
    let body = init.body; try { body = JSON.parse(body); } catch {}
    const normalized = await normalizeForCassette(body ?? null, { secrets, aliases });
    const t0 = Date.now();
    const resp = await fetcher(url, init);
    const entry = { seq: entries.length + 1, requestSha256: sha(JSON.stringify(normalized)), status: resp.status, ms: 0 };
    try {
      const data = await resp.clone().json();
      const msg = data?.choices?.[0]?.message ?? null;
      entry.message = msg ? { content: msg.content ?? null, tool_calls: msg.tool_calls ?? undefined } : null;
      entry.usage = data?.usage ? { prompt_tokens: data.usage.prompt_tokens, completion_tokens: data.usage.completion_tokens, reasoning_tokens: data.usage.completion_tokens_details?.reasoning_tokens, cost: data.usage.cost } : null;
    } catch { entry.message = null; }
    entry.ms = Date.now() - t0;
    entries.push(entry);
    return resp;
  };
}
const FORBIDDEN = [/data:[a-z]+\/[a-z0-9.+-]+;base64,/i, /sk-or-[A-Za-z0-9-]{8,}/, /Bearer\s+[A-Za-z0-9._-]{12,}/];
export function assertRecordingClean(obj, secrets = []) {
  const s = JSON.stringify(obj);
  for (const rx of FORBIDDEN) if (rx.test(s)) throw new Error(`DEPT_EVAL_RECORDING_UNSAFE: matched ${rx}; nothing written.`);
  for (const secret of secrets) if (secret && secret.length >= 8 && s.includes(secret)) throw new Error('DEPT_EVAL_RECORDING_UNSAFE: a secret value would be written; nothing written.');
  if (/[A-Za-z0-9+/]{2000,}/.test(s)) throw new Error('DEPT_EVAL_RECORDING_UNSAFE: long base64-like run (media bytes?); nothing written.');
  return true;
}
const aliasesFor = (runDir) => {
  const out = {};
  if (runDir) out[resolve(runDir)] = '<RUN>';
  out[resolve(here, '..')] = '<KIT>';
  out[homedir()] = '<HOME>';
  return out;
};
function scrubPaths(value, aliases) {
  const pairs = Object.entries(aliases).filter(([p]) => p && p.length > 1).sort((a, b) => b[0].length - a[0].length);
  const walk = v => {
    if (typeof v === 'string') { let s = v; for (const [p, t] of pairs) if (s.includes(p)) s = s.split(p).join(t); return s; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

// ---------- executing one case through the real crew host ----------
async function loadStates(runDir) {
  const { openRunCopy, projectStates } = await import('./r4-replay.mjs');
  const { saver, tempDir } = await openRunCopy(runDir);
  const states = [];
  try { for await (const s of projectStates(saver)) states.push(s); } finally { saver.db.close(); }
  return { states, tempDir };
}

// Rebuild the task at the case's gate with the CURRENT studio snapshot and run the assigned role.
export async function executeCase(caseDef, { states, studio, secretsPath, fetcher, cwd }) {
  const { findState } = await import('./r4-replay.mjs');
  const { taskFor, applyEvent } = await import('../runtime/workflow.mjs');
  const { runCrewTask, roleFor } = await import('../runtime/crew.mjs');
  const { OpenRouterHost } = await import('../runtime/openrouter-host.mjs');
  const { Event } = await import('../runtime/contracts.mjs');
  const role = DEPARTMENTS[caseDef.dept];
  const source = await findState(states, caseDef.source);
  if (!source) return { event: null, valid: false, gateAccepted: false, error: `SOURCE_STATE_NOT_FOUND: ${caseDef.source.key} ${caseDef.source.gate} v${caseDef.source.version}` };
  const p = structuredClone(source);
  p.studio = studio;
  if (roleFor(p) !== role) return { event: null, valid: false, gateAccepted: false, error: `ROLE_MISMATCH: gate belongs to ${roleFor(p)}, case says ${role}` };
  const agent = studio.config.agents[role];
  const host = new OpenRouterHost({ cwd, secretsPath, model: agent.model, fetcher, timeoutMs: DEPT_EVAL_HOST_TIMEOUT_MS });
  const capabilityVersion = await host.profile();
  p.crew = { workers: Object.entries(studio.config.agents).map(([r, a]) => r === role
    ? { workerId: `dept-eval:${role}`, name: a.name, role, modelVersion: a.model, capabilityVersion, execution: 'host', backend: 'openrouter' }
    : { workerId: `dummy:${r}`, name: a.name, role: r, modelVersion: 'dummy', capabilityVersion: 'dummy', execution: 'host' }) };
  let event = null;
  try {
    event = await runCrewTask(p, taskFor(p), host);
    const valid = Event.safeParse(event).success;
    try { applyEvent(structuredClone(p), event); return { event, valid, gateAccepted: true, error: null, model: agent.model }; }
    catch (e) { return { event, valid, gateAccepted: false, error: e.message, model: agent.model }; }
  } catch (e) {
    const finished = e.finishedResult && typeof e.finishedResult === 'object' ? e.finishedResult : null;
    return { event: finished, valid: false, gateAccepted: false, error: e.message, capReached: !!e.capReached, model: agent.model };
  }
}

const withTimeout = (promise, ms, onTimeout) => {
  let t; const timer = new Promise(res => { t = setTimeout(() => { onTimeout(); res({ event: null, valid: false, gateAccepted: false, error: `DEPT_EVAL_TIMEOUT: case exceeded ${Math.round(ms / 60000)} min` }); }, ms); });
  return Promise.race([promise.finally(() => clearTimeout(t)), timer]);
};

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---------- the eval run ----------
export async function runDeptEvals({
  mode = 'replay', depts = null, caseIds = null, runDir = null, secretsPath = null, confirmSpend = false,
  maxUsd = DEPT_EVAL_HARD_CAP_USD, concurrency = 3, goldenPath = GOLDEN_PATH, recordingsDir = RECORDINGS_DIR,
  baselinePath = BASELINE_PATH, cassettesDir = CASSETTES_DIR, updateBaseline = false, strict = false,
  realFetch = globalThis.fetch, studio = null, statesOverride = null, caseTimeoutMs = CASE_TIMEOUT_MS, log = () => {},
  execute = executeCase, eventSchema = null,
} = {}) {
  if (!['replay', 'live'].includes(mode)) throw new Error(`unknown mode ${mode}`);
  const golden = await loadGolden(goldenPath);
  const cases = selectCases(golden, { depts, caseIds });
  if (!cases.length) throw new Error('DEPT_EVAL_NO_CASES: nothing matches --dept/--case');
  if (!studio) studio = (await import('../runtime/instructions.mjs')).loadStudio();
  const fingerprints = {};
  for (const c of cases) { const role = DEPARTMENTS[c.dept]; fingerprints[role] ??= await roleFingerprint(role, studio); }
  const budget = mode === 'live' ? new Budget(maxUsd) : null;
  if (mode === 'live') {
    if (!confirmSpend) return { refused: 'DEPT_EVAL_SPEND_NOT_CONFIRMED: live mode makes paid model calls; pass --confirm-spend (hard cap $' + budget.cap.toFixed(2) + ').', exitCode: 2 };
    if (!statesOverride && !runDir) return { refused: 'DEPT_EVAL_RUN_REQUIRED: live mode needs --run <r4 run dir> (read via a temp copy).', exitCode: 2 };
  }
  let states = statesOverride, tempDir = null;
  const fullReplay = mode === 'replay' && (statesOverride || runDir);
  if ((mode === 'live' || fullReplay) && !states) ({ states, tempDir } = await loadStates(runDir));
  let secrets = [];
  let replaySecrets = null;
  if (mode === 'live') { const { readOpenRouterKey } = await import('../runtime/openrouter-host.mjs'); secrets = [await readOpenRouterKey(secretsPath)]; }
  const workDir = await mkdtemp(join(tmpdir(), 'dept-eval-'));
  if (fullReplay) { replaySecrets = join(workDir, 'replay-secrets.env'); await writeFile(replaySecrets, 'OPENROUTER_API_KEY=replay-only-not-a-key\n', { mode: 0o600 }); }
  const aliases = aliasesFor(runDir);
  const startedAt = new Date().toISOString();

  const results = await pool(cases, mode === 'live' ? concurrency : 4, async (c) => {
    const role = DEPARTMENTS[c.dept];
    const fp = fingerprints[role];
    const base = { id: c.id, dept: c.dept, role, priority: c.priority, truth: c.truth.summary };
    const recPath = join(recordingsDir, `${c.id}.json`);
    if (mode === 'replay') {
      if (!existsSync(recPath)) return { ...base, status: 'missing', detail: 'no recording yet: run live once to record' };
      const rec = JSON.parse(await readFile(recPath, 'utf8'));
      if (rec.fingerprint !== fp.digest) {
        const changed = Object.keys(fp.parts).filter(k => JSON.stringify(fp.parts[k]) !== JSON.stringify(rec.fingerprintParts?.[k]));
        return { ...base, status: 'stale', detail: `${role} changed since recording (${changed.join(', ') || 'fingerprint'}): re-run live`, recordedAt: rec.recordedAt };
      }
      let outcome = rec.outcome;
      let replayNote = 'offline: recorded outcome re-scored against current assertions';
      if (fullReplay) {
        const cassetteFile = join(cassettesDir, c.id, 'cassette.jsonl');
        if (existsSync(cassetteFile)) {
          const { Cassette, replayFetcher } = await import('../runtime/cassette.mjs');
          const cassette = await Cassette.open(join(cassettesDir, c.id), { secrets: [] });
          cassette.aliases = aliases;
          outcome = await execute(c, { states, studio, secretsPath: replaySecrets, fetcher: replayFetcher(cassette, 'openrouter'), cwd: workDir });
          if (cassette.mismatchError) return { ...base, status: 'stale', detail: `request changed since recording: ${cassette.mismatchError.message.slice(0, 300)}` };
          replayNote = 'full: real host loop against the recorded cassette';
        } else replayNote = 'offline (no local cassette for full replay)';
      } else {
        // Re-validate the recorded event against the current schema.
        const schema = eventSchema ?? (await import('../runtime/contracts.mjs')).Event;
        if (outcome?.event && outcome.valid && !schema.safeParse(outcome.event).success) outcome = { ...outcome, valid: false, error: 'recorded event no longer matches the current Event schema' };
      }
      const scored = scoreCase(c, outcome);
      return { ...base, ...scored, decision: outcome?.event?.review?.decision ?? null, selection: outcome?.event?.review?.recommendation?.selection ?? null, costUsd: 0, recordedCostUsd: rec.costUsd ?? null, wallMs: rec.wallMs ?? null, requests: rec.requests?.length ?? null, recordedAt: rec.recordedAt, replay: replayNote, error: outcome?.error ?? null };
    }
    // live
    const model = studio.config.agents[role].model;
    let aborted = false;
    const entries = [];
    const { Cassette, recordingFetcher } = await import('../runtime/cassette.mjs');
    const cassetteDir = join(cassettesDir, c.id);
    await rm(cassetteDir, { recursive: true, force: true });
    const cassette = await Cassette.create(cassetteDir, { type: 'header', caseId: c.id, fingerprint: fp.digest, model, recordedAt: new Date().toISOString() }, { secrets });
    cassette.aliases = aliases;
    const spent0 = budget.spent;
    // host -> recorder -> budget guard -> cassette recorder -> network
    const fetcher = recorderFetcher(budget.wrap(recordingFetcher(cassette, 'openrouter', realFetch), model, { isAborted: () => aborted }), entries, { secrets, aliases });
    const t0 = Date.now();
    log(`start ${c.id} (${role}, ${model})`);
    const outcome = await withTimeout(execute(c, { states, studio, secretsPath, fetcher, cwd: workDir }), caseTimeoutMs, () => { aborted = true; });
    const wallMs = Date.now() - t0;
    const costUsd = entries.reduce((s, e) => s + (e.usage ? actualUsd(e.usage, model) : 0), 0);
    // The host wraps fetch errors, so detect the cap by its code, not the error flag.
    if (outcome.capReached || /DEPT_EVAL_CAP_REACHED/.test(String(outcome.error ?? ''))) {
      log(`skip ${c.id}: cap (${entries.length} requests made, $${costUsd.toFixed(4)})`);
      return { ...base, status: 'skipped', detail: entries.length ? `hard cap reached mid-case after ${entries.length} requests; not scored, not recorded` : 'hard cap reached before this case could start', costUsd, requests: entries.length };
    }
    // Infrastructure failures (network, provider 5xx/429, credits, timeout) say nothing about the
    // agent: report them as errors and never record them as the agent's answer.
    if (INFRA_ERROR.test(String(outcome.error ?? '')) && !outcome.event) {
      log(`error ${c.id}: ${String(outcome.error).slice(0, 160)}`);
      return { ...base, status: 'error', detail: String(outcome.error).slice(0, 300), costUsd, wallMs, requests: entries.length };
    }
    const scored = scoreCase(c, outcome);
    const recording = scrubPaths({ caseId: c.id, recordedAt: new Date().toISOString(), model, mode: 'live', fingerprint: fp.digest, fingerprintParts: fp.parts, wallMs, costUsd, requests: entries, outcome: { event: outcome.event, valid: outcome.valid, gateAccepted: outcome.gateAccepted, error: outcome.error } }, aliases);
    assertRecordingClean(recording, secrets);
    await mkdir(recordingsDir, { recursive: true });
    await writeFile(recPath, JSON.stringify(recording, null, 1) + '\n');
    log(`done ${c.id}: ${scored.status} $${costUsd.toFixed(4)} ${Math.round(wallMs / 1000)}s (budget spent $${budget.spent.toFixed(4)}, case delta $${(budget.spent - spent0).toFixed(4)})`);
    return { ...base, ...scored, decision: outcome.event?.review?.decision ?? null, selection: outcome.event?.review?.recommendation?.selection ?? null, costUsd, wallMs, requests: entries.length, error: outcome.error ?? null };
  });
  await rm(workDir, { recursive: true, force: true });
  if (tempDir) await rm(tempDir, { recursive: true, force: true });

  // baseline + regressions
  const baseline = existsSync(baselinePath) ? JSON.parse(await readFile(baselinePath, 'utf8')) : null;
  const regressions = [];
  if (baseline) for (const r of results) {
    const b = baseline.cases?.[r.id];
    if (!b || !['pass', 'fail'].includes(r.status)) continue;
    const lost = (b.passing ?? []).filter(id => r.assertions.find(a => a.id === id && !a.soft && !a.pass));
    if (lost.length) regressions.push({ id: r.id, dept: r.dept, lost });
  }
  const scorecard = buildScorecard({ mode, startedAt, results, regressions, baseline, budget, fullReplay: !!fullReplay, golden });
  if (updateBaseline) {
    const usable = results.filter(r => ['pass', 'fail'].includes(r.status));
    const next = { updatedAt: new Date().toISOString(), note: 'Assertion ids that passed at this baseline. A later run losing any of them is a regression (exit 1).', cases: { ...(baseline?.cases ?? {}) } };
    for (const r of usable) next.cases[r.id] = { status: r.status, passing: r.assertions.filter(a => a.pass && !a.soft).map(a => a.id), failing: r.assertions.filter(a => !a.pass && !a.soft).map(a => a.id), model: studio.config.agents[r.role].model };
    await mkdir(dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, JSON.stringify(next, null, 2) + '\n');
    scorecard.baselineUpdated = baselinePath;
  }
  const unresolved = results.filter(r => ['stale', 'missing'].includes(r.status)).length;
  scorecard.exitCode = regressions.length ? 1 : (strict && unresolved) ? 1 : 0;
  return scorecard;
}

export function buildScorecard({ mode, startedAt, results, regressions, baseline, budget, fullReplay, golden }) {
  const byDept = {};
  for (const d of Object.keys(DEPARTMENTS)) byDept[d] = { cases: 0, pass: 0, fail: 0, stale: 0, missing: 0, skipped: 0, error: 0 };
  for (const r of results) { byDept[r.dept].cases++; byDept[r.dept][r.status]++; }
  for (const d of Object.keys(byDept)) byDept[d].goldenCases = golden.cases.filter(c => c.dept === d).length;
  return {
    mode: mode === 'replay' ? (fullReplay ? 'replay-full' : 'replay-offline') : 'live', startedAt, finishedAt: new Date().toISOString(),
    spendUsd: budget ? Number(budget.spent.toFixed(6)) : 0, capUsd: budget ? budget.cap : 0, refusedRequests: budget?.refused ?? 0,
    totals: { cases: results.length, pass: results.filter(r => r.status === 'pass').length, fail: results.filter(r => r.status === 'fail').length, stale: results.filter(r => r.status === 'stale').length, missing: results.filter(r => r.status === 'missing').length, skipped: results.filter(r => r.status === 'skipped').length, error: results.filter(r => r.status === 'error').length },
    byDept, regressions, baselineAt: baseline?.updatedAt ?? null, cases: results,
  };
}

const ICON = { pass: 'PASS', fail: 'FAIL', stale: 'STALE', missing: 'MISSING', skipped: 'SKIPPED (cap)', error: 'ERROR (infra)' };
export function scorecardMarkdown(s) {
  let md = `# Department evals scorecard (${s.mode})\n\n`;
  md += `${s.startedAt} to ${s.finishedAt}. Spend $${s.spendUsd.toFixed(4)}${s.capUsd ? ` of $${s.capUsd.toFixed(2)} cap` : ' (replay is free)'}.\n\n`;
  md += `**Totals:** ${s.totals.pass} pass, ${s.totals.fail} fail, ${s.totals.stale} stale, ${s.totals.missing} missing, ${s.totals.skipped} skipped, ${s.totals.error} errors. **Regressions vs baseline${s.baselineAt ? ` (${s.baselineAt})` : ' (none saved)'}:** ${s.regressions.length}\n\n`;
  md += `| Dept | Golden cases | Run | Pass | Fail | Stale | Missing | Skipped |\n|---|---|---|---|---|---|---|---|\n`;
  for (const [d, v] of Object.entries(s.byDept)) if (v.goldenCases || v.cases) md += `| ${d} | ${v.goldenCases} | ${v.cases} | ${v.pass} | ${v.fail} | ${v.stale} | ${v.missing} | ${v.skipped} |\n`;
  const none = Object.entries(s.byDept).filter(([, v]) => !v.goldenCases).map(([d]) => d);
  if (none.length) md += `\nNo golden cases yet: ${none.join(', ')}.\n`;
  md += `\n| Case | Dept | Result | Decision | Pick | Cost | Time | Failed assertions |\n|---|---|---|---|---|---|---|---|\n`;
  for (const r of s.cases) {
    const failed = (r.assertions ?? []).filter(a => !a.pass).map(a => `${a.id}${a.soft ? ' (soft)' : ''}: ${a.detail}`).join('; ') || (r.detail ?? '');
    const cost = r.costUsd ? `$${r.costUsd.toFixed(4)}` : (r.recordedCostUsd != null ? `($${Number(r.recordedCostUsd).toFixed(4)} rec.)` : '-');
    md += `| ${r.id} | ${r.dept} | ${ICON[r.status] ?? r.status} | ${r.decision ?? '-'} | ${r.selection ?? '-'} | ${cost} | ${r.wallMs ? Math.round(r.wallMs / 1000) + 's' : '-'} | ${String(failed).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |\n`;
  }
  if (s.regressions.length) { md += `\n## Regressions\n\n`; for (const g of s.regressions) md += `- ${g.id} (${g.dept}): lost ${g.lost.join(', ')}\n`; }
  return md;
}

// ---------- CLI ----------
export async function cli(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  const { values } = parseArgs({ args: argv, options: {
    all: { type: 'boolean' }, dept: { type: 'string' }, case: { type: 'string' }, live: { type: 'boolean' }, replay: { type: 'boolean' },
    'confirm-spend': { type: 'boolean' }, run: { type: 'string' }, secrets: { type: 'string' }, 'max-usd': { type: 'string' },
    concurrency: { type: 'string' }, out: { type: 'string' }, 'update-baseline': { type: 'boolean' }, strict: { type: 'boolean' }, list: { type: 'boolean' },
    golden: { type: 'string' }, recordings: { type: 'string' }, baseline: { type: 'string' }, json: { type: 'boolean' },
  }, allowPositionals: false });
  const goldenPath = values.golden ? resolve(values.golden) : GOLDEN_PATH;
  if (values.list) {
    const g = await loadGolden(goldenPath);
    for (const c of selectCases(g, {})) out(`${String(c.priority).padStart(2)} ${c.dept.padEnd(5)} ${c.id}  [${c.source.key} ${c.source.gate}${c.source.version ? ' v' + c.source.version : ''}] ${c.asserts.map(a => a.id + (a.soft ? '(soft)' : '')).join(', ')}\n`);
    return 0;
  }
  if (!values.all && !values.dept && !values.case) { err('dept-eval needs --all, --dept <vera,sage,...> or --case <id> (or --list)\n'); return 2; }
  if (values.live && values.replay) { err('choose --live or --replay, not both\n'); return 2; }
  const depts = values.all ? null : values.dept?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
  for (const d of depts ?? []) if (!DEPARTMENTS[d]) { err(`unknown department ${d} (known: ${Object.keys(DEPARTMENTS).join(', ')})\n`); return 2; }
  const s = await runDeptEvals({
    mode: values.live ? 'live' : 'replay', depts, caseIds: values.case?.split(',') ?? null,
    runDir: values.run ? resolve(values.run) : null, secretsPath: values.secrets ? resolve(values.secrets) : null,
    confirmSpend: !!values['confirm-spend'], maxUsd: values['max-usd'] ? Number(values['max-usd']) : DEPT_EVAL_HARD_CAP_USD,
    concurrency: values.concurrency ? Number(values.concurrency) : 3, goldenPath,
    recordingsDir: values.recordings ? resolve(values.recordings) : RECORDINGS_DIR, baselinePath: values.baseline ? resolve(values.baseline) : BASELINE_PATH,
    updateBaseline: !!values['update-baseline'], strict: !!values.strict, log: (m) => err(`[dept-eval ${new Date().toLocaleTimeString()}] ${m}\n`),
  });
  if (s.refused) { err(s.refused + '\n'); return s.exitCode; }
  const md = scorecardMarkdown(s);
  if (values.out) {
    const dir = resolve(values.out); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'scorecard.json'), JSON.stringify(s, null, 2) + '\n');
    await writeFile(join(dir, 'scorecard.md'), md);
  }
  out(values.json ? JSON.stringify(s, null, 2) + '\n' : md);
  for (const r of s.cases.filter(r => r.status === 'stale')) err(`::warning::dept-eval ${r.id} is stale: ${r.detail}\n`);
  if (s.regressions.length) err(`dept-eval: ${s.regressions.length} regression(s) vs baseline\n`);
  return s.exitCode;
}
