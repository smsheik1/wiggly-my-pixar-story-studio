# Spec: answer tracing (`scripts/trace-answers.mjs`)

> **Gate (BUILT, change 4):** the Story Director now cites its sources and a deterministic check runs on every draft:
> `crew/linter/answer-sources.mjs`, wired into `check-stage-play.mjs`. Every `dialogue`/`narration` line carries
> `source: { answer: '<key path in input.answers>', kind: 'verbatim' | 'paraphrase' | 'connective' }` and every part lists
> `answerSources`. Errors: `LINE_SOURCE_MISSING`, `LINE_SOURCE_UNKNOWN`, `SEGMENT_SOURCE_MISSING`, `SEGMENT_SOURCE_UNKNOWN`,
> `LINE_NOT_VERBATIM` (< 80% of the line's words in order from 1-2 answer sentences), `LINE_SOURCE_MISMATCH` (paraphrase with
> < 50% of its key words in the cited answer), `LINE_FACT_NOT_IN_SOURCE` (a name, number or time missing from the cited answer;
> connective lines may carry none), `CAST_NOT_IN_ANSWERS` (a cast person named nowhere in the answers, subject, cast notes or photos).
> Warnings: `CONNECTIVE_LINES_HIGH` (> max(2, 20% of lines)), `CONNECTIVE_LINE_LONG` (> 12 words), `SHOT_FACT_NOT_IN_SOURCE`
> (a name, digit or time in `whatWeSee` missing from the part's answerSources). Spelling variants (case, hyphens, possessives,
> plurals/-ed/-ing, one-letter typos in 5+ letter words, digits vs number words) match. Skipped when the input has no answers.
> The trace table is shown to the SD's self-review critique, which also returns its own `{"untraceable": [...]}` list; both
> are logged per round (`reflection.json`: `trace`, `untraceable`). Objects and events the checker cannot see are left to the
> critique and to the LLM audit below, which stays a post-run report (it costs model calls, so it is not in the gate).

Owner: Muse Spark 1.3 via OpenCode. Branch `feat/v2-answer-trace` off `feat/v2-orchestrator` (benchmark already merged). Local commits only.

## Goal
Prove the maker's real story survives the pipeline. For each concrete fact in the questionnaire answers, say what every agent did with it,
and list details agents invented with no source in the answers.

