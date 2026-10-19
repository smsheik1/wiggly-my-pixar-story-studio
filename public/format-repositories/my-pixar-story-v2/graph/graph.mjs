// v2 LangGraph orchestrator. Seedance video generation is NOT part of the graph (prompts only).
//   START -> story-director -> [character-architect || location-scout] -> join -> asset-approval -> seedance-compiler -> END
// Each agent node: selector -> invoke(model) -> schema parse -> linter gate; gate/parse issues feed the retry prompt;
// after MAX_ATTEMPTS failures the node escalates (status 'escalated') and the graph stops.
import { RunnableLambda } from '@langchain/core/runnables';
import { StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { PipelineAnnotation } from './state.mjs';
import { withWatchdog } from './liveness.mjs';
import { deepAgentInvoke, REFLECTION } from './deep-agent-node.mjs';
import { V2_MODELS, loadSkill } from '../config/models.mjs';
import { selectStoryDirectorInput } from '../crew/story-director/input.mjs';
import { parseStagePlay } from '../crew/story-director/schema.mjs';
import { validateStoryDirectorOutput } from '../crew/linter/check-stage-play.mjs';
import { traceReport, traceSummary } from '../crew/linter/answer-sources.mjs';
import { selectCharacterArchitectInput } from '../crew/character-architect/input.mjs';
import { parseCharacterSheets } from '../crew/character-architect/schema.mjs';
import { validateCharacterSheets } from '../crew/linter/check-character-sheets.mjs';
import { selectLocationScoutInput } from '../crew/location-scout/input.mjs';
import { parseLocationPlates } from '../crew/location-scout/schema.mjs';
import { validateLocationPlates } from '../crew/linter/check-location-plates.mjs';
import { selectSeedanceCompilerInput } from '../crew/seedance-compiler/input.mjs';
import { parseSeedancePrompts } from '../crew/seedance-compiler/schema.mjs';
import { validateCharacterArchitectOutput } from '../crew/linter/check-character-sheets.mjs';
import { validateSeedancePrompts } from '../crew/linter/check-seedance-prompts.mjs';

export const MAX_ATTEMPTS = 3;
export const MAX_TRANSIENT_RETRIES = 2;
/** Network drops / provider 5xx are infrastructure, not the agent's fault: retry the same attempt. */
export const isTransient = (e) => e?.code !== 'MODEL_TIMEOUT' && !e?.issues
  && /network connection lost|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed|terminated|other side closed|\b(502|503|504|520|524)\b|overloaded|rate limit|429/i.test(String(e?.message ?? e));

// ---- Character Architect: per-character gating, name-prefixed errors, keep valid characters across retries ----
const charIndex = (path = '') => { const m = /^characters\.(\d+)/.exec(path); return m ? +m[1] : -1; };
/** Gate each character separately (prefixed by name), plus the cast-level checks. */
export function gateCharacters(out, story) {
  const cast = validateCharacterSheets(out, story);
  const issues = cast.issues.filter((i) => charIndex(i.path) < 0); // cast-level only (TAG_PARITY, mode)
  (out?.characters ?? []).forEach((c, i) => {
    const one = validateCharacterArchitectOutput(c, { pathPrefix: `characters.${i}` }).issues;
    const castLevelForThis = cast.issues.filter((x) => charIndex(x.path) === i && !one.some((y) => y.code === x.code && y.message === x.message));
    for (const x of [...one, ...castLevelForThis]) issues.push({ ...x, character: c.name, message: `${c.name}: ${x.message}` });
  });
  const errors = issues.filter((i) => i.severity === 'error').map((i) => i.message);
  return { isValid: errors.length === 0, errors, warnings: issues.filter((i) => i.severity !== 'error').map((i) => i.message), issues };
}
/** Characters with no error issues, keyed by elementTag. */
export function keepValidCharacters(out, issues) {
  const bad = new Set(issues.filter((i) => i.severity === 'error').map((i) => charIndex(i.path)));
  return Object.fromEntries((out?.characters ?? []).filter((_, i) => !bad.has(i)).map((c) => [c.elementTag, c]));
}
/** Merge a retry with previously valid characters: valid ones are kept as-is, in cast order. */
export function mergeCharacters(kept, out, state) {
  if (!kept || !Object.keys(kept).length) return out;
  const order = (state?.storyDirector?.cast ?? []).map((c) => c.elementTag);
  const fresh = Object.fromEntries((out.characters ?? []).map((c) => [c.elementTag, c]));
  const tags = [...new Set([...order, ...Object.keys(fresh), ...Object.keys(kept)])].filter((t) => kept[t] || fresh[t]);
  return { ...out, characters: tags.map((t, i) => ({ ...(kept[t] ?? fresh[t]), imageTag: `@Image ${i + 1}` })) };
}

/** Per-agent wiring: selector, parser, gate, and how the output is written back to state. */
export const AGENT_SPECS = {
  'story-director': {
    select: selectStoryDirectorInput, parse: parseStagePlay, gate: (out, input) => validateStoryDirectorOutput(out, input),
    // answer trace shown to (and logged with) the self-review critique
    trace: (out, input) => ({ text: traceReport(out, input), data: traceSummary(out, input) }),
    write: (out) => ({ storyDirector: out }),
  },
  'character-architect': {
    select: selectCharacterArchitectInput, parse: parseCharacterSheets, gate: (out, _in, state) => gateCharacters(out, state.storyDirector),
    write: (out) => ({ characterArchitect: { output: out } }),
    carry: keepValidCharacters, merge: mergeCharacters,
  },
  'location-scout': {
    select: selectLocationScoutInput, parse: parseLocationPlates, gate: (out, input) => validateLocationPlates(out, input),
    write: (out) => ({ locationScout: { output: out } }),
  },
  'seedance-compiler': {
    select: selectSeedanceCompilerInput, parse: parseSeedancePrompts, gate: (out, input) => validateSeedancePrompts(out, input),
    write: (out) => ({ seedanceCompiler: { output: out } }),
  },
};

/** Retry prompt section listing the previous attempt's issues. */
export function retryNotes(issues = []) {
  if (!issues.length) return '';
  return 'Your previous output failed the deterministic gate. Fix every error below and resend the full JSON:\n' +
    issues.filter((i) => i.severity === 'error').map((i) => `- ${i.code}${i.path ? ` (${i.path})` : ''}: ${i.message}`).join('\n');
}

/** Build one agent node around an injectable invoke({ agent, config, skill, input, attempt, retryNotes }) -> string|object. */
export function makeAgentNode(agent, invoke, { maxAttempts = MAX_ATTEMPTS, specs = AGENT_SPECS, skill = loadSkill, now = () => new Date().toISOString(), onEvent = () => {}, runTag, liveness, timeouts = {} } = {}) {
  const spec = specs[agent];
  return async (state) => {
    let input;
    const ev = (e) => { try { onEvent({ agent, ...e }); } catch { /* observers never break a run */ } };
    // Each attempt is its own traced child run (inherits the node's run via async context).
    const call = (r) => (liveness ? withWatchdog((signal) => invoke({ ...r, signal }), { liveness, agent, attempt: r.attempt, ...timeouts }) : invoke(r));
    const traced = (req) => RunnableLambda.from(async (r) => call(r)).invoke(req, {
      runName: `${agent} attempt ${req.attempt}`, tags: [`agent:${agent}`, `attempt:${req.attempt}`, ...(runTag ? [`runId:${runTag}`] : [])],
      metadata: { agent, attempt: req.attempt, runId: runTag } });
    ev({ type: 'start' });
    try { input = spec.select(state); } catch (e) {
      const issues = [{ severity: 'error', code: 'INPUT_SELECTOR_FAILED', message: e.message }];
      ev({ type: 'failed', attempt: 0, issues });
      return { status: 'failed', gateIssues: { [agent]: issues }, retryCounts: { [agent]: 0 },
        validationErrors: [{ node: agent, attempt: 1, errors: issues, timestamp: now() }],
        escalations: [{ agent, reason: 'input selector failed', attempts: 0, issues }] };
    }
    let issues = [];
    let kept = null;
    const log = [];
    const reflections = []; // per attempt: the agent's own critiques (deepAgentInvoke with reflectionRounds > 0)
    const withReflections = (o) => (reflections.length ? { ...o, reflections: { [agent]: reflections } } : o);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) log.push({ node: agent, attempt: attempt - 1, errors: issues, timestamp: now() });
      ev({ type: 'attempt', attempt, input });
      const done = (o) => ev({ type: 'attempt-result', attempt, ...o });
      let raw;
      const req = { agent, config: V2_MODELS[agent], skill: skill(agent), input, attempt, retryNotes: retryNotes(issues), state, gate: (o) => spec.gate(o, input, state), ...(spec.trace ? { trace: (o) => spec.trace(o, input) } : {}),
        ...(spec.request ? spec.request(input, state) : {}) }; // patch mode: task, scope, rounds, submitSchema
      let transient = 0;
      for (;;) {
        try { raw = await traced(req); break; } catch (e) {
          if (isTransient(e) && transient < MAX_TRANSIENT_RETRIES) { transient++; ev({ type: 'transient-retry', attempt, message: e.message }); continue; }
          raw = { __error: e }; break;
        }
      }
      const refl = raw && typeof raw === 'object' ? raw[REFLECTION] : undefined;
      if (refl) { reflections.push({ attempt, ...refl }); ev({ type: 'reflection', attempt, rounds: refl.rounds, log: refl.log }); }
      try { if (raw && raw.__error) throw raw.__error; } catch (e) {
        issues = Array.isArray(e.issues) && e.issues.length ? e.issues : [{ severity: 'error', code: e.code === 'MODEL_TIMEOUT' ? 'MODEL_TIMEOUT' : 'AGENT_RUN_FAILED', message: `model call failed: ${e.message}` }];
        done({ output: null, issues }); continue;
      }
      let out;
      try { out = spec.parse(raw); } catch (e) {
        issues = (e.issues ?? [{ path: [], message: e.message }]).map((i) => { const path = (i.path ?? []).join('.'); return { severity: 'error', code: 'SCHEMA_REJECTED', message: path ? `${path}: ${i.message}` : i.message, path }; });
        done({ output: raw, issues }); continue;
      }
      if (spec.merge) out = spec.merge(kept, out, state);
      const r = spec.gate(out, input, state);
      done({ output: out, issues: r.issues, isValid: r.isValid });
      if (r.isValid) { ev({ type: 'passed', attempt }); return withReflections({ ...spec.write(out), attempts: { [agent]: attempt }, retryCounts: { [agent]: attempt - 1 }, gateIssues: { [agent]: r.issues }, validationErrors: log }); }
      issues = r.issues;
      if (spec.carry) kept = { ...(kept ?? {}), ...spec.carry(out, issues) };
    }
    log.push({ node: agent, attempt: maxAttempts, errors: issues, timestamp: now() });
    ev({ type: 'failed', attempt: maxAttempts, issues });
    return withReflections({ status: 'failed', attempts: { [agent]: maxAttempts }, retryCounts: { [agent]: maxAttempts - 1 }, gateIssues: { [agent]: issues }, validationErrors: log,
      escalations: [{ agent, reason: `failed the gate ${maxAttempts} times`, attempts: maxAttempts, issues }] });
  };
}

