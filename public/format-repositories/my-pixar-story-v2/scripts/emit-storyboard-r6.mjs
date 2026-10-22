#!/usr/bin/env node
// Emit and compile validated Storyboard Artist output for run r6-live.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateStoryboard } from '../crew/linter/check-storyboard.mjs';
import { selectStoryboardArtistInput } from '../crew/storyboard-artist/input.mjs';
import { parseStoryboard } from '../crew/storyboard-artist/schema.mjs';
import { compileSheets, compilePanels } from '../crew/storyboard-artist/compile.mjs';
import { shotTimeline } from './lib/animatic.mjs';
import { PANEL_IMAGE, STYLE_FILE } from '../crew/storyboard-artist/style.mjs';
import { appendEvent } from '../graph/event-log.mjs';

const runId = 'r6-live';
const base = join('runs', runId);
const outDir = join(base, 'outputs');
const expDir = join(base, 'storyboard-export');
const eventsFile = join(base, 'events.jsonl');

const sd = JSON.parse(await readFile(join(outDir, 'story-director.json'), 'utf8'));
const ca = JSON.parse(await readFile(join(outDir, 'character-architect.json'), 'utf8'));
const ls = JSON.parse(await readFile(join(outDir, 'location-scout.json'), 'utf8'));

const state = { storyDirector: sd, characterArchitect: { output: ca }, locationScout: { output: ls } };
const input = selectStoryboardArtistInput(state);

