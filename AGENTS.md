Scope: work in scripts/studio-spike/ and lib/. Treat public/format-repositories/my-pixar-story-v1/ as read-only unless a task names a kit file.
Never commit scripts/studio-spike/output/, sqlite, media, secrets.env or .env. Never print secrets.
Before claiming done: `npm test` must show fail 0 for studio and kit, and test counts must not drop.
No paid provider calls in tests. No force-push. No merging without the owner.
Operator: after any merge changing kit runtime code (public/format-repositories/my-pixar-story-v1/runtime/*.mjs, runner.mjs), in-progress runs must run `crew-refresh --message "..." --secrets ... --run <run>` before the next drive-codex (crew capabilityVersion hashes runtime sources); a stranded started receipt from CODEX_PROFILE_CHANGED is recovered with `dispatch-reconcile --not-dispatched true --message ...`.
