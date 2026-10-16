// v2 target model & provider map (static). Not wired into any pipeline yet.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const NANO_BANANA = Object.freeze({ provider: 'google-flow', model: 'nano-banana-2.1', promptLines: 'single' });

export const V2_MODELS = Object.freeze({
  'story-director': { downstreamAgents: ['character-architect', 'location-scout'], maxTokens: 64000, /* r4-dry7: xhigh reasoning used all 32k (31998 reasoning tokens) 3x and never submitted */ kind: 'llm', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', effort: 'xhigh',
    imageSteps: { storyboard: NANO_BANANA } },
  'character-architect': { downstreamAgents: ['vera', 'seedance-compiler'], maxTokens: 64000, /* r4-dry9: CA used 23.5k of 24k */ kind: 'llm', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', effort: 'xhigh',
    imageSteps: { character: NANO_BANANA },
    targetEngines: { masterRender: 'nano-banana-2.1', modelSheet: 'nano-banana-2.1' },
    contract: { output: 'crew/character-architect/schema.mjs', input: 'crew/character-architect/input.mjs', gate: 'crew/linter/check-character-sheets.mjs' } },
  'location-scout': { role: 'Location Scout & Environment Plate Architect', downstreamAgents: ['vera', 'seedance-compiler'], maxTokens: 32000, kind: 'llm', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', effort: 'xhigh',
    imageSteps: { location: NANO_BANANA },
    targetEngines: { plate: 'nano-banana-2.1' },
    parallelWith: ['character-architect'],
    contract: { output: 'crew/location-scout/schema.mjs', input: 'crew/location-scout/input.mjs', gate: 'crew/linter/check-location-plates.mjs' } },
  'seedance-compiler': { role: 'Seedance Compiler', upstreamAgents: ['character-architect', 'location-scout'], downstreamAgents: ['vera', 'linter'], maxTokens: 64000, /* r4-dry6/r4-dry8: compile calls hit the 32k cap */ kind: 'llm', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', effort: 'xhigh',
    video: { provider: 'replicate', model: 'bytedance/seedance-2.5', resolution: '480p', enabled: false,
             note: 'not yet enabled: Seedance testing only after all upstream agents are proven' },
    targetEngines: { video: 'seedance-2.5' }, segmentMaxSec: 30, continuation: 'extend',
    contract: { output: 'crew/seedance-compiler/schema.mjs', input: 'crew/seedance-compiler/input.mjs', gate: 'crew/linter/check-seedance-prompts.mjs' } },
  vera: { downstreamAgents: [], maxTokens: 8000, kind: 'llm', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', effort: 'xhigh' },
  linter: { downstreamAgents: [], maxTokens: 0, kind: 'code', provider: 'none', model: 'none' },
});

const CREW = new URL('../crew/', import.meta.url);
/** Read an agent's role.md; throws a clear error if the agent or its skill file is missing. */
export function loadSkill(agent) {
  if (!V2_MODELS[agent]) throw new Error(`loadSkill: unknown v2 agent "${agent}"`);
  const path = fileURLToPath(new URL(`${agent}/role.md`, CREW));
  if (!existsSync(path)) throw new Error(`loadSkill: missing skill file for "${agent}" at ${path}`);
  return readFileSync(path, 'utf8');
}

/** Location Scout skill loader (ESM-safe path via import.meta.url); throws if role.md is missing. */
export function loadLocationScoutSkill() {
  const path = fileURLToPath(new URL('location-scout/role.md', CREW));
  if (!existsSync(path)) throw new Error(`loadLocationScoutSkill: missing skill file at ${path}`);
  return readFileSync(path, 'utf8');
}
