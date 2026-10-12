# Sourced generation rates (studio.json `generation`)

All rates below are operator-verified and carried in the generation-planner
task packet as `generationEstimate`. Estimates are rounded UP to cents with a
$0.01 minimum. A plan with `estimatedCostUsd` below the estimate is rejected;
without a rate the planner returns planning-blocked.

- Video (Mini 480p): `seedance-2.0-mini@480p` at $0.04 per second of output
  video (`generation.video.rates`). Basis: Replicate
  bytedance/seedance-2.0-mini, image-to-video (non_video_in), 480p, per second
  of output video. Source: https://replicate.com/bytedance/seedance-2.0-mini.
  Verified 2026-10-11. Cost is `generationSeconds x usdPerSecond`.
  HD video (`seedance-2.0` 1080p) has no rate and stays blocked.
- Music: $0.15 per minute of generated music (`generation.music.usdPerMinute`).
  Basis: ElevenLabs API Music, $0.15 per minute of generated music; requests
  are fixed at music_length_ms 60000. Source:
  https://elevenlabs.io/pricing/api. Verified 2026-10-11. Cost is
  60 s x usdPerMinute/60.
- Effect: $0.12 per minute of generated audio
  (`generation.effect.usdPerMinute`). Basis: ElevenLabs API Sound Effects,
  $0.12 per minute of generated audio. Source:
  https://elevenlabs.io/pricing/api. Verified 2026-10-11. Cost is
  `durationSeconds x usdPerMinute/60`.
- Clone: no published price - blocked. Cartesia publishes no per-clone price;
  clone stays blocked until a human supplies one. No clone rate is stored.
