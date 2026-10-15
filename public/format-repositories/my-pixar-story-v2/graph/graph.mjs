// v2 LangGraph orchestrator. Seedance video generation is NOT part of the graph (prompts only).
//   START -> story-director -> [character-architect || location-scout] -> join -> asset-approval -> seedance-compiler -> END
// Each agent node: selector -> invoke(model) -> schema parse -> linter gate; gate/parse issues feed the retry prompt;
// after MAX_ATTEMPTS failures the node escalates (status 'escalated') and the graph stops.
import { StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { PipelineAnnotation } from './state.mjs';
import { deepAgentInvoke } from './deep-agent-node.mjs';
import { V2_MODELS, loadSkill } from '../config/models.mjs';
import { selectStoryDirectorInput } from '../crew/story-director/input.mjs';
import { parseStagePlay } from '../crew/story-director/schema.mjs';
import { validateStoryDirectorOutput } from '../crew/linter/check-stage-play.mjs';
import { selectCharacterArchitectInput } from '../crew/character-architect/input.mjs';
import { parseCharacterSheets } from '../crew/character-architect/schema.mjs';
import { validateCharacterSheets } from '../crew/linter/check-character-sheets.mjs';
import { selectLocationScoutInput } from '../crew/location-scout/input.mjs';
import { parseLocationPlates } from '../crew/location-scout/schema.mjs';
import { validateLocationPlates } from '../crew/linter/check-location-plates.mjs';
import { selectSeedanceCompilerInput } from '../crew/seedance-compiler/input.mjs';
import { parseSeedancePrompts } from '../crew/seedance-compiler/schema.mjs';
import { validateSeedancePrompts } from '../crew/linter/check-seedance-prompts.mjs';

export const MAX_ATTEMPTS = 3;

/** Per-agent wiring: selector, parser, gate, and how the output is written back to state. */
export const AGENT_SPECS = {
  'story-director': {
    select: selectStoryDirectorInput, parse: parseStagePlay, gate: (out) => validateStoryDirectorOutput(out),
    write: (out) => ({ storyDirector: out }),
  },
  'character-architect': {
    select: selectCharacterArchitectInput, parse: parseCharacterSheets, gate: (out, _in, state) => validateCharacterSheets(out, state.storyDirector),
    write: (out) => ({ characterArchitect: { output: out } }),
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
export function makeAgentNode(agent, invoke, { maxAttempts = MAX_ATTEMPTS, specs = AGENT_SPECS, skill = loadSkill } = {}) {
  const spec = specs[agent];
  return async (state) => {
    let input;
    try { input = spec.select(state); } catch (e) {
      const issues = [{ severity: 'error', code: 'INPUT_SELECTOR_FAILED', message: e.message }];
      return { status: 'escalated', gateIssues: { [agent]: issues }, escalations: [{ agent, reason: 'input selector failed', attempts: 0, issues }] };
    }
    let issues = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let raw;
      try { raw = await invoke({ agent, config: V2_MODELS[agent], skill: skill(agent), input, attempt, retryNotes: retryNotes(issues), state }); } catch (e) {
        issues = [{ severity: 'error', code: 'AGENT_RUN_FAILED', message: e.message }];
        continue;
      }
      let out;
      try { out = spec.parse(raw); } catch (e) {
        issues = (e.issues ?? [{ path: [], message: e.message }]).map((i) => ({ severity: 'error', code: 'SCHEMA_REJECTED', message: i.message, path: (i.path ?? []).join('.') }));
        continue;
      }
      const r = spec.gate(out, input, state);
      if (r.isValid) return { ...spec.write(out), attempts: { [agent]: attempt }, gateIssues: { [agent]: r.issues } };
      issues = r.issues;
    }
    return { status: 'escalated', attempts: { [agent]: maxAttempts }, gateIssues: { [agent]: issues },
      escalations: [{ agent, reason: `failed the gate ${maxAttempts} times`, attempts: maxAttempts, issues }] };
  };
}

/** Tags that must be approved before compiling: every CA @Image N and LS @Loc N. */
export function requiredAssetTags(state) {
  const chars = state.characterArchitect?.output?.characters ?? [];
  const locs = state.locationScout?.output?.locations ?? [];
  return [...chars.map((c) => c.imageTag), ...locs.map((l) => l.elementTag)];
}

/** Human approval gate. With useInterrupt, pauses via LangGraph interrupt() and resumes with { approvedAssets }. */
export function makeApprovalNode({ useInterrupt = false } = {}) {
  return async (state) => {
    const need = requiredAssetTags(state);
    let approved = state.approvedAssets ?? {};
    let missing = need.filter((t) => !approved[t]);
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

const halted = (s) => s.status === 'escalated' || s.status === 'awaiting-approval';

/** Build and compile the v2 graph. Default invoke runs each agent as a Deep Agent; inject a fake invoke in tests. */
export function buildGraph({ invoke, deepAgent = {}, maxAttempts = MAX_ATTEMPTS, useInterrupt = false, checkpointer } = {}) {
  if (invoke === undefined) invoke = deepAgentInvoke(deepAgent);
  if (typeof invoke !== 'function') throw new Error('buildGraph: invoke must be a function');
  const node = (a) => makeAgentNode(a, invoke, { maxAttempts });
  const g = new StateGraph(PipelineAnnotation)
    .addNode('story-director', node('story-director'))
    .addNode('character-architect', node('character-architect'))
    .addNode('location-scout', node('location-scout'))
    .addNode('join', async () => ({}))
    .addNode('asset-approval', makeApprovalNode({ useInterrupt }))
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