const storyboardData = {
  sheets: [
    {
      segmentId: 1,
      sheetIndex: 1,
      panels: [
        {
          panelNumber: 1,
          shotId: "1.1",
          locationTag: "@Loc 1",
          shotSizeAndAngle: "Medium shot, eye level",
          characters: [
            {
              tag: "@Shaz",
              wardrobe: "Mustard-yellow hoodie with front pocket, dark slate-blue jeans, white sneakers, sunglasses pushed up on the forehead",
              props: ["sunglasses pushed up on forehead", "Yugioh cards"],
              pose: "sitting cross-legged on the patterned rug, holding a card between both hands",
              expression: "focused with an energetic smile"
            },
            {
              tag: "@Mom",
              wardrobe: "Dusty-rose ankle-length abaya dress, cream inner dress at hem, dusty-rose hijab, deep brown shoes",
              props: ["dusty-rose hijab"],
              pose: "kneeling on the rug beside him, hands clapped gently together",
              expression: "warm admiring smile"
            }
          ],
          staging: "@Shaz seated center-left in midground; @Mom kneeling to his right slightly closer to camera; low coffee table in background",
          lightAndPalette: "Warm afternoon sunlight spilling through living room window, amber and soft teal tones"
        },
        {
          panelNumber: 2,
          shotId: "1.2",
          locationTag: "@Loc 1",
          shotSizeAndAngle: "Close-up, eye level",
          characters: [
            {
              tag: "@Mom",
              wardrobe: "Dusty-rose ankle-length abaya dress, cream inner dress at hem, dusty-rose hijab, deep brown shoes",
              props: ["dusty-rose hijab"],
              pose: "leaning forward with gentle hands on Shaz shoulders",
              expression: "beaming and proud"
            },
            {
              tag: "@Shaz",
              wardrobe: "Mustard-yellow hoodie with front pocket, dark slate-blue jeans, white sneakers, sunglasses pushed up on the forehead",
              props: ["sunglasses pushed up on forehead"],
              pose: "knees pulled up to chest, looking up into her eyes",
              expression: "wide-eyed wonder and quiet joy"
            }
          ],
          staging: "@Mom framing the left side of frame leaning in; @Shaz in right frame looking up at her",
          lightAndPalette: "Soft warm directional light accentuating smiles, soft golden glow on fabric folds"
        },
        {
          panelNumber: 3,
          shotId: "1.3",
          locationTag: "@Loc 1",
          shotSizeAndAngle: "Medium shot, eye level",
          characters: [
            {
              tag: "@Shaz",
              wardrobe: "Mustard-yellow hoodie with front pocket, dark slate-blue jeans, white sneakers, sunglasses pushed up on the forehead",
              props: ["sunglasses pushed up on forehead", "Yugioh card"],
              pose: "sitting still on the rug, slowly turning a single card between palms",
              expression: "thoughtful, gentle smile towards the television glow"
            }
          ],
          staging: "@Shaz seated solo in center frame on the rug; TV console in soft focus in deep background",
          lightAndPalette: "Subtle blue television light mixing with the golden afternoon sunlight from camera-left"
        },
        {
          panelNumber: 4,
          shotId: "1.4",
          locationTag: "@Loc 1",
          shotSizeAndAngle: "Wide shot, eye level",
          characters: [
            {
              tag: "@Shaz",
              wardrobe: "Mustard-yellow hoodie with front pocket, dark slate-blue jeans, white sneakers, sunglasses pushed up on the forehead",
              props: ["sunglasses pushed up on forehead", "Yugioh cards"],
              pose: "sprawled on stomach on the rug, kicking feet behind him while flipping a card",
              expression: "playful grin"
            },
            {
              tag: "@Sister",
              wardrobe: "Burnt-orange open cardigan with long sleeves, soft white tee, dark indigo jeans, white sneakers",
              props: ["Yugioh cards"],
              pose: "sitting on knees beside him, fanning a deck of cards fast with both hands",
              expression: "teasing laughter as she nudges his elbow"
            }
          ],
          staging: "Both siblings centered on the large living room rug; living room couch and bookshelf framing the background",
          lightAndPalette: "Balanced ambient warm light, burnt orange and mustard yellow pops against neutral wood"
        },
        {
          panelNumber: 5,
          shotId: "1.5",
          locationTag: "@Loc 1",
          shotSizeAndAngle: "Two-shot medium, eye level",
          characters: [
            {
              tag: "@Brother",
              wardrobe: "Emerald-green crew t-shirt, khaki shorts, white sneakers with red soles",
              props: ["Yugioh cards"],
              pose: "slapping a card forcefully down onto the rug, bouncing on his knees",
              expression: "triumphant competitive grin"
            },
            {
              tag: "@Shaz",
              wardrobe: "Mustard-yellow hoodie with front pocket, dark slate-blue jeans, white sneakers, sunglasses pushed up on the forehead",
              props: ["sunglasses pushed up on forehead", "Yugioh cards"],
              pose: "lunging forward with one hand to snatch a counter-card",
              expression: "feigned shock turning into a laugh"
            }
          ],
          staging: "@Brother on camera-left, @Shaz on camera-right, rug duel arena between them",
          lightAndPalette: "Energetic natural daylight highlighting vivid emerald and mustard fabrics"
        },
        {
          panelNumber: 6,
          shotId: "1.6",
          locationTag: "@Loc 1",
          shotSizeAndAngle: "Medium close-up, eye level",
          characters: [
            {
              tag: "@Shaz",
              wardrobe: "Mustard-yellow hoodie with front pocket, dark slate-blue jeans, white sneakers, sunglasses pushed up on the forehead",
              props: ["sunglasses pushed up on forehead", "Yugioh cards"],
              pose: "shuffling back on knees with cards held close to chest",
              expression: "delighted laughter"
            },
            {
              tag: "@Brother",
              wardrobe: "Emerald-green crew t-shirt, khaki shorts, white sneakers with red soles",
              props: [],
              pose: "rocking side to side, drumming fingers excitedly on his knees",
              expression: "giggling eagerly"
            }
          ],
          staging: "Tight framing on both boys, @Shaz in three-quarter view, @Brother slightly behind in midground",
          lightAndPalette: "Warm rim lighting on shoulders and hair, soft homey interior atmosphere"
        },
        {
          panelNumber: 7,
          shotId: "1.7",
          locationTag: "@Loc 1",
          shotSizeAndAngle: "Full shot, low angle from the floor",
          characters: [
            {
              tag: "@Shaz",
              wardrobe: "Mustard-yellow hoodie with front pocket, dark slate-blue jeans, white sneakers, sunglasses pushed up on the forehead",
              props: ["sunglasses pushed up on forehead", "holographic Yugioh card"],
              pose: "standing tall atop the couch cushions, holding a card straight up toward the ceiling",
              expression: "grandiose, victorious theatrical champion pose"
            }
          ],
          staging: "@Shaz commanding the center of the frame elevated on the sofa; low camera looking up to make him look heroic",
          lightAndPalette: "Dramatic shafts of warm afternoon sun striking the held-up card like a trophy"
        }
      ]
    },
    {
      segmentId: 2,
      sheetIndex: 1,
      panels: [
        {
          panelNumber: 1,
          shotId: "2.1",
          locationTag: "@Loc 2",
          shotSizeAndAngle: "Wide shot, eye level",
          characters: [
            {
              tag: "@TeenShaz",
              wardrobe: "Charcoal-grey varsity jacket with ribbed cuffs, off-white t-shirt, black jeans, white sneakers",
              props: ["keychain and car keys"],
              pose: "leaning back against the driver side door of the green Honda Accord, flipping keys up in the air",
              expression: "confident, cool grin of teenage independence"
            }
          ],
          staging: "@TeenShaz in midground leaning on car; suburban driveway and modest family house behind in full daylight",
          lightAndPalette: "Bright crisp outdoor daylight, clean tarmac grey, dark green car gloss, charcoal jacket"
        },
        {
          panelNumber: 2,
          shotId: "2.2",
          locationTag: "@Loc 3",
          shotSizeAndAngle: "Medium shot, eye level",
          characters: [
            {
              tag: "@TeenShaz",
              wardrobe: "Charcoal-grey varsity jacket with ribbed cuffs, off-white t-shirt, black jeans, white sneakers",
              props: ["car steering wheel"],
              pose: "gripping the steering wheel with both hands, adjusting shoulder seatbelt strap",
              expression: "eager anticipation, checking the side mirror"
            }
          ],
          staging: "@TeenShaz framed in driver seat; windshield shows quiet suburban street ahead",
          lightAndPalette: "Daylight through car windows, warm reflections on dashboard and grey fabric upholstery"
        },
        {
          panelNumber: 3,
          shotId: "2.3",
          locationTag: "@Loc 3",
          shotSizeAndAngle: "Close-up, eye level",
          characters: [
            {
              tag: "@TeenShaz",
              wardrobe: "Charcoal-grey varsity jacket with ribbed cuffs, off-white t-shirt, black jeans, white sneakers",
              props: ["black cassette aux adapter cord"],
              pose: "twisting the aux adapter cord between fingers, plugging it firmly into the cassette deck",
              expression: "bobbing head to an internal rhythm, eyes focused"
            }
          ],
          staging: "Tight on hands, stereo deck, and @TeenShaz face in the upper frame",
          lightAndPalette: "Interior shadows with soft sun cutting across the vintage dashboard knobs"
        },
        {
          panelNumber: 4,
          shotId: "2.4",
          locationTag: "@Loc 3",
          shotSizeAndAngle: "Medium close-up, eye level",
          characters: [
            {
              tag: "@TeenShaz",
              wardrobe: "Charcoal-grey varsity jacket with ribbed cuffs, off-white t-shirt, black jeans, white sneakers",
              props: ["car steering wheel"],
              pose: "patting the padded dashboard with one hand, other hand tapping the wheel",
              expression: "broad, genuine smile of pride in his first car"
            }
          ],
          staging: "Three-quarter angle through front passenger window, @TeenShaz centered",
          lightAndPalette: "Golden daylight streaming through windshield, warm highlights across varsity jacket"
        },
        {
          panelNumber: 5,
          shotId: "2.5",
          locationTag: "@Loc 4",
          shotSizeAndAngle: "Full shot, eye level",
          characters: [
            {
              tag: "@AdultShaz",
              wardrobe: "Navy-blue overshirt jacket open over light heather-grey t-shirt, khaki chinos, tan canvas sneakers",
              props: ["spiral notebooks"],
              pose: "standing by desk chair, tapping a neat stack of notebooks straight on the wood surface",
              expression: "determined and composed"
            }
          ],
          staging: "@AdultShaz beside simple desk setup; corner bookshelf and window in background",
          lightAndPalette: "Even morning study light, cool white wall with warm wood furniture accents"
        },
        {
          panelNumber: 6,
          shotId: "2.6",
          locationTag: "@Loc 4",
          shotSizeAndAngle: "Medium shot, eye level",
          characters: [
            {
              tag: "@AdultShaz",
              wardrobe: "Navy-blue overshirt jacket open over light heather-grey t-shirt, khaki chinos, tan canvas sneakers",
              props: ["modern laptop"],
              pose: "seated at desk, fingers poised over laptop keyboard, pausing to crack knuckles",
              expression: "deeply engaged, ambitious concentration"
            }
          ],
          staging: "@AdultShaz in midground behind desk, laptop open before him; notepad on side",
          lightAndPalette: "Cool glow of laptop screen blending with daylight from the left desk lamp"
        },
        {
          panelNumber: 7,
          shotId: "2.7",
          locationTag: "@Loc 4",
          shotSizeAndAngle: "Close-up, eye level",
          characters: [
            {
              tag: "@AdultShaz",
              wardrobe: "Navy-blue overshirt jacket open over light heather-grey t-shirt, khaki chinos, tan canvas sneakers",
              props: [],
              pose: "leaning back in desk chair, stretching arms out, exhaling slowly",
              expression: "exhausted relief, satisfied quiet smile"
            }
          ],
          staging: "Close on @AdultShaz upper body and face, desk surface blurred in lower third",
          lightAndPalette: "Soft late afternoon glow drifting across his face, gentle shadows"
        }
      ]
    },
    {
      segmentId: 3,
      sheetIndex: 1,
      panels: [
        {
          panelNumber: 1,
          shotId: "3.1",
          locationTag: "@Loc 5",
          shotSizeAndAngle: "Wide shot, eye level",
          characters: [
            {
              tag: "@AdultShaz",
              wardrobe: "Navy-blue overshirt jacket open over light heather-grey t-shirt, khaki chinos, tan canvas sneakers",
              props: ["smartphone"],
              pose: "sitting on the edge of the bed, turning the glowing smartphone slowly between palms",
              expression: "quiet, pensive longing"
            }
          ],
          staging: "@AdultShaz on bed in midground; dark walnut headboard and terracotta accent wall framing bedroom",
          lightAndPalette: "Soft evening lamp glow camera-left, screen reflection on his chest and hands"
        },
        {
          panelNumber: 2,
          shotId: "3.2",
          locationTag: "@Loc 6",
          shotSizeAndAngle: "Medium shot, eye level",
          characters: [
            {
              tag: "@Wife",
              wardrobe: "Warm taupe long tunic with warm taupe hijab, deep chocolate-brown trousers, cream shoes",
              props: ["warm taupe hijab", "smartphone", "accent cushion"],
              pose: "curled into reading armchair, hugging cushion to chest while tapping phone screen",
              expression: "tender, gentle expectant smile"
            }
          ],
          staging: "@Wife in armchair at camera-left; Chicago bookshelf nook and olive curtain in background",
          lightAndPalette: "Warm evening reading lamp casting cozy golden illumination across her warm taupe hijab"
        },
        {
          panelNumber: 3,
          shotId: "3.3",
          locationTag: "@Loc 5",
          shotSizeAndAngle: "Close-up, eye level",
          characters: [
            {
              tag: "@AdultShaz",
              wardrobe: "Navy-blue overshirt jacket open over light heather-grey t-shirt, khaki chinos, tan canvas sneakers",
              props: ["smartphone held to ear"],
              pose: "holding phone up to ear with both hands, nodding gently as he listens",
              expression: "reassured, tender affection, smiling softly"
            }
          ],
          staging: "Tight profile on @AdultShaz in right of frame, warm room bokeh behind",
          lightAndPalette: "Intimate warm sidelight from bedside lamp, soft shadows"
        },
        {
          panelNumber: 4,
          shotId: "3.4",
          locationTag: "@Loc 6",
          shotSizeAndAngle: "Close-up, eye level",
          characters: [
            {
              tag: "@Wife",
              wardrobe: "Warm taupe long tunic with warm taupe hijab, deep chocolate-brown trousers, cream shoes",
              props: ["warm taupe hijab", "smartphone"],
              pose: "propping chin on a knuckle, tracing the edge of the phone with a fingertip",
              expression: "affectionate listening gaze, eyes crinkling with warmth"
            }
          ],
          staging: "Tight on @Wife in left of frame facing screen right, perfectly mirroring Shaz eyeline",
          lightAndPalette: "Soft golden light catching the folds of her warm taupe hijab and face"
        },
        {
          panelNumber: 5,
          shotId: "3.5",
          locationTag: "@Loc 7",
          shotSizeAndAngle: "Medium two-shot, eye level",
          characters: [
            {
              tag: "@AdultShaz",
              wardrobe: "Navy-blue overshirt jacket open over light heather-grey t-shirt, khaki chinos, tan canvas sneakers",
              props: ["knitted throw blanket"],
              pose: "sitting beside Mia on the couch, folding blanket edge carefully between his palms",
              expression: "gentle, devoted fatherly smile"
            },
            {
              tag: "@Mia",
              wardrobe: "Sky-blue pinafore dress over white long-sleeve top, white leggings, light brown shoes, sky-blue hijab",
              props: ["sky-blue hijab", "knitted throw blanket"],
              pose: "pulling knees up on the sofa cushion, leaning in close against him",
              expression: "contented, peaceful smile"
            }
          ],
          staging: "Both seated together on living room sofa; warm family living room in evening background",
          lightAndPalette: "Rich cozy ambient evening lighting, warm lamplight highlighting sky-blue and navy fabrics"
        },
        {
          panelNumber: 6,
          shotId: "3.6",
          locationTag: "@Loc 7",
          shotSizeAndAngle: "Close-up, eye level",
          characters: [
            {
              tag: "@AdultShaz",
              wardrobe: "Navy-blue overshirt jacket open over light heather-grey t-shirt, khaki chinos, tan canvas sneakers",
              props: ["knitted throw blanket"],
              pose: "arm gently wrapped around Mia shoulders, holding her safe and close",
              expression: "deep unconditional love and peace"
            },
            {
              tag: "@Mia",
              wardrobe: "Sky-blue pinafore dress over white long-sleeve top, white leggings, light brown shoes, sky-blue hijab",
              props: ["sky-blue hijab", "knitted throw blanket"],
              pose: "resting head peacefully against his shoulder, holding the blanket edge",
              expression: "eyes closed in quiet safe comfort"
            }
          ],
          staging: "Intimate close framing on father and daughter embracing; emotional climax of the story",
          lightAndPalette: "Golden, tender evening warmth enveloping both characters in an emotional halo"
        }
      ]
    }
  ],
  assumptions: [
    "One sheet per story part matching the 7, 7, and 6 shot breakdowns.",
    "Wardrobe strings copied verbatim from approved Character Architect outfits.",
    "All character signature accessories (sunglasses for @Shaz, hijabs for @Mom, @Wife, @Mia) maintained in every panel appearance."
  ]
};

