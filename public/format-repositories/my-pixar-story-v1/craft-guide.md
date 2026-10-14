# Craft guide

House craft for every writer. Each section opens with `## [section-id] Title` and each rule is one line starting with its rule ID and check tag. Your skill says how to apply your sections to your task; the no-invented-facts rule wins any conflict.

## [house-style] House style

One look everywhere. Push values further than you want, because generators drift back to defaults.

- [H-STYLE] (check: sage, vera, june) Pixar-style 3D animated feature film: appealing sculpted forms, expressive faces, warm cinematic lighting and rich, saturated colour; production CG, never photoreal, never flat cartoon, never muted.
- [H-OVERSHOOT] (check: sage) Overshoot values: write "deeply worn", not "slightly worn"; generators drift back to defaults, so push further than you want.
- [H-NO-BRANDS] (check: sage, vera, june) No brand, vendor, model, renderer, tool, studio or film names in any image or video prompt: prompts describe the house look in words (sculpted forms, warm cinematic light, rich saturated colour). Briefs, the bible and reviews may name the Pixar target look.

## [script-craft] Script craft

Directing notes for narration. Our films are narrated memories, so these are polish inside the no-invented-facts rule, never a reason to invent. The no-invented-facts rule outranks every craft rule in this guide.

- [S-NO-INVENTED-FACTS] (check: sage) Use only facts from the answers; never invent names, dates, ages, places, objects, motives, or outside facts, and this rule outranks every other craft rule.
- [S-DIRECT] (check: sage) Direct, don't transcribe: choose, order, and emphasise only facts that exist in the answers, and cut the rest.
- [S-ORDINARY-WORLD] (check: none) Open in an ordinary world before anything changes, so the contrast lands.
- [S-THREES] (check: none) Prefer building the rule of three and any escalating repeat only from facts in the answers.
- [S-PLANT-PAYOFF] (check: none) Prefer planting in beats 1-2 what pays off in beat 4.
- [S-BUSINESS] (check: sage) Business over statement: show a person doing something, not a claim about them.
- [S-REACTION] (check: none) Decide whose face we cut to for each beat; the reaction is usually worth more than the action.
- [S-STOCK-PHRASES] (check: sage) Never use stock phrases: "proud doesn't begin to cover it", "my whole world", "meant everything", "my greatest masterpiece", or any "Long before..." opener.
- [S-LAST-IMAGE] (check: none) Prefer closing on one specific image rather than a statement of feeling.
- [S-CLEAR-SUBJECT] (check: sage) Every sentence has a clear subject: no dangling modifiers and no two locations in one sentence.
- [S-AGES-FORWARD] (check: sage) Ages and life stages only move forward, never backward.
- [S-QUOTES-VERBATIM] (check: sage) Real spoken lines from the answers are kept word for word.

## [character-design] Character design

Prompts are built from fixed lines (same for every character, encoding how the house builds a face and body) plus swap lines (the per-character slots). Never redesign the fixed block: fill the swap slots, pick a named setting where one is offered, and state the design calls you made.

