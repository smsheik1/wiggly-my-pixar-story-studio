// v2 target model & provider map (static). Not wired into any pipeline yet.
export const NANO_BANANA = Object.freeze({ provider: 'google-flow', model: 'nano-banana-2.1', promptLines: 'single' });

export const V2_MODELS = Object.freeze({
  'story-director': { kind: 'llm', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', effort: 'max',
    imageSteps: { storyboard: NANO_BANANA } },
  'character-architect': { kind: 'llm', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', effort: 'max',
    imageSteps: { character: NANO_BANANA } },
  'location-scout': { kind: 'llm', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', effort: 'max',
    imageSteps: { location: NANO_BANANA } },
  'seedance-compiler': { kind: 'llm', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', effort: 'max',
    video: { provider: 'replicate', model: 'bytedance/seedance-2.5', resolution: '480p', enabled: false,
             note: 'not yet enabled: Seedance testing only after all upstream agents are proven' } },
  vera: { kind: 'llm', provider: 'openrouter', model: 'meta/muse-spark-1.3-contributor', effort: 'max' },
  linter: { kind: 'code', provider: 'none', model: 'none' },
});
