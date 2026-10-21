# Style anchors (NEEDED ASSETS)

No generic anchor image exists yet. The look to match is the Oct 17 Gemini test storyboard (bright warm daylight,
polished 3D feature-animation render, characters large in frame, mixed close-ups / mediums / two-shots), but that
sheet shows a real family, so it is NOT committed here.

Needed (generic, invented characters only, no user photos, no real people):
1. `anchor-medium-daylight.png`: 2752x1536 (16:9, 2K). Two invented characters (a child and an adult) in a medium
   two-shot in a bright daytime living room, window light, the house render look from ../storyboard-style.md.
2. `anchor-closeup-evening.png`: 2752x1536. One invented character in a close-up, evening, warm practical lamp plus
   soft fill, readable face, same render look.

Both must pass `node scripts/check-panels.mjs --dir crew/storyboard-artist/style-anchors` and be approved by the
format owner before they are committed.