/** Tags that must be approved before compiling: every CA @Image N and LS @Loc N. */
export function requiredAssetTags(state) {
  const chars = state.characterArchitect?.output?.characters ?? [];
  const locs = state.locationScout?.output?.locations ?? [];
  return [...chars.map((c) => c.imageTag), ...locs.map((l) => l.elementTag)];
}

/** Human approval gate. With useInterrupt, pauses via LangGraph interrupt() and resumes with { approvedAssets }. */
/** Placeholder approvals for dry runs: fake asset keys, no image model calls. Clearly marked. */
export const placeholderAssets = (tags) => Object.fromEntries(tags.map((t) => [t, `placeholder:${t.startsWith('@Loc') ? 'location-plate' : 'master-render'}:${t.slice(1).replace(/\s+/g, '-').toLowerCase()}`]));

export function makeApprovalNode({ useInterrupt = false, autoApprove } = {}) {
  return async (state) => {
    const need = requiredAssetTags(state);
    let approved = state.approvedAssets ?? {};
    let missing = need.filter((t) => !approved[t]);
    if (missing.length && autoApprove) return { approvedAssets: { ...approved, ...autoApprove(missing) }, pendingApproval: [] };
    if (missing.length && useInterrupt) {
      const resume = interrupt({ kind: 'asset-approval', missing });
      approved = { ...approved, ...(resume?.approvedAssets ?? {}) };
      missing = need.filter((t) => !approved[t]);
      if (!missing.length) return { approvedAssets: approved, pendingApproval: [] };
    }
    if (missing.length) return { status: 'awaiting-approval', pendingApproval: missing };
    return { pendingApproval: [] };
  };
}

