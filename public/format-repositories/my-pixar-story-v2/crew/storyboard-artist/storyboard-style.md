# House storyboard style: My Pixar Story

Canonical and model-agnostic. Any agent, any image model: follow this file exactly and run `node scripts/check-panels.mjs --dir <panels>`; a panel set that fails the check is not done. Code reads its constants from `crew/storyboard-artist/style.mjs` and its prompt from `compile.mjs` (`panelPrompt`); `tests/storyboard-style.test.mjs` fails if this file and the code drift.

One style for every family's film. Panels are the visual contract the video model copies, so whatever is in a panel ends
up in the clip: bars, blur, softness, dim light and tiny characters included.

## Frame
- Every panel is its own image: native 16:9, rendered at 2K (at least 1920x1080). One shot = one image.
- Never pad, letterbox, blur-fill, stretch or upscale a panel. A panel that is not 16:9 or under 1920 px wide is
  rejected in code and re-rendered, never fixed in post.
- No borders, labels, captions or text inside the image. The shot id (part.shot, e.g. 1.4) lives in the file name and
  on the review contact sheet that code builds from the panels.

## Render look
- Polished 3D feature-animation film still: appealing stylized characters with large expressive eyes, soft global
  illumination, gentle subsurface skin, clean readable shapes, rich but natural colour. Not photoreal, not flat vector,
  not sketch or line art.
- Crisp and in focus on the characters; shallow depth of field only behind them.

## Shot sizes (coverage ladder)
- Each shot has one job: wide = where are we; full/medium = what the body does and who shares the space; medium
  close-up/close-up = the decision, reaction or feeling; insert = the one object that matters.
- Per part: at most one wide per three panels (usually the opener); at least one close-up or medium close-up in any
  part of 3+ panels; never three panels in a row at the same distance; a part of 4+ panels uses 3+ shot sizes.
- Two-shots and over-the-shoulder shots for shared moments; a low angle for pride or triumph, a high angle for
  smallness or vulnerability; eye level otherwise (child height when the hero is a child).

## Characters in frame
- Characters fill the frame for their shot size: in a medium the subject spans at least half the frame height, in a
  close-up the face fills the upper two-thirds. Even in the wide the hero reads clearly, never a tiny figure in a room.
- Faces toward camera or in clear three-quarter; eyes readable. Each character matches their approved render exactly
  (face, hair, skin, outfit, accessories).

## Light
- Light follows the scene's staged time of day from the script. Daytime scenes are bright: soft daylight through
  windows, warm sun, open shadows. Evening or night only when the script stages it, and then lit warm and readable
  (practical lamps plus a soft fill), never murky.
- One light per location within a scene, carried panel to panel.

## Sets
- The approved location plate is a reference for the set (architecture, furniture, colours, props), not for the
  camera. Recompose for each shot's size and angle; never reproduce the plate's wide framing behind a medium or close.

## Output spec (enforced by scripts/check-panels.mjs)
| Field | Value |
| --- | --- |
| Unit | one image per shot (no multi-panel sheets as production panels) |
| Aspect | 16:9 exactly (within 1%) |
| Resolution | 2K, at least 1920 px wide (e.g. 1920x1080, 2560x1440, 2752x1536) |
| Padding / blur bars / letterbox | never (PANEL_PADDED) |
| File name | `<part>.<shot>.png`, e.g. `1.4.png` (PANEL_NAME); the number is the script's shot id |
| Default model | `nano-banana-2.1` (Google Flow / Gemini image) at 2K; any model that accepts reference images may be used if its output passes the check |
| References | the shot's on-screen character renders (cast order), then its location plate; positions are 1..n |

Shot-size rules are enforced on the Storyboard Artist output by the gate (SB_NO_CLOSE, SB_TOO_MANY_WIDE, SB_SIZE_RUN, SB_ONE_SIZE, SB_SHOT_SIZE_UNKNOWN in crew/linter/check-storyboard.mjs).

## Panel prompt template (copy-paste exact)
One line per panel: STYLE BLOCK, then `Shot: ` and the slots, then TAIL BLOCK. Code builds it (`compilePanels`); by hand, fill the slots in this order.

STYLE BLOCK:
```
A single still frame from a polished 3D feature-animation film, native 16:9 widescreen, full bleed edge to edge: appealing stylized characters with large expressive eyes, soft global illumination, gentle subsurface skin, clean readable shapes, rich natural colour, crisp focus on the characters. Not photoreal, not flat vector, not sketch.
```

SLOTS (after `Shot: `):
```
<Shot size>, <angle>. Background: <setting name> (reference image <n>). <Name> (reference image <n>), a <age>-year-old <boy|girl|young man|young woman|man|woman>, with <skin tone> skin, wearing <approved outfit, word for word> (always visible on <Name>: <signature accessories>), with <props held>, <pose>, <expression>. Staging: <left/right/centre, foreground/background, eyelines>. Light: <staged time of day and light, carried through the scene>.
```

TAIL BLOCK:
```
Characters are large in frame for this shot size and match their reference images exactly (face, hair, skin, outfit, accessories). The background reference is the set only: keep its architecture, furniture, colours and props but recompose the camera for this shot size and angle. Light follows the staged time of day: daytime is bright soft daylight with open shadows; evening is warm and readable, never murky. No borders, no letterboxing, no padding, no blurred edges, no panel frame, no text, captions, labels, watermark or logos.
```

## Style anchors
Canonical example images live in `crew/storyboard-artist/style-anchors/` and are attached after the shot's references when the model takes extra images ("match the render look of the last reference image; do not copy its characters or set"). They must be generic example art (invented characters, no real family, no user photos). See that folder's README for the needed assets.