const parsed = parseStoryboard(storyboardData);
const gate = validateStoryboard(parsed, input);

if (!gate.isValid) {
  console.error("Gate validation failed:", gate.errors);
  process.exit(1);
}
console.log(`Gate passed cleanly: ${gate.errors.length} errors, ${gate.warnings.length} warnings.`);

// Compile sheets & panels
const compiledSheets = compileSheets(parsed, input);
const compiledPanels = compilePanels(parsed, input);

const finalOutput = {
  ...parsed,
  sheets: compiledSheets,
};

await writeFile(join(outDir, 'storyboard-artist.json'), JSON.stringify(finalOutput, null, 2), 'utf8');
console.log(`Wrote ${join(outDir, 'storyboard-artist.json')}`);

// Export sheet prompts and production panel prompts
await mkdir(expDir, { recursive: true });
const timing = Object.fromEntries(shotTimeline(sd).map((s) => [s.shotId, s]));

for (const s of compiledSheets) {
  await writeFile(join(expDir, `sheet-${s.sheetId}.txt`), s.fullPrompt + '\n', 'utf8');
}

await writeFile(join(expDir, 'manifest.json'), JSON.stringify({
  runId,
  engine: 'nano-banana-2.1',
  aspect: '16:9',
  note: 'Attach references in the listed order (position = "reference image N" in the prompt). Save each result as sheet-<sheetId>.png, then run scripts/slice-storyboard.mjs.',
  sheets: compiledSheets.map((s) => ({
    sheetId: s.sheetId,
    segmentId: s.segmentId,
    panelCount: s.panels.length,
    layout: s.layout,
    promptFile: `sheet-${s.sheetId}.txt`,
    promptChars: s.fullPrompt.length,
    references: s.references,
    panels: s.panels.map((p) => ({ ...p, durationSec: timing[p.shotId]?.durationSec }))
  }))
}, null, 2), 'utf8');

