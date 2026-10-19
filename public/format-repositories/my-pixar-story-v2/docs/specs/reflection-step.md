# Reflection / critic step (Google Sheet row 31): scoring note

Status: self-critique loop BUILT for the Story Director (graph/deep-agent-node.mjs, `reflectionRounds` in config/models.mjs: 2 for the SD, 0 for the others). Since change 4 the SD critique also gets the deterministic answer trace table (`AGENT_SPECS['story-director'].trace`) and ends with an `{"untraceable": [...]}` JSON block; each log entry keeps `trace` (counts + rows) and `untraceable` (parsed list, or null).
After the first draft the same agent critiques its own draft (plain model call: SKILL.md + input.json + draft + current gate findings; checks ending coherence
against `finaleThesis`, every line traceable to the answers, nothing invented or crammed, all role rules) and then rewrites it (a Deep Agent run that resubmits
through the typed submit tool). The gate runs on the final revision; gate failures keep the normal retry/escalation. Critiques and every draft are saved under
`runs/<runId>_attempt-N/<agent>/reflection/` and in state `reflections` (rehearsals write `outputs/reflections.json`).

## Review rubric: the critique is an editor's pass (built)

The Story Director's critique call loads `crew/story-director/REVIEW.md` (`loadReview` in config/models.mjs) on top of its
SKILL.md. Same agent, same node, same model: no new crew member, node or config entry. The rubric is only in the critique
call; the writer's prompt and the rewrite never carry it. Agents without a REVIEW.md keep the generic focus list.

- **Framing.** The critic is an editor: it never rewrites, it scores and gives fix instructions. Read the whole draft once
  as a viewer, then check big to small (structure, then people and scenes, then lines); never polish a line in a beat that
  should be cut.
- **Checklist R1-R9**, each one yes/no question, PASS or FAIL with exact evidence (`part.shot` + quote; R1 also quotes the
  family's original sentence): R1 fidelity (only facts from the answers, told clearly; lines are written, not quoted), R2 invented
  details (props, objects, places, names, ages), R3 setup/payoff (no line depends on a dropped fact), R4 cast in the scene
  (seen or heard), R5 pronoun/referent clarity (finale above all), R6 finale (one idea = finaleThesis, ends on a whole
  sentence and an action/gesture), R7 time framing (adult cards in past moments framed as memory), R8 length (at or under
  `targetTotalRuntimeSec`; runtime creep fails; cut redundant/connective beats, never add; aim ~10% tighter), R9 gate rules
  (18 words, speech timing, 30 s parts, 2 on screen, speaker leads, sources, scene locks).
- **Output.** Per-item PASS/FAIL + evidence, `FIXES:` (at most 8, most important first, cuts before additions), a `Works:`
  line, then `VERDICT: SHIP|REVISE`. The critic also gets gate warnings (as things to check) and a runtime line (this
  draft, the target, the first draft).
- **Rewrite** applies only the listed fixes, changes nothing else, and does not make the output longer unless a fix needs it.
- **Early stop (backlog row 59).** `shipsAsIs`: VERDICT SHIP, no rubric item FAIL, and no gate error → no rewrite, and the
  remaining rounds are skipped. A gate error always gets a rewrite. The log records `verdict`, `fixes`, `runtimeBefore/After`,
  `stoppedEarly`; reflection.json adds `roundsRun`, `stoppedEarly`, `rubric`.
- **Drafting rules.** role.md carries the same checklist ("Draft to the review checklist"), so the first draft aims at it.

## Cheap gate checks that back the rubric (crew/linter)

- (Removed: `VERBATIM_SHARE_LOW`. The answers are raw material, not script lines; only their facts are checked.)
- `PRESENT_NEVER_SEEN` (shot-locks.mjs) is now an error: a scene's `present` member must be on screen or heard (dialogue,
  voice-over/off-camera, or narration) in one of its shots.
- `PROP_NOT_IN_ANSWERS` (warning): concrete objects in prop locks and `whatWeSee` whose word is in no answer, cast note or
  photo note; room furniture, car fixtures and body parts are exempt. One warning per object, listing where it appears.
- Patch mode: a prior whose gate errors are all inside the target part can be patched (the patch must fix them); errors
  elsewhere still give `PATCH_PRIOR_INVALID`.

## Writing-tells scoring note (separate rubric critic: not built)

This note fixes what a separate writing-tells critic would score against.

- The critic scores every Story Director draft (and any Seedance Compiler line rewrite) against `shared/writing-tells.md`.
- It returns the rubric's Step 4 output format: SCORE + band, a FLAGS table, TOP 3 PRIORITIES, and rewritten lines when the score is 16 or more.
- It starts from the code linter's findings (`node crew/linter/writing-tells.mjs runs/<id>/outputs`), then adds the judgment tells code cannot see
  (announced feelings, same voice for everyone, theme said out loud, resume voiceover, forced callbacks, written-sounding kid dialogue, lost answer details).
- Hard tells are already blocked at the gates: WRITING_TELL_EM_DASH, WRITING_TELL_FORCED_NEGATION, WRITING_TELL_BANNED_PHRASE.
