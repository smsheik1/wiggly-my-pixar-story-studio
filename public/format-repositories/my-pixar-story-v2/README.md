# my-pixar-story-v2 (scaffold, NOT live)

Parallel 4-agent crew being built beside the frozen v1 crew (`../my-pixar-story-v1/`, tag `crew-v1-frozen`).
Nothing here is wired into the pipeline, build-skills, or tests. v1 stays live until Shaz switches.
See `V2-PLAN.md`.

## Storyboard house style

The canonical storyboard style for this format is `crew/storyboard-artist/storyboard-style.md` (output spec, shot-size rules, copy-paste panel prompt template, default model `nano-banana-2.1`). Panels from any model must pass `node scripts/check-panels.mjs --dir <panels>`.
