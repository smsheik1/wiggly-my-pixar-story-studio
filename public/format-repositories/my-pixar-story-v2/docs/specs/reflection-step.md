# Reflection / critic step (Google Sheet row 31): scoring note

Status: self-critique loop BUILT for the Story Director (graph/deep-agent-node.mjs, `reflectionRounds` in config/models.mjs: 2 for the SD, 0 for the others).
After the first draft the same agent critiques its own draft (plain model call: SKILL.md + input.json + draft + current gate findings; checks ending coherence
against `finaleThesis`, every line traceable to the answers, nothing invented or crammed, all role rules) and then rewrites it (a Deep Agent run that resubmits
through the typed submit tool). The gate runs on the final revision; gate failures keep the normal retry/escalation. Critiques and every draft are saved under
`runs/<runId>_attempt-N/<agent>/reflection/` and in state `reflections` (rehearsals write `outputs/reflections.json`).
The separate rubric-scoring critic below is still not built. This note fixes what that critic scores against.

- The critic scores every Story Director draft (and any Seedance Compiler line rewrite) against `shared/writing-tells.md`.
- It returns the rubric's Step 4 output format: SCORE + band, a FLAGS table, TOP 3 PRIORITIES, and rewritten lines when the score is 16 or more.
- It starts from the code linter's findings (`node crew/linter/writing-tells.mjs runs/<id>/outputs`), then adds the judgment tells code cannot see
  (announced feelings, same voice for everyone, theme said out loud, resume voiceover, forced callbacks, written-sounding kid dialogue, lost answer details).
- Hard tells are already blocked at the gates: WRITING_TELL_EM_DASH, WRITING_TELL_FORCED_NEGATION, WRITING_TELL_BANNED_PHRASE.
