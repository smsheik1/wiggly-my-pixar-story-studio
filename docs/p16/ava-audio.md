# P16: Ava (audio reviewer) back on Gemini — listenAudio finding

`listenAudio` audio bytes go to the `mediaReview` Gemini provider
(`K/runtime/gemini-review.mjs`, model `gemini-3.8-flash`), not to Ava's own model.
`runner.mjs` builds the Gemini review tools and passes them as perception adapters
to both hosts; `crewTools` routes `listenAudio` to that adapter, and Ava's worker
model only reads the returned report (`perception: direct-audio`, timestamps,
comfort flags). OpenRouter lists `google/gemini-3.8-flash` with audio input and
`meta/muse-spark-1.3-contributor` without it, so per the approved Oct 11 plan Ava
(`audio-reviewer` in `K/studio.json`) is bound to `google/gemini-3.8-flash`
anyway. The host sends Gemini the standard medium-effort / 16K-cap body — never
Muse's xhigh / 32K overrides. Offline guard: `K/tests/p16-ava-audio.test.mjs`
asserts Ava's model is in the committed `AUDIO_CAPABLE_OPENROUTER_MODELS`
allowlist. No network, no live model calls.