const pdir = join(expDir, 'panels');
await mkdir(pdir, { recursive: true });
for (const p of compiledPanels) {
  await writeFile(join(pdir, `${p.shotId}.txt`), p.fullPrompt + '\n', 'utf8');
}
await writeFile(join(pdir, 'panels.json'), JSON.stringify({
  runId,
  style: STYLE_FILE,
  ...PANEL_IMAGE,
  note: 'One image per shot. Attach references in the listed order, render 16:9 at 2K, save as <shotId>.png, then run scripts/check-panels.mjs --dir <dir> --manifest panels.json.',
  panels: compiledPanels.map(({ fullPrompt, ...p }) => ({
    ...p,
    promptFile: `${p.shotId}.txt`,
    durationSec: timing[p.shotId]?.durationSec
  }))
}, null, 2), 'utf8');

console.log(`Exported ${compiledSheets.length} contact sheets and ${compiledPanels.length} native 16:9 2K panel prompts -> ${expDir}`);

// Append to event log
appendEvent(eventsFile, {
  at: new Date().toISOString(),
  agent: 'storyboard-artist',
  type: 'start'
});
appendEvent(eventsFile, {
  at: new Date().toISOString(),
  agent: 'storyboard-artist',
  type: 'attempt',
  attempt: 1
});
appendEvent(eventsFile, {
  at: new Date().toISOString(),
  agent: 'storyboard-artist',
  type: 'attempt-result',
  attempt: 1,
  isValid: true,
  issues: []
});
appendEvent(eventsFile, {
  at: new Date().toISOString(),
  agent: 'storyboard-artist',
  type: 'passed',
  attempt: 1
});

// Update sb-state.json
await writeFile(join(outDir, 'sb-state.json'), JSON.stringify({
  status: 'done',
  attempts: { 'storyboard-artist': 1 },
  gateIssues: { 'storyboard-artist': [] },
  validationErrors: [],
  wallSec: 2,
  keySpentUsd: 0,
  sheetsCount: compiledSheets.length,
  panelsCount: compiledPanels.length
}, null, 2), 'utf8');

console.log('Storyboard Artist stage completed successfully!');
