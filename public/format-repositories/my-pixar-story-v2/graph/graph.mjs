// v2 LangGraph orchestrator. Seedance video generation is NOT part of the graph (prompts only).
//   START -> story-director -> [character-architect || location-scout] -> join -> asset-approval (characters + backgrounds)
//     -> storyboard-artist -> animatic-approval -> seedance-compiler -> END
//   animatic rejected: timing/dialogue -> story-director; a bad panel -> storyboard-artist (parent notes ride along).
// Each agent node: selector -> invoke(model) -> schema parse -> linter gate; gate/parse issues feed the retry prompt;
// after MAX_ATTEMPTS failures the node escalates (status 'escalated') and the graph stops.
import { RunnableLambda } from '@langchain/core/runnables';
import { StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { PipelineAnnotation } from './state.mjs';
import { withWatchdog } from './liveness.mjs';
import { deepAgentInvoke, REFLECTION } from './deep-agent-node.mjs';
import { V2_MODELS, loadSkill } from '../config/models.mjs';
import { isFatalProviderError, fatalMessage, FATAL_CODE, RunStoppedError } from './provider-errors.mjs';
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
import { parseSeedancePrompts, assembleCompiledPrompt } from '../crew/seedance-compiler/schema.mjs';
import { finalizeOutput } from '../crew/seedance-compiler/finalize.mjs';
import { validateCharacterArchitectOutput } from '../crew/linter/check-character-sheets.mjs';
import { validateSeedancePrompts } from '../crew/linter/check-seedance-prompts.mjs';
import { selectStoryboardArtistInput } from '../crew/storyboard-artist/input.mjs';
import { parseStoryboard } from '../crew/storyboard-artist/schema.mjs';
import { compileSheets } from '../crew/storyboard-artist/compile.mjs';
import { validateStoryboard } from '../crew/linter/check-storyboard.mjs';
import { shotTimeline } from '../scripts/lib/animatic.mjs';

export const MAX_ATTEMPTS = 3;
export const MAX_TRANSIENT_RETRIES = 2;
/** Network drops / provider 5xx are infrastructure, not the agent's fault: retry the same attempt. */
export const isTransient = (e) => e?.code !== 'MODEL_TIMEOUT' && !e?.issues && !isFatalProviderError(e)
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
  'storyboard-artist': {
    select: selectStoryboardArtistInput, parse: parseStoryboard, gate: (out, input) => validateStoryboard(out, input),
    write: (out, input) => ({ storyboardArtist: { output: out, sheets: compileSheets(out, input) } }),
  },
  'seedance-compiler': {
    select: selectSeedanceCompilerInput, parse: parseSeedancePrompts, gate: (out, input) => validateSeedancePrompts(finalizeOutput(out, input, assembleCompiledPrompt, input?.patch?.compileParts?.map((x) => x.segmentId)), input),
    // each clip carries the approved storyboard panel keys of its shots (deterministic, from the input; not model-written)
    // finalizeOutput: full approved looks, full prop names, plain prop names in actions, one scale statement (code, no model)
    write: (out, input) => ({ seedanceCompiler: { output: withPanels(finalizeOutput(out, input, assembleCompiledPrompt, input?.patch?.compileParts?.map((x) => x.segmentId)), input) } }),
  },
};

/** Add storyboardPanels (sceneId -> panel key) to every compiled clip from the input shots it covers. */
export function withPanels(out, input) {
  const key = new Map((input?.segments ?? []).flatMap((sg) => sg.shots.filter((sh) => sh.storyboardPanel).map((sh) => [sh.sceneId, sh.storyboardPanel])));
  if (!key.size) return out;
  const segs = (out.segments ?? []).map((c) => ({ ...c, storyboardPanels: Object.fromEntries([...new Set((c.shots ?? []).map((sh) => sh.sceneId))].filter((id) => key.has(id)).map((id) => [id, key.get(id)])) }));
  return { ...out, segments: segs };
}

