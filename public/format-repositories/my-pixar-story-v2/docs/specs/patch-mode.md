# Patch mode

Fix one thing without redoing the whole story. The maker points at a target (a line, a shot or a part) by id and says
what is wrong in plain words. Only that piece is rewritten, a code check proves nothing else changed, and downstream
only what the change touches runs again. Nothing is rendered; the run lists which Seedance parts would need re-rendering.

Code: `scripts/patch.mjs` (CLI), `graph/patch.mjs` (LangGraph patch graph), `crew/linter/patch-scope.mjs` (target ids
and the scope proof), `makeSeedancePatchSchema` in `crew/seedance-compiler/schema.mjs`. Tests: `tests/patch-mode.test.mjs`.

## Usage

```sh
# check the target and the prior run first (no model calls, writes nothing)
node scripts/patch.mjs --from r5-dry1 --target line:2.3.narration --check

# patch it: writes runs/r5-dry1-patch-1/ (runs/r5-dry1/ is only read)
node scripts/patch.mjs --from r5-dry1 --target line:2.3.narration \
  --note "Gran said she kept the letters in the biscuit tin, not a shoebox."
```

Options: `--run-id <id>` (default `<from>-patch-1`, `-2`, …; an existing run id is refused), `--project <project.json>`
(default `runs/<from>/project.json`), `--placeholder-assets` (fake approvals for a new character or location reference,
no images), `--reflection-rounds N` (Story Director self-review rounds, default 1), `--no-tracing`, `--secrets <file>`.
Like a rehearsal, a patch is a real LangGraph pipeline run on the OpenRouter key; tests use fake models only.

## Target ids

| Target | Id | Example |
|---|---|---|
| a spoken line | `line:<part>.<shot>[.dialogue\|.narration]` | `line:2.3.narration` (the kind may be left out when the shot has one line) |
| a shot | `shot:<part>.<shot>` | `shot:1.4` |
| a part | `part:<part>` | `part:3` |

Bare `2`, `2.3` and `2.3.dialogue` work too. A wrong id fails with a plain message listing the real parts/shots.

## What may change (everything else is byte-identical)

`checkPatchScope(prior, next, target)` diffs the two Story Director outputs field by field. Every changed path must be:

- **Inside the target.** Line: that line's fields (speaker, line, flags, source). Shot: every field of the shot except
  `shotNumber` and `startSec`. Part: the whole part except `segmentId`.
- **A timing ripple** (line and shot targets). The target shot's `endSec` may move by Δ seconds (a longer line needs a
  longer shot, never a shorter line). Every later shot in the same part shifts by exactly Δ, and the part's
  `targetDurationSec`, its `shapeBar.parts` duration and `shapeBar.totalRuntimeSec` move by Δ or stay put. Anything
  else is `PATCH_TIMING_RIPPLE`. Earlier shots and other parts are locked.
- **Dependent fields.** All targets: the part's `answerSources`. Shot targets: `present` / `props` of the scene lock that
  contains the shot, the shot's storyboard panel and its sheet's `fullPrompt`. Part targets: the part's storyboard
  sheets, its `shapeBar.parts` entry and `shapeBar.totalRuntimeSec`; for the **final** part also `finaleThesis`.
- **Append-only additions** (shot and part targets): new cast cards / locations at the end of `cast` / `locations`.
  Existing cards are locked (`PATCH_LOCKED_APPEND` if one moves or changes).
- **Derived or bookkeeping:** `htmlScriptDocument` (the rendered deck, not passed downstream), `masthead.draftNumber`,
  `assumptions`.

Anything else is `PATCH_OUTSIDE_TARGET`, with the path and the before/after values. A line or shot target keeps the
part's shot count (target the part to add or remove shots).

## The Story Director patch

The agent's input is its normal input (the family's answers, cast notes, photo characters) plus
`patch: { target, note, editable, currentOutput }`. The first message is a patch task (fix only the target, copy
everything else character for character) and it resubmits the **whole** output through the normal validated
`submit_story_director`. Its gate is the scope proof **plus** the full Story Director gate (answer tracing, shot locks,
speech timing, finale). A failure goes back as retry notes under the normal limit (`MAX_ATTEMPTS` = 3); each retry
starts again from `currentOutput`. After 3 failures the run escalates and nothing downstream runs.

**Self-review in patch mode: 1 round, scoped to the target** (`patchReflectionRounds: 1` in `config/models.mjs`;
`--reflection-rounds` overrides, 0 turns it off). A full run uses 2 rounds over the whole story; a patch is a small
edit, so one round catches a broken rule in the new piece without paying for a full re-review. The critic is told the
review is scoped to the target and the note, gets the gate result (which includes the scope proof), and is asked to
list any change outside the target as a problem. The prior output is not sent to the critic twice (the draft carries it).

The prior Story Director output must match today's contract and pass today's gate (`PATCH_PRIOR_INVALID` otherwise), except for gate errors inside the target part, which the patch must fix (`--check` lists them):
outside the target nothing may change, so a prior run that breaks a newer rule can only be fixed by a full run.

## Downstream: only what the change touches

`computeImpact(prior, next)` (deterministic):

- **Seedance Compiler.** Each part's compiler input slice (`seedanceSegmentsOf`) is compared before and after (line
  sources are ignored; the compiler never sees them). Only parts whose slice changed are compiled again. The agent sees
  only those parts plus `patch.compileParts` (each keeps its `segmentIndex` / `extendsFrom` in the whole film) and
  `patch.priorSegments` (the prompts before the change, to keep their wording where nothing changed). It submits only
  those parts (`makeSeedancePatchSchema`); code merges them into the prior output and runs the full Seedance gate on the
  whole film. Every other part's prompt is reused unchanged.
- **Character Architect** runs only if a new cast card appears, for the new cards only; existing characters are kept
  as they are and keep their `@Image N` (new ones are numbered after them).
- **Location Scout** runs only if a new location appears, for the new settings only; existing plates keep their
  `@Loc N`. When shots move between existing locations, the plates' `sceneIds` are re-synced in code (no model call)
  and the plate gate is run on the result.
- **Asset approval** carries the prior approvals. A new `@Image N` / `@Loc N` needs approval, so the run stops at
  `awaiting-approval` (or `--placeholder-assets` fills fake keys).

## Outputs

`runs/<new>/outputs/` starts as a byte copy of the prior outputs; only outputs the patch changed are rewritten.
`runs/<new>/patch.json` records `from`, `target`, `note`, `status`, the scope text, `reran` (agents that ran),
`outputsChanged`, `impact` (`sdChangedPaths`, `changedShots`, `newCast`, `newLocations`, `scParts`), escalations and
**`rerender`**:

- `parts`: each Seedance part whose prompt changed (Seedance renders a part as one clip), with the stage-play shots
  that changed, `changedPromptShots` (SHOT blocks whose text changed) and `changedBlocks`.
- `continuityFollowUps`: the part after each re-rendered part. It extends from that part's last frame, so it needs a
  re-render only if that last frame changes.
- `notCompiledYet`: affected parts not compiled because the run stopped (e.g. awaiting approval).

The prior run directory is only read; a second patch of the same run gets the next id.
