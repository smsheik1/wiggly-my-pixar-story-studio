Scope: work in scripts/studio-spike/ and lib/. Treat public/format-repositories/my-pixar-story-v1/ as read-only unless a task names a kit file.
Never commit scripts/studio-spike/output/, sqlite, media, secrets.env or .env. Never print secrets.
Before claiming done: `npm test` must show fail 0 for studio and kit, and test counts must not drop.
No paid provider calls in tests. No force-push. No merging without the owner.
