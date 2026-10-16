# Reflection / critic step (Google Sheet row 31): scoring note

Status: not built yet. This note fixes what the critic scores against.

- The critic scores every Story Director draft (and any Seedance Compiler line rewrite) against `shared/writing-tells.md`.
- It returns the rubric's Step 4 output format: SCORE + band, a FLAGS table, TOP 3 PRIORITIES, and rewritten lines when the score is 16 or more.
- It starts from the code linter's findings (`node crew/linter/writing-tells.mjs runs/<id>/outputs`), then adds the judgment tells code cannot see
  (announced feelings, same voice for everyone, theme said out loud, resume voiceover, forced callbacks, written-sounding kid dialogue, lost answer details).
- Hard tells are already blocked at the gates: WRITING_TELL_EM_DASH, WRITING_TELL_FORCED_NEGATION, WRITING_TELL_BANNED_PHRASE.
