# Spec: frozen benchmark (`scripts/benchmark.mjs`)

Owner: agy (Gemini 3.8 Flash). Branch `feat/v2-benchmark` off `feat/v2-orchestrator`. Local commits only: no push, no PR, no CI.

## Goal
Freeze r4-dry6 as the baseline and score any later run against it, so every prompt/schema change is proven to help or hurt.
Zero model calls, zero network. Pure code over files on disk.

## 1. Baseline: `benchmarks/r4-dry6/`
Create with a one-off command `node scripts/benchmark.mjs --freeze r4-dry6 --project <project.json> [--photo-refs <file>]` and commit the result:
- `outputs/{story-director,character-architect,location-scout,seedance-compiler,state}.json`: byte copies of `runs/r4-dry6/outputs/*`.
- `inputs.json`: the graph inputs, built with `inputsFromProject()` + `loadPhotoReferences()` from `scripts/run-rehearsal.mjs`, with every `photoReferences[].path` **removed**. No photo files, no image bytes, no absolute paths anywhere under `benchmarks/` (a test enforces this: no `/Users/`, no `.jpg/.jpeg/.png/.heic/.webp` strings, no `data:image`).
- `checks.json`: the baseline's own scored result (section 3) so diffs never need to recompute the baseline.
- `README.md`: 5 lines, what it is and how to re-freeze.
The r4 project is `~/bible-work/r4-project.json`, photo refs `~/bible-work/r4-project-photo-refs.json`. Never copy the project file or photos into the repo.

## 2. Usage
```
node scripts/benchmark.mjs --run <runId|path to runs/<id>> [--baseline benchmarks/r4-dry6] [--json] [--out <file>]
```
Default baseline `benchmarks/r4-dry6`. Prints Markdown; `--json` prints the result object. Also writes `runs/<id>/benchmark.md`.
Exit code 0 always when scoring succeeds (it is a report, not a gate); 1 on bad args/missing files.
Export the pure functions (`scoreRun`, `compareRuns`, `benchmarkMarkdown`, `freezeBaseline`) for tests and for the later answer-tracing tool.

## 3. Scoring a run: `scoreRun({ outputs, inputs, approvedAssets })`
Rebuild a graph-like state: `{ inputs, storyDirector, characterArchitect: { output }, locationScout: { output }, seedanceCompiler: { output }, approvedAssets }` (approvedAssets from the run's `state.json`).
For each agent, reuse the existing code exactly as the graph does (`graph/graph.mjs` `AGENT_SPECS`):
`input = spec.select(state)` (catch -> one issue `INPUT_SELECTOR_FAILED`), `out = spec.parse(JSON.stringify(output))` (catch -> `SCHEMA_REJECTED` issues from `e.issues`), `r = spec.gate(out, input, state)`.
Missing output file -> agent `status: 'missing'`. Per agent record:
`{ status: 'pass'|'fail'|'missing', errors: [{code, path, message}], warnings: [{code, path, message}], codeCounts: { CODE: n } }`.
Totals: `passed` / `failed` / `missing` agent counts, total error and warning counts.

### Structural metrics (from outputs, null when the source is missing)
- `castCount` (SD `cast.length`), `characterCount` (CA `characters.length`), `locationCount` (SD `locations.length`) and `plateCount` (LS `locations.length`).
- `segmentCount`, `shotCount` (SD), `shotsPerSegment` array.
- `runtimeSec`: SD sum of `segments[].targetDurationSec`; `compiledRuntimeSec`: SC `totalRuntimeSec`.
- `shotFieldCompleteness`: for each SD shot, the fraction of these fields that are present and non-empty (string trimmed length > 0, arrays length > 0, numbers finite): `location, framing, cameraAngle, cameraMove, whatWeSee, whatWeHear`. Report the mean (0-1, 3 decimals), the min, and a list of `{segmentId, shotNumber, missing:[fields]}` for incomplete shots.
- `dialogueLines` and `narrationLines` counts across shots if those arrays exist on shots (inspect `crew/story-director/schema.mjs` `ShotCardSchema` for the real field names; do not guess).

## 4. Comparing: `compareRuns(baseline, candidate)`
- Per agent: status change (`pass->fail` = regression, `fail->pass` = fix), codes **new** in the candidate, codes **gone**, codes whose count changed (with both counts). Codes are compared by `code`, not message.
- Structural: each metric with baseline, candidate, delta. Flag `changed: true` when different.
- Summary verdict line: `REGRESSION` if any agent went pass->fail or a new error code appeared; `IMPROVED` if a fail->pass or errors went down with no regression; else `SAME`.
- Comparing the baseline with itself must give `SAME`, zero deltas, no new or gone codes.

## 5. AI judge hook (stub)
`scoreRun(..., { judges = [] })` where a judge is `{ name, run: async ({ outputs, inputs, runDir }) => ({ score: 0..1, details }) }`.
Results go to `result.judges[name]`; compare shows the score delta. A judge throwing records `{ error }` and never fails scoring.
Export `registerJudge(judge)` / a default empty registry, and ship `judges/noop.mjs` (returns `{ score: null, details: 'stub' }`) wired only when `--judge noop` is passed.
CLI `--judge <name>` loads `scripts/judges/<name>.mjs` (default export is the judge). The answer-tracing tool will plug in here later.

## 6. Markdown output (keep it short)
```
# Benchmark: <candidate> vs <baseline>  ->  SAME|IMPROVED|REGRESSION
| Agent | Baseline | Candidate | New codes | Gone codes |
| Metric | Baseline | Candidate | Δ |
Judges: <name>: <b> -> <c>
```
Then up to 10 incomplete shots and the full new-code messages.

## 7. Tests: `tests/benchmark.test.mjs`
Use `node:test` with `{ timeout: 10000 }` on every test. No network, no child processes, no model calls. Use temp dirs, cleaned up.
- baseline vs itself -> `SAME`, zero deltas.
- a copy with one SD shot's `whatWeSee` emptied -> completeness drops, the shot is listed, SD gate result compared.
- a copy with a broken SC (e.g. delete `segments`) -> SC `fail` with `SCHEMA_REJECTED`, verdict `REGRESSION`.
- a missing agent output -> `missing`.
- judge hook: a fake judge's score shows up and its delta is computed; a throwing judge is recorded and does not fail.
- privacy: no file under `benchmarks/` contains `/Users/`, an image extension, or `data:image`.
- markdown renders the verdict and both tables.

## Hard rules
- Do not modify existing files except: add the `scripts/judges/` dir, and you may export small helpers from existing modules if needed (no behaviour change). Do not touch tests you did not write.
- **Speed: run only `node --test tests/benchmark.test.mjs` while iterating; run the full `npm test` once at the end.**
- No photos, no `.env`, no secrets read. No OpenRouter, no network.
- Commit on `feat/v2-benchmark` with clear messages. Do not push.

## Done = paste back raw output of
```
git log --oneline feat/v2-orchestrator..HEAD
node --test tests/benchmark.test.mjs
npm test 2>&1 | tail -8
node scripts/benchmark.mjs --run r4-dry6
node scripts/benchmark.mjs --run r4-dry5
```