- [C-FIXED-SWAP] (check: none) Separate fixed template lines from swap slots; fill the slots from evidence and state the design calls you made, asking at most one clarifying question.
- [C-SHAPE] (check: sage) Give every character one dominant shape with strong contrast between body regions, describable in three words and readable in pure black silhouette.
- [C-EXAGGERATION] (check: sage) Push one feature well past life size and push its neighbours the opposite way; an exaggeration stated alone gets averaged back.
- [C-HEADS-TALL] (check: vera) Height in heads: toddler 4, child 5, teen 6-6.5, adult 7. Write it as natural build wording, e.g. child: "slim child build, slightly enlarged expressive head, approximately five heads tall, narrow child shoulders and natural limbs"; teen: "approximately six-head-tall youthful proportions, slim-to-average build". Never draw a child or teen chunkier or bigger-headed than this.
- [C-CHILD-RIDER] (check: sage, vera) Child proportions are for children only: slim child build, slightly enlarged expressive head, narrow child shoulders, natural limbs; never carry this rider onto adults.
- [C-TODDLER-TORSO] (check: none) Writing tip: describe a toddler's torso as slim and flat; "round belly" or "full cheeks" comes back as a paunch.
- [C-SIGNATURE] (check: sage, vera) Give each character one signature element that is worn or attached, never held, and carries the only saturated colour in an otherwise muted palette.
- [C-WEAR] (check: none) Wear tells a story: grime where hands touch, pale worn edges, one thing undone or broken.
- [C-HANDS] (check: vera) Design hands from a few large rounded forms with thick blunt fingertips and minimal knuckle detail; vary only what the character justifies.
- [C-FACIAL-HAIR] (check: vera) Render facial hair as a soft matte shell over the skin colour, never as individual drawn hairs.
- [C-CAST-CONTRAST] (check: none) Design each new character against the existing cast so no two read as the same person.
- [C-TEMPLATE] (check: sage) Fill the full character template: labelled lines for eyes, eyebrows, face, subject, skin, silhouette, hair, wardrobe, pose, camera, and background, opening with the house look.
- [C-EYEBROWS] (check: sage) Pick one eyebrow setting: groomed (soft, hair-coloured, individual hairs), graphic (thick, dark, soft-edged), or sparse (fine, pale, barely visible).
- [C-SKIN-NATURAL] (check: sage, vera) Skin matches the photos exactly: even natural colour, no added redness on nose, ears or cheeks; dark skin stays rich, never grey. Write no nose, ear or cheek colour words in a prompt.
- [C-HAIR] (check: sage, vera) Build hair as volume at three scales at once with a dark occluded core and a matte finish; write thin hair as thin volume, and name the three scales explicitly for tight coils.

## [prompt-rules] Prompt rules

Short concrete prompts beat long ones: everything above earns its place, and long prompts get averaged.

- [P-EMPTY-HANDS] (check: sage) Nothing in the character's hands on character design and sheet prompts; props get their own prompt. Story frames hold only what the locked shot's action names.
- [P-NO-SKIN-MARKS] (check: sage) Never put ink, pen, or drawn marks on skin; a pen a character needs goes in a pocket, since marks render as tattoos.
- [P-CHILD-ANATOMY] (check: sage) Avoid anatomy words that misfire on children: describe a child's torso as slim, straight, and flat, never "round belly" or "full cheeks".
- [P-FULL-PROMPT] (check: sage) Always output the prompt in full, every variation and every edit; never truncate or write "same as above except".
- [P-SHORT] (check: sage) Keep prompts short: specify, don't philosophise.
- [P-NO-AVOID-LIST] (check: sage) No avoid list: keep at most the one or two essential negations (no text; empty of people) and drop the rest.
- [P-NO-ASPECT-TEXT] (check: sage) No aspect ratio in the prompt text; set it in the tool call.
- [P-REF-RENDERS] (check: none) Never ask the prompt to act on a reference render; describe the person, not the picture.
- [P-GREY-NO-LIGHTING] (check: sage) No lighting or grade lines on a grey studio backdrop; drive lighting with a reference image later.
- [P-MISREADS] (check: none) Avoid wording the image model can misread; write "the face is built from distinct planes", never "face planes".
- [P-BRANDING-TRAPS] (check: sage) Design around branding traps: change the silhouette instead of writing "no logos".

## [identity] Identity

For real people, the photos win over any design instinct. This replaces the old variation advice: likeness never varies.

