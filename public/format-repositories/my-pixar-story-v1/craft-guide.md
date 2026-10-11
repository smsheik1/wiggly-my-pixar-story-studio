# Craft guide (STUB — frozen IDs for P14 step A)

<!-- STUB written by Grok Bot. Section IDs and rule IDs below are the FROZEN P14 contract.
     Muse rewrites the wording in step B but must keep every ID, its section and its check tag.
     Format: '## [section-id] Title' and '- [RULE-ID] (check: a, b) text'. Check tags: vera|sage|june|ava|beau|none. -->

## [house-style] House style

- [H-STYLE] (check: sage, vera, june) One house style line: feature-quality 3D animated film, production CG, not photorealistic and not flat cartoon.
- [H-OVERSHOOT] (check: sage) Push values further than you want ("deeply worn", not "slightly worn"); generators drift back to defaults.
- [H-NO-BRANDS] (check: sage, vera, june) No brand, vendor, renderer or film names in any prompt or brief, and never the word for the studio we are emulating.

## [script-craft] Script craft

- [S-NO-INVENTED-FACTS] (check: sage) No invented facts. This rule outranks every other craft rule.
- [S-DIRECT] (check: sage) Direct, don't transcribe: choose, order and emphasise only facts that exist in the answers.
- [S-ORDINARY-WORLD] (check: none) Open in the ordinary world before anything changes.
- [S-THREES] (check: sage) Rule of three and an escalating repeat, built only from facts in the answers.
- [S-PLANT-PAYOFF] (check: sage) Plant in beats 1-2, pay off in beat 4.
- [S-BUSINESS] (check: sage) Business over statement: show a person doing something, not a claim about them.
- [S-REACTION] (check: none) Decide whose face we cut to for each beat (shot planner note).
- [S-STOCK-PHRASES] (check: sage) Stock-phrase ban list (e.g. "my whole world", "meant everything", "Long before..." openers).
- [S-LAST-IMAGE] (check: sage) The last line is one specific image, not a statement of feeling.
- [S-CLEAR-SUBJECT] (check: sage) Every sentence has a clear subject; no dangling modifiers; no two locations in one sentence.
- [S-AGES-FORWARD] (check: sage) Ages and life stages only move forward.
- [S-QUOTES-VERBATIM] (check: sage) Real spoken lines are kept word for word.

## [character-design] Character design

- [C-FIXED-SWAP] (check: none) Separate fixed template lines from swap slots.
- [C-SHAPE] (check: sage) Name the dominant shape and silhouette in three words.
- [C-EXAGGERATION] (check: sage) One exaggeration, with its counterpart.
- [C-HEADS-TALL] (check: vera) Heads tall: toddler 4, child 5, teen 6-6.5, adult 7.
- [C-CHILD-RIDER] (check: sage, vera) Child proportion rider for children only, never on adults.
- [C-SIGNATURE] (check: sage, vera) One signature element, worn not held, carrying the only saturated colour.
- [C-WEAR] (check: none) Wear tells a story.
- [C-HANDS] (check: vera) Hands are designed and read clearly.
- [C-FACIAL-HAIR] (check: vera) Facial hair reads as a matte shell.
- [C-CAST-CONTRAST] (check: none) Design characters against each other.
- [C-TEMPLATE] (check: sage) Use the full character template.
- [C-EYEBROWS] (check: sage) Eyebrow setting chosen: groomed, graphic or sparse.
- [C-SKIN-ZONING] (check: sage, vera) Skin zoning light or deep; always switch to deep for dark skin.
- [C-HAIR] (check: sage, vera) Hair variant chosen (thin volume; tight coils named at three scales).

## [prompt-rules] Prompt rules

- [P-EMPTY-HANDS] (check: sage) Nothing in hands.
- [P-NO-SKIN-MARKS] (check: sage) No ink, pen or drawn marks on skin.
- [P-CHILD-ANATOMY] (check: sage) Avoid child anatomy words that misfire ("round belly", "full cheeks").
- [P-FULL-PROMPT] (check: sage) Always write the full prompt.
- [P-SHORT] (check: sage) Short; no commentary inside the prompt.
- [P-NO-AVOID-LIST] (check: sage) No avoid list.
- [P-NO-ASPECT-TEXT] (check: sage) No aspect ratio in the prompt text.
- [P-REF-RENDERS] (check: none) Don't act on reference renders.
- [P-GREY-NO-LIGHTING] (check: sage) No lighting lines on a grey backdrop.
- [P-MISREADS] (check: none) Avoid wording a generator can misread.
- [P-BRANDING-TRAPS] (check: sage) Design around branding traps: change the silhouette instead of writing "no logos".

## [identity] Identity

- [C-IDENTITY] (check: vera, sage) Skin tone, hair colour and face always match the person and their photos.
- [C-IDENTITY-OPTIONS] (check: sage) The 3 options vary only style strength, outfit, and pose or hair styling within what is true to the person.