/** Retry prompt section listing the previous attempt's issues. */
export function retryNotes(issues = []) {
  if (!issues.length) return '';
  return 'Your previous output failed the deterministic gate. Fix every error below and resend the full JSON:\n' +
    issues.filter((i) => i.severity === 'error').map((i) => `- ${i.code}${i.path ? ` (${i.path})` : ''}: ${i.message}`).join('\n');
}

/** Parent notes from a rejected animatic, shown to the agent the rejection was routed to. */
export const reviewerNotes = (state, agent) => (state?.revisionNotes?.[agent] ? `The reviewer rejected the animatic and sent it back to you. Address this and resend the full JSON:\n${state.revisionNotes[agent]}` : '');

/** Build one agent node around an injectable invoke({ agent, config, skill, input, attempt, retryNotes }) -> string|object. */
export function makeAgentNode(agent, invoke, { maxAttempts = MAX_ATTEMPTS, specs = AGENT_SPECS, skill = loadSkill, now = () => new Date().toISOString(), onEvent = () => {}, runTag, liveness, timeouts = {}, runStop } = {}) {
  const spec = specs[agent];
  return async (state) => {
    let input;
    const ev = (e) => { try { onEvent({ agent, ...e }); } catch { /* observers never break a run */ } };
    // Each attempt is its own traced child run (inherits the node's run via async context).
    // runStop (one AbortController per graph): a fatal provider error in any node aborts every in-flight sibling call.
    const withStop = (s) => (s && runStop ? AbortSignal.any([s, runStop.signal]) : (s ?? runStop?.signal));
    const call = (r) => (liveness ? withWatchdog((signal) => invoke({ ...r, signal: withStop(signal) }), { liveness, agent, attempt: r.attempt, ...timeouts })
      : invoke(runStop ? { ...r, signal: runStop.signal } : r));
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
    /** Fatal provider error (spent key / no credits): stop now; no retries, no further attempts. */
    const fatal = (attempt, e) => {
      const message = e instanceof RunStoppedError ? e.message : fatalMessage(e);
      if (runStop && !runStop.signal.aborted) runStop.abort(new RunStoppedError(`run stopped: ${agent} hit a fatal provider error. ${message}`));
      const issues = [{ severity: 'error', code: FATAL_CODE, message }];
      ev({ type: 'fatal', attempt, issues }); ev({ type: 'failed', attempt, issues }); // report/patch logs key off 'failed'
      return withReflections({ status: 'failed', attempts: { [agent]: attempt }, retryCounts: { [agent]: Math.max(0, attempt - 1) }, gateIssues: { [agent]: issues },
        validationErrors: [...log, { node: agent, attempt: Math.max(1, attempt), errors: issues, timestamp: now() }],
        escalations: [{ agent, reason: `fatal provider error (no retries): ${message}`, attempts: attempt, issues }] });
    };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) log.push({ node: agent, attempt: attempt - 1, errors: issues, timestamp: now() });
      if (runStop?.signal.aborted) return fatal(attempt - 1, runStop.signal.reason);
      ev({ type: 'attempt', attempt, input });
      const done = (o) => ev({ type: 'attempt-result', attempt, ...o });
      let raw;
      const req = { agent, config: V2_MODELS[agent], skill: skill(agent), input, attempt, retryNotes: retryNotes(issues) || reviewerNotes(state, agent), state, gate: (o) => spec.gate(o, input, state), ...(spec.trace ? { trace: (o) => spec.trace(o, input) } : {}),
        ...(spec.request ? spec.request(input, state) : {}) }; // patch mode: task, scope, rounds, submitSchema
      let transient = 0;
      for (;;) {
        try { raw = await traced(req); break; } catch (e) {
          if (isFatalProviderError(e) || runStop?.signal.aborted) return fatal(attempt, isFatalProviderError(e) ? e : runStop.signal.reason);
          if (isTransient(e) && transient < MAX_TRANSIENT_RETRIES) { transient++; ev({ type: 'transient-retry', attempt, message: e.message }); continue; }
          raw = { __error: e }; break;
        }
      }
      const refl = raw && typeof raw === 'object' ? raw[REFLECTION] : undefined;
      if (refl) { reflections.push({ attempt, ...refl }); ev({ type: 'reflection', attempt, rounds: refl.rounds, log: refl.log }); }
      try { if (raw && raw.__error) throw raw.__error; } catch (e) {
        if (isFatalProviderError(e)) return fatal(attempt, e);
        issues = Array.isArray(e.issues) && e.issues.length ? e.issues : [{ severity: 'error', code: e.code === 'MODEL_TIMEOUT' ? 'MODEL_TIMEOUT' : 'AGENT_RUN_FAILED', message: `model call failed: ${e.message}` }];
        done({ output: null, issues }); continue;
      }
      let out;
      try { out = spec.parse(raw); } catch (e) {
        issues = (e.issues ?? [{ path: [], message: e.message }]).map((i) => { const path = (i.path ?? []).join('.'); return { severity: 'error', code: 'SCHEMA_REJECTED', message: path ? `${path}: ${i.message}` : i.message, path }; });
        done({ output: raw, issues }); continue;
      }
      if (spec.merge) out = spec.merge(kept, out, state);
      const g = spec.gate(out, input, state);
      // The final review rejected the story (STRUCTURAL or a story score <= 2): the gate fails so retry/escalation apply.
      const r = refl?.storyRejection ? { ...g, isValid: false, issues: [...(g.issues ?? []), refl.storyRejection] } : g;
      done({ output: out, issues: r.issues, isValid: r.isValid });
      if (r.isValid) { ev({ type: 'passed', attempt }); return withReflections({ ...spec.write(out, input), attempts: { [agent]: attempt }, retryCounts: { [agent]: attempt - 1 }, gateIssues: { [agent]: r.issues }, validationErrors: log }); }
      issues = r.issues;
      if (spec.carry) kept = { ...(kept ?? {}), ...spec.carry(out, issues) };
    }
    log.push({ node: agent, attempt: maxAttempts, errors: issues, timestamp: now() });
    ev({ type: 'failed', attempt: maxAttempts, issues });
    return withReflections({ status: 'failed', attempts: { [agent]: maxAttempts }, retryCounts: { [agent]: maxAttempts - 1 }, gateIssues: { [agent]: issues }, validationErrors: log,
      escalations: [{ agent, reason: escalationReason(issues, maxAttempts), attempts: maxAttempts, issues }] });
  };
}

