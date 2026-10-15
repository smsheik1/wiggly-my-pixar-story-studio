# Pipeline Linter (deterministic code) — PLANNED stub, no code yet
Checks on compiler output:
- shot durations sum <= 30 s per segment
- timecodes are whole-second integers, contiguous, non-overlapping
- every shot >= 2 s
- dialogue format (speaker tag + braced verbatim line)
- no forbidden live-action tokens (e.g. photorealistic, 35mm, film grain)
On failure: return exact errors to the compiler; retry-capped, then escalate.