## [character-sheet] Character sheet

- [R-SHEET-NEUTRAL] (check: vera) Neutral everything: pose, light, expression on the views.
- [R-SHEET-VIEWS] (check: vera, sage) Four full-body views (front, three-quarter, profile, back) on one baseline.
- [R-SHEET-EIGHT] (check: vera, sage) Fixed eight expressions in this order: neutral, happy, delighted, sad, surprised, confused, angry, talking.
- [R-SHEET-HEX] (check: vera, sage) Background is flat #B5B5B5 across the whole canvas, written as the hex in every prompt.
- [R-SHEET-NO-TEXT] (check: vera, sage) No text or labels on the sheet.
- [R-SHEET-PROPS] (check: none) Props and non-humanoid subjects follow the props variant.
- [R-SHEET-FAILURES] (check: vera) Known sheet failure modes (failure table).
- [R-SHEET-PHOTO-REF] (check: sage) For people with photos, the photos are the reference; there is no master render.
- [R-SHEET-NO-PHOTO] (check: none) PENDING (later PR, not wired in P14): a person with no photo gets one approved full-body render first.

## [edit-prompts] Edit prompts

- [E-ONLY-CHANGES] (check: sage) When working from an existing image, state only what changes.

## [locations] Locations

- [L-DRESSED] (check: vera, sage) Empty of people only, never an empty set: dressed from the story, lived-in, shows whose space and when.
- [L-SET-PLATE] (check: sage) The set plate is used only for space, materials, colours and light.
- [L-LAYOUT-REF] (check: sage, beau) A separate layout reference (in words in P14) sets positions and camera; ignore faces in it.
- [L-CAMERA-SIDE] (check: vera, beau) The camera stays on the same side as the layout reference for the whole location.
- [L-LIGHT-SPEC] (check: sage, beau) Per-location lighting and colour spec block, written once and copied whole into every prompt for that location.
- [L-PALETTE] (check: vera, sage) Muted palette with one saturated accent. Muted is not generic.
- [L-ACCENT-OUT] (check: vera, sage) The film's signature accent colour never appears in the room.
- [L-SHOTS-FIRST] (check: beau) Build the room for the shots the script needs; list scripted actions and positions first.
- [L-MIN-TEXT] (check: vera, sage) Minimal text: prefer none; at most 4 names if text must appear.
- [L-CHILD-DRAWINGS] (check: none) Children's drawings follow the children's-drawings rule.
- [L-SETS-DEFAULT] (check: none) Default sets style line used by the bible when a location has no override.

## [composition] Composition

- [K-BIND-REFS] (check: june) Bind every reference individually: what to use and what not to use.
- [K-ANCHORS] (check: june) Restate only the 1-2 design-critical anchors, never the whole design.
- [K-DEPICTIONS] (check: june) Depictions (a photo or drawing of a character) bind the reference inline.
- [K-SCREEN-SIDE] (check: june) Measurable screen-side language: character's left/right plus screen left/right.
- [K-HEIGHT-RULER] (check: june) A height ruler when two characters share a frame.
- [K-LAYOUT-REF] (check: june) Layout reference rules: faces ignored, camera stays on the layout's side.

## [video-sources] Video: sources

Later phase: video is not in production yet; follow your skill where it differs.

- [V-SOURCES] (check: june) Which image sources feed a video block and how each is bound.

## [video-animation] Video: animation

Later phase: video is not in production yet; follow your skill where it differs.

- [V-MOTION] (check: june) Motion is designed: anticipation, arcs, snap and settle, overlap, moving holds.
- [V-LIGHT] (check: june) Lighting is designed, not left to the generator.

## [video-architecture] Video: architecture

Later phase: video is not in production yet; follow your skill where it differs.

- [V-ONE-SHOT] (check: june) One block is one shot.
- [V-TIMECODES] (check: june) Whole-second timecodes.
- [V-CEILING] (check: june) 30 s ceiling per generation.

## [video-blocks] Video: blocks

Later phase: video is not in production yet; follow your skill where it differs.

- [V-EXCLUSIONS] (check: june) Exclusions sized to this segment's real risks.

## [video-transitions] Video: transitions

Later phase: video is not in production yet; follow your skill where it differs.

- [V-TRANSITIONS] (check: june) Transitions are named.

## [video-failures] Video: failures

Later phase: video is not in production yet; follow your skill where it differs.

- [V-FAILURES] (check: june) Known video failure modes (failure table).

## [working-method] Working method

- [W-WHAT-CHANGED] (check: sage) Every revision opens with what changed.
- [W-FULL-EVERY-TIME] (check: sage) Full prompt every time; no fragments.
- [W-REREAD] (check: none) Reread the whole prompt before returning it.
- [W-KNOCK-ONS] (check: none) Flag knock-on effects of a change.
- [W-NO-OVERSPEC] (check: none) Don't over-specify small staging business.