/** Why an agent escalated: a gate failure, or a model call that kept failing (a network drop is not a gate failure). */
export function escalationReason(issues = [], maxAttempts) {
  const errs = issues.filter((i) => i.severity === 'error');
  const runFail = errs.length > 0 && errs.every((i) => i.code === 'AGENT_RUN_FAILED' || i.code === 'MODEL_TIMEOUT');
  if (!runFail) return `failed the gate ${maxAttempts} times`;
  const net = errs.some((i) => /network|connection|ECONNRESET|socket|terminated|fetch failed|\b50[234]\b/i.test(i.message ?? ''));
  return net ? `model call kept dropping (network/stream error) on all ${maxAttempts} attempts; not a gate failure` : `model call failed on all ${maxAttempts} attempts; not a gate failure`;
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
      // the approved image is the truth: its outfit text (approvedLooks, element tag -> what the sheet shows) rides along
      if (!missing.length) return { approvedAssets: approved, ...(resume?.approvedLooks ? { approvedLooks: { ...(state.approvedLooks ?? {}), ...resume.approvedLooks } } : {}), pendingApproval: [] };
    }
    if (missing.length) return { status: 'awaiting-approval', pendingApproval: missing };
    return { pendingApproval: [] };
  };
}

/**
 * Animatic approval gate (after the storyboard sheets are made in Flow, sliced and cut to scratch audio).
 * state.animaticApproval / interrupt resume: { decision: 'approve' } or { decision: 'reject', target, notes }.
 * Approve: the SD shot timings are frozen into approvedShotTimings for the Seedance Compiler.
 */
