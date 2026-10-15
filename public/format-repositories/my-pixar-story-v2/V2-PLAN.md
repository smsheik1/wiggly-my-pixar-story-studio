# V2 plan: 4 creators + 1 image reviewer + code linter

Status: scaffold only. v1 (tag `crew-v1-frozen`) remains the live pipeline.

## The line
1. **story-director** — premise/answers -> script + stage play (beats, staging, movement, camera, whole-second timing, any dialogue). Replaces Leo + Sam.
2. **HUMAN SCRIPT GATE** — Shaz approves the stage play before any image or video credits are spent.
3. **character-architect** and **location-scout** (in parallel)
   - character-architect: cast + character sheet prompts for Nano Banana 2.1 in Google Flow. Replaces Cleo + Pia.
   - location-scout: empty-plate location prompts. Replaces Beau + Theo.
4. **Vera (image reviewer)** — likeness of sheets, quality of plates.
5. **seedance-compiler** — approved stage play + references -> Seedance 2.5 reference-to-video prompt. Replaces Cam + Mo + Vin + Max + Nora + Finn + Eli.
6. **linter (deterministic code)** — hard-rule checks on the compiler output; on failure returns exact errors to the compiler (retry-capped, then escalate).
7. Seedance 2.5 render (480p during testing).

Retired with no direct replacement: June and Ava (LLM reviewers -> human gate + linter + Vera), Sage (folded into June earlier).

## Build order (one at a time; prove each before the next)
1. story-director  2. character-architect  3. location-scout  4. seedance-compiler  5. linter
6. **Only after all prior agents are proven:** a Seedance 2.5 test.

## Retirement rule
A v1 agent is retired only when its v2 replacement beats it on the **same r5 inputs**.
Until then v1 code paths are untouched.

## Verified (fact-check, Oct 15 2026)
- Seedance 2.5 renders up to 30 s per generation, multi-shot, with native dialogue/lip-sync, SFX, music; takes reference images (up to 30).
- Image model stays Nano Banana 2.1 via Google Flow.

## UNVERIFIED / known-wrong claims
- **"Official 10-block schema" is NOT official.** It came from `../my-pixar-story-v1/craft-sources/dan-kieft-pixar-prompter.md`. Use ByteDance's official format: goal, reference roles (with exclusions), timestamped shots, consistency block.
- **Voice binding = similar voice, not a clone.** Cloned narration (Cartesia) may still be needed on top. Black-screen MP4 voice reference trick: unverified.
- Multi-shot face likeness across one render: unproven.
- Real-face/child-face filter behaviour on stylized sheets: untested.
- Model internals, star ratings, "<2 s shots blur" claims: unverified (we still enforce min 2 s as a safe rule).
- Format change: v2 assumes on-screen dialogue may be used; Wiggly v1 is narrated. Product decision pending.
