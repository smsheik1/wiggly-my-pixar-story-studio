import { doNotWriteList } from '../crew/linter/writing-tells.mjs';
// v2 target model & provider map (static). Not wired into any pipeline yet.
import { readFileSync, existsSync } from 'node:fs';
import { VIDEO_ENGINES } from '../crew/seedance-compiler/schema.mjs';
export { VIDEO_ENGINES };
import { fileURLToPath } from 'node:url';
import { skillFileName, reviewFileName } from '../crew/files.mjs';
export const NANO_BANANA = Object.freeze({ provider: 'google-flow', model: 'nano-banana-2.1', promptLines: 'single' });

// Provider limits per model (OpenRouter /api/v1/models top_provider, checked 2026-10-18). Every agent's maxTokens must fit
// maxCompletionTokens; openRouterModel refuses a config that does not (tests/models.test.mjs checks it too).
export const MODEL_LIMITS = Object.freeze({
  'meta/muse-spark-1.3-contributor': { contextLength: 1048576, maxCompletionTokens: 943718 },
  'anthropic/claude-haiku-5.5': { contextLength: 1000000, maxCompletionTokens: 128000 }, // checked 2026-10-20
});
// r5-sd10 side by side: Haiku 5.5 wrote the better script (natural, true lines). Muse stays available via WIGGLY_SD_MODEL.
export const DEFAULT_SD_MODEL = 'anthropic/claude-haiku-5.5';
/** Story Director model: WIGGLY_SD_MODEL (for side-by-side test runs) or the default; only models listed in MODEL_LIMITS. */
export function storyDirectorModel(env = process.env) {
  const m = env.WIGGLY_SD_MODEL?.trim();
  if (!m) return DEFAULT_SD_MODEL;
  if (!MODEL_LIMITS[m]) throw new Error(`WIGGLY_SD_MODEL "${m}" is not in MODEL_LIMITS (config/models.mjs); add its OpenRouter limits first`);
  return m;
}
/** maxTokens for an agent config, checked against MODEL_LIMITS (throws if it exceeds the model's output limit). */
export function outputCap(config) {
  const lim = MODEL_LIMITS[config?.model];
  if (lim && config.maxTokens > lim.maxCompletionTokens) throw new Error(`maxTokens ${config.maxTokens} exceeds ${config.model}'s output limit ${lim.maxCompletionTokens} (config/models.mjs MODEL_LIMITS)`);
  return config.maxTokens;
}