- [C-IDENTITY] (check: vera, sage) Skin tone, hair colour, and face always match the person and their photos, and never vary.
- [C-MUST-KEEP] (check: vera, sage) Identity traits from intake stay fixed in every view: anything the person always wears or that is always part of how they look (the roster entry's `mustKeep`) appears in every figure, option, expression and keyframe, and is never dropped, swapped or restyled away.
- [C-IDENTITY-OPTIONS] (check: vera) The 3 options come from one prompt. They may differ only in style strength, outfit, and pose or hair styling, never likeness or a `mustKeep` trait.

## [character-sheet] Character sheet

Format B (turnaround plus expressions) is the only sheet format. For people with photos, the photos are the reference; the no-photo path below is pending and not wired anywhere.

- [R-SHEET-NEUTRAL] (check: vera) Keep everything neutral: closed-lip expression, head level, eyes to camera, arms relaxed, hands open and empty, feet flat and parallel; no smile, no acting, no signature pose.
- [R-SHEET-VIEWS] (check: vera, sage) Top row is four full-body views of the same character in one identical neutral pose (front, three-quarter, profile, back), exactly the same height and scale on one shared baseline, evenly spaced and clear of the frame edges.
- [R-SHEET-EIGHT] (check: vera, sage) Below are eight head-and-shoulders close-ups in two even rows of four, all facing camera, in this fixed order: neutral, happy, delighted, sad, surprised, confused, angry, talking; a character detail may sit inside a slot.
- [R-SHEET-HEX] (check: sage) Background is flat #B5B5B5 across the whole canvas, written as the hex in every prompt.
- [R-SHEET-NO-TEXT] (check: vera, sage) No text or labels on the sheet.
- [R-SHEET-PROPS] (check: none) Props and non-humanoid subjects use the props variant: front, back, and a detail close-up on the identifying feature, with neutral framing.
- [R-SHEET-FAILURES] (check: vera) Check the sheet against the failure table: the four turnaround views not the same height and scale; the close-up face not matching the reference; an adult with an oversized child-like head; dark skin rendering grey; facial colouring not in the reference, such as a red clown nose or heavy blush (the uploaded reference picture is the source of truth: render it in the house stylized animated feature style without inventing features it doesn't have, so red or rosy cheeks that match the reference are fine, and there is no fixed palette); anything held in the hands on the sheet.
- [R-SHEET-PHOTO-REF] (check: sage) For people with photos, the photos are the reference and there is no master render; where a kept render and the prompt disagree, describe the render.
- [R-SHEET-NO-PHOTO] (check: none) PENDING (later PR, not wired anywhere): a person with no photo gets one approved full-body render first, then the sheet is built from it.

## [edit-prompts] Edit prompts

Short but always complete: an edit prompt is a whole prompt, not a fragment.

- [E-ONLY-CHANGES] (check: sage) When working from an existing image, reference it and state only what changes.

## [locations] Locations

Rooms look like sets from a Pixar feature film: dressed from the story, empty of people only, in rich, saturated colour with warm cinematic light. A bland, muted or empty-feeling room fails. Example spec block for a brief:

Light: morning daylight through side windows, warm and soft, filling the room evenly. Bounce: cool bounce off pale walls. Practicals: no. Haze: no. Palette: rich honey woods, deep teal and warm mustard at roughly three to one. Accent: one hero colour on a story prop. Film accent kept out: <the bible's filmAccent colour, a prop colour, never a light>.

- [L-DRESSED] (check: vera, sage) Empty of people only, never an empty set (a writer rule, not prompt text): dress every set from the brief's known and proposed details with specific lived-in props showing whose space it is and when (era, age); neutral era-consistent dressing is fine, but a bland, generic catalog room still fails; forbid generic catalog rooms, plain unmarked objects, and blank walls.
- [L-SET-PLATE] (check: sage) Use the set plate only for space, materials, colours, and light.
- [L-LAYOUT-REF] (check: sage, beau) Set positions and camera from a separate layout reference written in words in the brief; ignore the faces in it.
- [L-CAMERA-SIDE] (check: vera, beau) The camera stays on the same side of the action line as the master for the whole location; turning within that half is fine.
- [L-LIGHT-SPEC] (check: sage, beau) Write one lighting and colour spec block per location in the brief and copy it whole into every prompt for that location: light source and time of day, bounce, practicals yes or no, haze yes or no, palette as a ratio, the one hero accent, and the production bible's `filmAccent` colour kept out.
- [L-PALETTE] (check: vera, sage) Rich, saturated feature-film palette with one hero accent on a story prop; a muted, washed-out or desaturated room fails, and so does a bland or empty-feeling one.
- [L-ACCENT-OUT] (check: vera, sage) Keep the production bible's `filmAccent` colour off the room's props and surfaces. The film accent is always a prop colour, never a light, so warm motivated light (lamplight, sunlight) is always allowed.
- [L-SHOTS-FIRST] (check: beau, sage) Build the room for the shots the script needs: list the scripted actions and positions in that space before writing.
- [L-MIN-TEXT] (check: vera, sage) No readable text in plates (no signs, labels, names, brands, logos, watermarks) except at most one hand-lettered item the brief explicitly names, reading exactly as named; any extra or unrequested text, brands/logos/real landmarks, or garbled lettering fails.
- [L-CHILD-DRAWINGS] (check: none) Draw children's drawings as a five-year-old hand works: heads bigger than bodies, arms straight out of the head, colour scribbled outside the lines, heavy uneven pressure, a floating blue strip for sky, a sun wedged in a corner, wobbly oversized letters running out of space, with ability varying across the wall.
- [L-SETS-DEFAULT] (check: none) Real Pixar feature-film sets: lived-in, story-dressed, rich saturated colour with one hero accent and warm cinematic light; empty of people, never an empty set, never muted.

## [composition] Composition

Place approved characters into locked plates without overwriting either reference with prose.

- [K-BIND-REFS] (check: june) Bind every reference individually with what to use from it and what not to use.
- [K-ANCHORS] (check: june) Restate only the 1-2 design-critical anchors per character, never the whole design; prose overwrites the reference.
- [K-DEPICTIONS] (check: june) When a character appears as a depiction (a photo or drawing inside the scene) rather than in person, bind that reference inline at the depiction.
- [K-SCREEN-SIDE] (check: june) Give positions in measurable screen-side language: the character's left and right plus screen left and right.
- [K-HEIGHT-RULER] (check: june) State a height ruler whenever two characters share a frame, so heights do not average out.
- [K-LAYOUT-REF] (check: june) Follow the layout reference with faces ignored and the camera kept on the layout's side.

## [video-sources] Video: sources

One silent clip per shot, generated from its approved keyframe.

- [V-SOURCES] (check: june) Tag only references actually uploaded, with stable element names; describe states, not transitions; start every clip from the shot's approved keyframe as its first frame.

## [video-animation] Video: animation

Motion and light that match the keyframe.

- [V-MOTION] (check: june) Design one action per clip as observable results: anticipation winding the opposite way first, snap and settle with a small overshoot, moving holds that breathe, follow-through where hair and cloth arrive late, arcs for hands and heads, and weight read from timing.
- [V-LIGHT] (check: june) Design lighting per clip from the keyframe: key direction and colour, rim for separation, bounce colour, practicals, atmosphere, and palette as a ratio with one accent; keep the keyframe's stylized animated-feature look.
- [V-TALK] (check: june) Narration only: the main track is narration, so the viewer hears the narrator and never a character's voice, and no character dialogue is ever heard as active speech. Every clip sets `talk`. Use `mos` only when the script says something about people talking, or it plainly makes sense to show them talking; they are then shown in conversation as B-roll under the narration, with loose, unsynced mouth movement and no lip-sync or speech text. Otherwise use `none` (the default): nobody on screen talks.

## [video-architecture] Video: architecture

Single-shot silent clips in the configured 480p profile.

- [V-ONE-SHOT] (check: june) One clip per shot: generate from the shot's approved keyframe as its first frame and trim the clip to the shot.
- [V-DURATION] (check: june) Generate 4-15 whole seconds per clip (generationSeconds integer 4-15); clip duration is a whole number of 30 fps frames.
- [V-FORMAT] (check: june) Generate silent 480p clips (864x496 16:9); narration, music and effects are added later.

## [video-blocks] Video: blocks

One prompt block per clip.

- [V-EXCLUSIONS] (check: june) Phrase each clip prompt positively with at most one or two negations; state one camera move, one action, and 1-2 look and design anchors.

## [video-transitions] Video: transitions

Clips cut together; transitions are the exception.

- [V-TRANSITIONS] (check: june) Cut hard between clips by default; name and justify any other transition.

## [video-failures] Video: failures

Reject defects, not taste.

- [V-FAILURES] (check: june) Check the clip against the video failure table: floaty even motion, photoreal drift, generic characters, dead holds, unison ensembles, mugging faces, dead eyes, uninvited fades, left-right flips, and averaged heights.

## [working-method] Working method

Prompts get pasted whole into a generator, so a fragment forces a hand-merge where errors get in.

- [W-WHAT-CHANGED] (check: sage) Open every revision with what changed: what was understood from the note and what was altered.
- [W-FULL-EVERY-TIME] (check: sage) Output the full prompt every revision and every variation, no exceptions; never fragments, loose shots, or "everything else unchanged".
- [W-REREAD] (check: none) Reread the whole prompt on every pass before returning it.
- [W-KNOCK-ONS] (check: none) Flag knock-on effects of a change in one line instead of silently patching or ignoring them.
- [W-NO-OVERSPEC] (check: none) Don't over-specify small staging business: state the action and leave the choreography.