## Model route (hard rule)
All LLM calls go through the OpenCode CLI, **never OpenRouter and never `OPENROUTER_API_KEY`/secrets.env**:
```
opencode run -m opencode/muse-spark-1.3-contributor-free --variant xhigh --format json "<prompt>"
```
Implement one injectable function `museCall(prompt, { timeoutMs = 600000 }) -> string` in `scripts/lib/muse-opencode.mjs` that spawns that command
(`child_process.spawn`, no shell, prompt passed as one argv element or via `-f <tmpfile>` if > 100 KB), collects the JSON event stream, and returns the
final assistant text. Parse JSON from the reply robustly (strip ``` fences; take the first `{`..last `}`); one retry on parse failure with
"Reply with JSON only." appended. Kill the exact child PID on timeout. Tests inject a fake `museCall`; tests never spawn opencode.
If `opencode` is missing or fails, exit 1 with a clear message; do not fall back to any other provider.

## Inputs
`node scripts/trace-answers.mjs --run <runId|runs/<id>> [--answers <project.json or inputs.json>] [--cache-dir .cache/answer-facts] [--dry-run]`
- Answers default: `benchmarks/r4-dry6/inputs.json` (`.answers`, `.subject`, `.castDescriptions`, `.photoReferences[]` minus paths). A studio project json also works via `inputsFromProject()`.
- Outputs: `runs/<id>/outputs/{story-director,character-architect,location-scout,seedance-compiler}.json`.

## Step 1: fact extraction (one Muse call per answers file, cached)
Cache key = sha256 of the canonical JSON of the answers object. Cache file `<cache-dir>/<sha>.json`; reuse if present (no call). `.cache/` is gitignored.
Prompt asks for JSON `{ facts: [{ id: "F1", kind: "person|age|event|object|place|quote|relationship|trait|date", text, source: "<answers key path>", quote?: "<verbatim words>" }] }`.
Rules in the prompt: only concrete, checkable facts; one fact per item; keep verbatim quotes verbatim; no interpretation, no themes.
Validate with Zod; drop items missing `id/kind/text`; dedupe by normalized text.

## Step 2: per-agent judge (one Muse call per agent output present)
Input to the judge: the fact list + that agent's output JSON with obviously non-story fields removed (prompt templates boilerplate is fine to keep; strip `htmlScriptDocument`, `compiledPrompt`, `generationPayload`, asset keys). Cap at ~60 KB; if larger, truncate long strings to 800 chars.
Output JSON: `{ facts: [{ id, status: "kept|changed|dropped", evidence: "<short quote from the output or ''>", note? }], invented: [{ detail, evidence, severity: "minor|major" }] }`.
Definitions in the prompt: kept = present with the same meaning; changed = present but altered (age, name, place, wording of a quote, order of events); dropped = absent;
invented = a specific story detail (named person, event, object, place, quote, number) present in the output with no source fact. Generic staging (camera, lighting, wardrobe colour) is not invented.
Not every agent should carry every fact (Location Scout only places/objects; Character Architect only people/looks/ages). Each agent also gets `expectedKinds` and facts outside them are reported `n/a` instead of `dropped`:
SD: all kinds; CA: person, age, trait, relationship, object; LS: place, object, event; SC: all kinds.
Validate with Zod; any fact id missing from the reply becomes `unknown`.

## Step 3: report
Pure functions `traceAnswers({ facts, judgements })` -> model, `answerTraceMarkdown(model)`, `answerTraceHtml(model)`:
- Per agent: kept / changed / dropped / n/a / unknown counts, and `faithfulness = kept / (kept + changed + dropped)` (3 decimals; null if denominator 0).
- Overall `storyFaithfulness` = SC faithfulness if present else SD (what reaches the film).
- A fact table: fact text, then status per agent (✔ kept, ~ changed, ✖ dropped, · n/a). Highlight facts kept by SD but lost by SC ("lost downstream").
- Invented details per agent (major first).
Write `runs/<id>/answer-trace.md` and `answer-trace.json`, plus an HTML section inserted into `runs/<id>/report.html` and `~/wiggly-progress.html`
with markers `<!-- v2-answer-trace:start/end -->`, reusing `upsertSection` from `scripts/lib/audit.mjs`.

## Step 4: benchmark judge hook
Add `scripts/judges/answer-trace.mjs` exporting the judge per `docs/specs/benchmark.md` section 5: `score = storyFaithfulness`, details = per-agent counts.
It reads a cached `runs/<id>/answer-trace.json` if present and only calls Muse when it is missing and the judge is run with `--judge answer-trace`.

## Cost / dry run
`--dry-run` prints the number of calls it would make and the prompt sizes (chars and ~tokens = chars/4), and makes no call.
Use of the free OpenCode Muse model costs $0 on the OpenRouter key; still, log each call's duration.

## Tests: `tests/trace-answers.test.mjs`
`node:test` with `{ timeout: 10000 }` each; fake `museCall`; temp dirs cleaned; no child processes, no network.
- extraction is cached: second run with the same answers makes 0 calls; a changed answer makes 1.
- judge parsing: fenced JSON, missing ids -> unknown, bad JSON -> one retry then error.
- n/a by expectedKinds; faithfulness math; lost-downstream detection; invented sorted major first.
- markdown/html sections render; report.html upsert idempotent.
- judge hook returns `storyFaithfulness` from a cached answer-trace.json without calling museCall.
- museCall builds the exact argv (`run -m opencode/muse-spark-1.3-contributor-free --variant xhigh --format json`) using an injected spawn fake, and never references OPENROUTER.

## Hard rules
- Never read `secrets.env`, never use `OPENROUTER_API_KEY` or openrouter.ai.
- Do not change existing behaviour; only add files, plus `.cache/` in `.gitignore`.
- No photos in the repo. No push. **While iterating run only `node --test tests/trace-answers.test.mjs`; full `npm test` once at the end.**
- Paste back: `git log --oneline feat/v2-orchestrator..HEAD`, the test output, `npm test | tail -8`, and `node scripts/trace-answers.mjs --run r4-dry6 --dry-run`.