export const V2_MODELS = Object.freeze({
  'story-director': { downstreamAgents: ['character-architect', 'location-scout'], maxTokens: 128000, /* r4-dry7: xhigh reasoning used all 32k 3x and never submitted; r5-dry1: one call used 64.2k of 64k (~53k reasoning) -> 2x headroom, well under the model's limit (MODEL_LIMITS) */ kind: 'llm', provider: 'openrouter', model: storyDirectorModel(), effort: 'high' /* r5-dry4: xhigh draft calls ran > 6 min and were cut mid-stream ('Network connection lost') every time */ /* Haiku 5.5: reasoning_effort supported; high kept */,
    // Self-critique + rewrite rounds after the first draft (graph/deep-agent-node.mjs); the gate checks the final revision.
    reflectionRounds: 2,
    // Patch mode (graph/patch.mjs): one self-review round scoped to the target; --reflection-rounds overrides it.
    patchReflectionRounds: 1,
    coldRead: true,
    // Story first (graph/story-beats.mjs): beats + critique/rewrite plain-text calls before the shots call.
    storyBeats: true,
    bestOfDrafts: 2,
    imageSteps: { storyboard: NANO_BANANA } },
  'character-architect': { downstreamAgents: ['vera', 'seedance-compiler'], maxTokens: 64000, /* r4-dry9: CA used 23.5k of 24k */ kind: 'llm', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', effort: 'xhigh',
    reflectionRounds: 0, // off until proven on the Story Director
    imageSteps: { character: NANO_BANANA },
    targetEngines: { masterRender: 'nano-banana-2.1', modelSheet: 'nano-banana-2.1' },
    contract: { output: 'crew/character-architect/schema.mjs', input: 'crew/character-architect/input.mjs', gate: 'crew/linter/check-character-sheets.mjs' } },
  'location-scout': { role: 'Location Scout & Environment Plate Architect', downstreamAgents: ['vera', 'seedance-compiler'], maxTokens: 32000, kind: 'llm', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', effort: 'xhigh',
    reflectionRounds: 0,
    imageSteps: { location: NANO_BANANA },
    targetEngines: { plate: 'nano-banana-2.1' },
    parallelWith: ['character-architect'],
    contract: { output: 'crew/location-scout/schema.mjs', input: 'crew/location-scout/input.mjs', gate: 'crew/linter/check-location-plates.mjs' } },
  'seedance-compiler': { role: 'Seedance Compiler', upstreamAgents: ['character-architect', 'location-scout'], downstreamAgents: ['vera', 'linter'], maxTokens: 64000, /* r4-dry6/r4-dry8: compile calls hit the 32k cap */ kind: 'llm', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', effort: 'xhigh',
    video: { provider: 'replicate', model: 'bytedance/seedance-2.5', resolution: '480p', enabled: false,
             note: 'not yet enabled: Seedance testing only after all upstream agents are proven' },
    reflectionRounds: 0,
    targetEngines: { video: 'seedance-2.5' }, videoEngines: Object.keys(VIDEO_ENGINES) /* selectable: state.videoEngine or run-sc-only --engine */, segmentMaxSec: 30 /* per engine: VIDEO_ENGINES[engine].segmentMaxSec (omni-1.1-flash 10s, 4/6/8/10) */, continuation: 'extend',
    contract: { output: 'crew/seedance-compiler/schema.mjs', input: 'crew/seedance-compiler/input.mjs', gate: 'crew/linter/check-seedance-prompts.mjs' } },
  'storyboard-artist': { role: 'Storyboard Artist', upstreamAgents: ['story-director', 'character-architect', 'location-scout'], downstreamAgents: ['seedance-compiler'], maxTokens: 32000, kind: 'llm', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', effort: 'xhigh',
    reflectionRounds: 0,
    imageSteps: { storyboard: NANO_BANANA }, // made by hand in Google Flow; code only writes prompts
    contract: { output: 'crew/storyboard-artist/schema.mjs', input: 'crew/storyboard-artist/input.mjs', gate: 'crew/linter/check-storyboard.mjs' } },
  vera: { downstreamAgents: [], maxTokens: 8000, kind: 'llm', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', effort: 'xhigh' },
  linter: { downstreamAgents: [], maxTokens: 0, kind: 'code', provider: 'none', model: 'none' },
  'prop-architect': { downstreamAgents: ['seedance-compiler'], maxTokens: 0, kind: 'code', provider: 'none', model: 'none' },
});

const CREW = new URL('../crew/', import.meta.url);
/** Read an agent's skill file (crew/files.mjs: role.md unless overridden); throws a clear error if the agent or its skill file is missing. */
const TELLS_AGENTS = new Set(['story-director', 'seedance-compiler']);
/**
 * The agent's review rubric (crew/<agent>/REVIEW.md, or its crew/files.mjs override), used only for the self-review critique call, or null when the
 * agent has none (the critique then uses the generic focus list). Same agent, same node, same model: no config entry.
 */
export function loadReview(agent) {
  if (!V2_MODELS[agent]) throw new Error(`loadReview: unknown v2 agent "${agent}"`);
  const path = fileURLToPath(new URL(`${agent}/${reviewFileName(agent)}`, CREW));
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
/**
 * The agent's cold-read prompt (crew/<agent>/COLD-READ.md), used only for the first-time viewer cold-read pass,
 * or null when the agent has none.
 */
export function loadColdRead(agent) {
  if (!V2_MODELS[agent]) throw new Error(`loadColdRead: unknown v2 agent "${agent}"`);
  const path = fileURLToPath(new URL(`${agent}/COLD-READ.md`, CREW));
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
/**
 * The agent's judge prompt (crew/<agent>/PICK.md), used only for the best-of draft pick call,
 * or null when the agent has none.
 */
export function loadPick(agent) {
  if (!V2_MODELS[agent]) throw new Error(`loadPick: unknown v2 agent "${agent}"`);
  const path = fileURLToPath(new URL(`${agent}/PICK.md`, CREW));
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
export function loadSkill(agent) {
  if (!V2_MODELS[agent]) throw new Error(`loadSkill: unknown v2 agent "${agent}"`);
  const path = fileURLToPath(new URL(`${agent}/${skillFileName(agent)}`, CREW));
  if (!existsSync(path)) throw new Error(`loadSkill: missing skill file for "${agent}" at ${path}`);
  const role = readFileSync(path, 'utf8');
  // Story Director writes the lines; the Seedance Compiler may rewrite them: both load the rubric's do-not-write list.
  return TELLS_AGENTS.has(agent) ? `${role.trimEnd()}\n\n${doNotWriteList()}` : role;
}

/** Location Scout skill loader (ESM-safe path via import.meta.url); throws if role.md is missing. */
export function loadLocationScoutSkill() {
  const path = fileURLToPath(new URL('location-scout/role.md', CREW));
  if (!existsSync(path)) throw new Error(`loadLocationScoutSkill: missing skill file at ${path}`);
  return readFileSync(path, 'utf8');
}