const halted = (s) => ['escalated', 'failed', 'awaiting-approval'].includes(s.status);

/** Build and compile the v2 graph. Default invoke runs each agent as a Deep Agent; inject a fake invoke in tests. */
export function buildGraph({ invoke, deepAgent = {}, maxAttempts = MAX_ATTEMPTS, useInterrupt = false, checkpointer, onEvent, runTag, autoApprove, liveness, timeouts } = {}) {
  if (invoke === undefined) invoke = deepAgentInvoke(deepAgent);
  if (typeof invoke !== 'function') throw new Error('buildGraph: invoke must be a function');
  const node = (a) => makeAgentNode(a, invoke, { maxAttempts, onEvent, runTag, liveness, timeouts });
  const g = new StateGraph(PipelineAnnotation)
    .addNode('story-director', node('story-director'))
    .addNode('character-architect', node('character-architect'))
    .addNode('location-scout', node('location-scout'))
    .addNode('join', async () => ({}))
    .addNode('asset-approval', makeApprovalNode({ useInterrupt, autoApprove }))
    .addNode('seedance-compiler', node('seedance-compiler'))
    .addNode('finish', async (s) => (halted(s) ? {} : { status: 'done' }))
    .addEdge(START, 'story-director')
    .addConditionalEdges('story-director', (s) => (halted(s) ? END : ['character-architect', 'location-scout']), ['character-architect', 'location-scout', END])
    .addEdge(['character-architect', 'location-scout'], 'join')
    .addConditionalEdges('join', (s) => (halted(s) ? END : 'asset-approval'), ['asset-approval', END])
    .addConditionalEdges('asset-approval', (s) => (halted(s) ? END : 'seedance-compiler'), ['seedance-compiler', END])
    .addEdge('seedance-compiler', 'finish')
    .addEdge('finish', END);
  return g.compile(checkpointer ? { checkpointer } : undefined);
}