export function makeAnimaticApprovalNode({ useInterrupt = false, autoApprove } = {}) {
  return async (state) => {
    let d = state.animaticApproval;
    if (!d && autoApprove) d = { decision: 'approve' };
    if (!d && useInterrupt) d = interrupt({ kind: 'animatic-approval', sheets: (state.storyboardArtist?.sheets ?? []).map((s) => s.sheetId) });
    if (!d) return { status: 'awaiting-approval', pendingApproval: ['animatic'] };
    if (d.decision === 'approve') return { approvedShotTimings: d.shotTimings ?? shotTimeline(state.storyDirector), ...(d.panels ? { approvedPanels: d.panels } : {}), animaticApproval: null, pendingApproval: [] };
    const target = d.target === 'story-director' ? 'story-director' : 'storyboard-artist';
    return { animaticApproval: { ...d, target, routed: true }, revisionNotes: { [target]: d.notes ?? 'Revise.' }, pendingApproval: [] };
  };
}
/** Where the animatic gate sends the run: rejected -> its target, approved -> compiler. */
export const animaticRoute = (s) => (halted(s) ? END : s.animaticApproval?.decision === 'reject' ? s.animaticApproval.target : 'seedance-compiler');

const halted = (s) => ['escalated', 'failed', 'awaiting-approval'].includes(s.status);

/** Build and compile the v2 graph. Default invoke runs each agent as a Deep Agent; inject a fake invoke in tests. */
export function buildGraph({ invoke, deepAgent = {}, maxAttempts = MAX_ATTEMPTS, useInterrupt = false, checkpointer, onEvent, runTag, autoApprove, autoApproveAnimatic = false, storyboard = true, liveness, timeouts } = {}) {
  if (invoke === undefined) invoke = deepAgentInvoke(deepAgent);
  if (typeof invoke !== 'function') throw new Error('buildGraph: invoke must be a function');
  const runStop = new AbortController(); // shared by every node: a fatal provider error stops the whole run
  const node = (a) => makeAgentNode(a, invoke, { maxAttempts, onEvent, runTag, liveness, timeouts, runStop });
  const g = new StateGraph(PipelineAnnotation)
    .addNode('story-director', node('story-director'))
    .addNode('character-architect', node('character-architect'))
    .addNode('location-scout', node('location-scout'))
    .addNode('join', async () => ({}))
    .addNode('asset-approval', makeApprovalNode({ useInterrupt, autoApprove }))
    .addNode('storyboard-artist', async (s) => {
      const r = await node('storyboard-artist')(s);
      return s.animaticApproval?.routed ? { ...r, animaticApproval: null, revisionNotes: { 'storyboard-artist': '', 'story-director': '' } } : r; // a fresh board clears a routed rejection
    })
    .addNode('animatic-approval', makeAnimaticApprovalNode({ useInterrupt, autoApprove: autoApproveAnimatic }))
    .addNode('seedance-compiler', node('seedance-compiler'))
    .addNode('finish', async (s) => (halted(s) ? {} : { status: 'done' }))
    .addEdge(START, 'story-director')
    .addConditionalEdges('story-director', (s) => (halted(s) ? END : ['character-architect', 'location-scout']), ['character-architect', 'location-scout', END])
    .addEdge(['character-architect', 'location-scout'], 'join')
    .addConditionalEdges('join', (s) => (halted(s) ? END : 'asset-approval'), ['asset-approval', END])
    // storyboard: false keeps the old 4-agent path (assets approved -> compiler), used by the older graph tests.
    .addConditionalEdges('asset-approval', (s) => (halted(s) ? END : storyboard ? 'storyboard-artist' : 'seedance-compiler'), ['storyboard-artist', 'seedance-compiler', END])
    .addConditionalEdges('storyboard-artist', (s) => (halted(s) ? END : 'animatic-approval'), ['animatic-approval', END])
    .addConditionalEdges('animatic-approval', animaticRoute, ['seedance-compiler', 'story-director', 'storyboard-artist', END])
    .addEdge('seedance-compiler', 'finish')
    .addEdge('finish', END);
  return g.compile(checkpointer ? { checkpointer } : undefined);
}
