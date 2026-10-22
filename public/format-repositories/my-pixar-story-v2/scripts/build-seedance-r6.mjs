import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleCompiledPrompt } from '../crew/seedance-compiler/schema.mjs';
import { validateSeedancePrompts } from '../crew/linter/check-seedance-prompts.mjs';

const inputPath = 'runs/r6-live_attempt-3/seedance-compiler/references/input.json';
const input = JSON.parse(readFileSync(inputPath, 'utf8'));

// Build segment 1 (19s, 7 shots)
const seg1_shots = [
  {
    shotNumber: 1,
    startSec: 0,
    endSec: 4,
    sceneId: '1.1',
    locationTag: '@family_living_room_day',
    cast: ['@Shaz', '@Mom'],
    action: '@Shaz sits cross-legged on the rug turning a card between his palms. @Mom sits nearby on the carpet watching him with a gentle smile.',
    dialogue: { speaker: '@AdultShaz', line: '{When I was 8 years old, I wanted to be a scientist.}', mode: 'voiceover' },
    sfx: ['soft carpet rustle', 'card slide'],
    cut: 'Hard cut.'
  },
  {
    shotNumber: 2,
    startSec: 4,
    endSec: 6,
    sceneId: '1.2',
    locationTag: '@family_living_room_day',
    cast: ['@Mom', '@Shaz'],
    action: '@Mom beams proudly, clapping her hands together softly as she looks at @Shaz. @Shaz sits tall with quiet satisfaction.',
    dialogue: { speaker: '@Mom', line: '{My scientist!}', mode: 'on-camera' },
    sfx: ['soft hand clap'],
    cut: 'Hard cut.'
  },
  {
    shotNumber: 3,
    startSec: 6,
    endSec: 8,
    sceneId: '1.3',
    locationTag: '@family_living_room_day',
    cast: ['@Shaz'],
    action: '@Shaz looks down at the cards in front of him, blinking slowly with a serious expression.',
    dialogue: { speaker: '@AdultShaz', line: "{I didn't talk much.}", mode: 'voiceover' },
    sfx: ['gentle room tone'],
    cut: 'Hard cut.'
  },
  {
    shotNumber: 4,
    startSec: 8,
    endSec: 11,
    sceneId: '1.4',
    locationTag: '@family_living_room_day',
    cast: ['@Shaz', '@Sister'],
    action: '@Sister sits sprawled cross-legged on the carpet, tapping a card against the floor. @Shaz holds his hand of cards close to his chest.',
    dialogue: { speaker: '@AdultShaz', line: '{We used to watch Yugioh GX together, it was our thing.}', mode: 'voiceover' },
    sfx: ['card tap on floor'],
    cut: 'Hard cut.'
  },
  {
    shotNumber: 5,
    startSec: 11,
    endSec: 13,
    sceneId: '1.5',
    locationTag: '@family_living_room_day',
    cast: ['@Brother', '@Shaz'],
    action: '@Brother bounces forward on his knees, slapping a card face-up onto the rug with triumphant glee. @Shaz pulls back slightly in surprise.',
    dialogue: { speaker: '@Brother', line: '{Take that!}', mode: 'on-camera' },
    sfx: ['card slap on rug'],
    cut: 'Hard cut.'
  },
  {
    shotNumber: 6,
    startSec: 13,
    endSec: 17,
    sceneId: '1.6',
    locationTag: '@family_living_room_day',
    cast: ['@Shaz', '@Brother'],
    action: '@Shaz examines his remaining cards carefully, placing one onto the rug with deliberate calm. @Brother watches intently with his chin propped on one fist.',
    dialogue: { speaker: '@AdultShaz', line: '{We were obsessed with Yugioh cards and battling each other.}', mode: 'voiceover' },
    sfx: ['card slide on rug'],
    cut: 'Hard cut.'
  },
  {
    shotNumber: 7,
    startSec: 17,
    endSec: 19,
    sceneId: '1.7',
    locationTag: '@family_living_room_day',
    cast: ['@Shaz'],
    action: '@Shaz looks straight ahead with complete determination and quiet conviction.',
    dialogue: { speaker: '@Shaz', line: '{I want to be a scientist.}', mode: 'on-camera' },
    sfx: ['subtle breath settle'],
    cut: 'Hard cut.'
  }
];

const seg1_shotsText = `SHOT 1 | 0–4s
Camera: medium, eye level, slow push in.
On screen: @Shaz, @Mom.
Look @Shaz: sunglasses pushed up on the forehead; Mustard-yellow hoodie with front pocket; dark slate-blue jeans; white sneakers.
Look @Mom: wears a hijab; hijab fully covering the hair and hairline; Dusty-rose ankle-length abaya dress; cream inner dress at hem; dusty-rose hijab; deep brown shoes.
Props: a pile of Yugioh cards spread across the rug, faces up.
@Shaz sits cross-legged on the rug turning a card between his palms. @Mom sits nearby on the carpet watching him with a gentle smile.
No one on screen speaks; every on-screen mouth stays closed.
@AdultShaz, voiceover: {When I was 8 years old, I wanted to be a scientist.}
Hard cut.

SHOT 2 | 4–6s
Camera: close-up, eye level, static.
On screen: @Mom, @Shaz.
Look @Mom: wears a hijab; hijab fully covering the hair and hairline; Dusty-rose ankle-length abaya dress; cream inner dress at hem; dusty-rose hijab; deep brown shoes.
Look @Shaz: sunglasses pushed up on the forehead; Mustard-yellow hoodie with front pocket; dark slate-blue jeans; white sneakers.
Props: a pile of Yugioh cards spread across the rug, faces up.
@Mom beams proudly, clapping her hands together softly as she looks at @Shaz. @Shaz sits tall with quiet satisfaction.
@Mom: {My scientist!}
Hard cut.

SHOT 3 | 6–8s
Camera: medium, eye level, static.
On screen: @Shaz.
Look @Shaz: sunglasses pushed up on the forehead; Mustard-yellow hoodie with front pocket; dark slate-blue jeans; white sneakers.
Props: a pile of Yugioh cards spread across the rug, faces up.
@Shaz looks down at the cards in front of him, blinking slowly with a serious expression.
No one on screen speaks; every on-screen mouth stays closed.
@AdultShaz, voiceover: {I didn't talk much.}
Hard cut.

SHOT 4 | 8–11s
Camera: wide, eye level, slow push in.
On screen: @Shaz, @Sister.
Look @Shaz: sunglasses pushed up on the forehead; Mustard-yellow hoodie with front pocket; dark slate-blue jeans; white sneakers.
Look @Sister: burnt-orange cardigan; Burnt-orange open cardigan with long sleeves; soft white tee; dark indigo jeans; white sneakers.
Props: a pile of Yugioh cards spread across the rug, faces up.
@Sister sits sprawled cross-legged on the carpet, tapping a card against the floor. @Shaz holds his hand of cards close to his chest.
No one on screen speaks; every on-screen mouth stays closed.
@AdultShaz, voiceover: {We used to watch Yugioh GX together, it was our thing.}
Hard cut.

SHOT 5 | 11–13s
Camera: medium, eye level, static.
On screen: @Brother, @Shaz.
Look @Brother: emerald-green t-shirt; Emerald-green crew t-shirt; khaki shorts; white sneakers with red soles.
Look @Shaz: sunglasses pushed up on the forehead; Mustard-yellow hoodie with front pocket; dark slate-blue jeans; white sneakers.
Props: a pile of Yugioh cards spread across the rug, faces up.
@Brother bounces forward on his knees, slapping a card face-up onto the rug with triumphant glee. @Shaz pulls back slightly in surprise.
@Brother: {Take that!}
Hard cut.

SHOT 6 | 13–17s
Camera: medium, eye level, static.
On screen: @Shaz, @Brother.
Look @Shaz: sunglasses pushed up on the forehead; Mustard-yellow hoodie with front pocket; dark slate-blue jeans; white sneakers.
Look @Brother: emerald-green t-shirt; Emerald-green crew t-shirt; khaki shorts; white sneakers with red soles.
Props: a pile of Yugioh cards spread across the rug, faces up.
@Shaz examines his remaining cards carefully, placing one onto the rug with deliberate calm. @Brother watches intently with his chin propped on one fist.
No one on screen speaks; every on-screen mouth stays closed.
@AdultShaz, voiceover: {We were obsessed with Yugioh cards and battling each other.}
Hard cut.

SHOT 7 | 17–19s
Camera: medium, low angle from the floor, slow push in.
On screen: @Shaz.
Look @Shaz: sunglasses pushed up on the forehead; Mustard-yellow hoodie with front pocket; dark slate-blue jeans; white sneakers.
Props: a pile of Yugioh cards spread across the rug, faces up.
@Shaz looks straight ahead with complete determination and quiet conviction.
@Shaz: {I want to be a scientist.}
Hard cut.`;

const seg1_tenBlocks = {
  block1_referenceMaterials: `@Shaz = Slim eight-year-old boy with narrow oval face, short straight black hair with side-swept fringe, dark brown eyes, thick dark eyebrows, black sunglasses pushed up on forehead with eyes fully visible, mustard-yellow hoodie with front pocket, dark slate-blue jeans, white sneakers.
@Mom = Medium build adult woman with round face, dark brown eyes, dusty-rose hijab fully covering hair and hairline with no visible hair, dusty-rose ankle-length abaya dress, cream inner dress at hem, deep brown shoes.
@Sister = Tall slim eighteen-year-old young woman with narrow face, dark brown eyes, long straight black hair worn uncovered with no hijab, burnt-orange cardigan, soft white tee, dark indigo jeans, white sneakers.
@Brother = Small six-year-old boy with round face, clean buzz cut black hair, dark brown eyes, emerald-green t-shirt, khaki shorts, white sneakers with red soles.
@family_living_room_day = Empty family living room plate, soft warm afternoon daylight through tall windows, warm wooden flooring and patterned area rug.
Each reference is one person or one object and appears once. No duplicates.`,

  block2_voices: `@AdultShaz VOICE: "An off-screen narrator, never seen. Man in his early thirties, American accent, warm low timbre, steady unhurried pace, earnest storytelling delivery that softens at the close"
@Mom VOICE: "Woman in her late thirties, American accent, warm bright timbre, lively encouraging pace, proud delighted delivery"
@Brother VOICE: "6-year-old American boy, high squeaky voice, fast excited pace, bragging playful delivery that bursts out"
@Shaz VOICE: "8-year-old American boy, soft high voice, slow quiet pace, flat declarative delivery with total conviction"`,

  block3_goal: `A seven-shot, nineteen-second segment establishing an eight-year-old boy dreaming of being a scientist while playing card battles with his family. It ends the instant @Shaz looks up with total conviction declaring his dream. Do not continue past that moment, do not resolve anything and do not add an ending.`,

  block4_continuity: `Location: the family living room in @family_living_room_day throughout. Never leave it. The camera stays on the same side of the action as in @family_living_room_day for the whole segment and never crosses to the other side. 180-degree axis locked and this never flips. Only characters in the shot cast on screen per shot, no background crowd, no face repeats. Costumes are fixed for the whole segment and never change. @Mom wears dusty-rose hijab fully covering hair and hairline with no visible hair and no dark band, @Sister wears burnt-orange cardigan with uncovered hair, and this never changes.`,

  block5_shots: seg1_shotsText,

  block6_visualStyle: `Feature-quality 3D animated film, production CG, not photorealistic and not flat cartoon. Warm afternoon daylight with soft subsurface glow through ears and skin, tactile materials for rug, cotton, cards and skin. Depth of field as a natural in-camera optical artifact keeping foreground subject crisp. Clean straight-played family comedy staging.`,

  block7_cameraAndPerformance: `This is a seven-shot segment with six cuts between shots, every shot ending in a hard cut, total nineteen seconds. The body plays honest. The face stays natural. No mugging, no pulled faces, no comic reactions. Anticipation: movement winds the opposite way first. Snap and Settle: fast transition between poses with overshoot on arrival. Moving Holds: held poses settle and micro-shift, never frozen mannequins. Overlap and Secondary Action: hair, cloth and attachments arrive a beat late. Eye Life: micro-saccades, catchlights and blink rate, eyes never glaze over.`,

  block8_audio: `Foley: carpet shuffle, card sliding and slapping, gentle knee shift, soft clap. Ambient room tone: quiet living room atmosphere with soft afternoon stillness. Score: subtle warm acoustic guitar and light marimba accents, building gently on proud dream declarations, then settling.`,

  block9_exclusions: `The only spoken words in the entire segment are the lines in braces. No humming, mumbling, breaths-as-words or partial words from anyone on screen. Nothing else written anywhere in this prompt is dialogue, and nobody speaks who is not named on a line. No extra cuts anywhere. No unison movement. No subtitles, no watermark, no logo.`,

  block10_maintainConsistency: `Maintain @Shaz, @Mom, @Sister, @Brother and @family_living_room_day with fixed costume, hijab coverage, sunglasses placement and room geometry. Children @Shaz and @Brother are 4.75 to 5 heads tall with long torso and short legs, child equals 5 heads tall. Adults @Mom and @Sister are 6.25 to 6.5 heads tall, adult equals 6.5 heads tall, toddler equals 4 heads tall for scale reference. No face repeats, no extra characters.`
};

const seg1 = {
  segmentId: 1,
  title: 'Part 1: Scientist and Yugioh',
  totalDurationSec: 19,
  shotCount: 7,
  attachedElements: ['@Shaz', '@Mom', '@Sister', '@Brother', '@family_living_room_day'],
  tenBlocks: seg1_tenBlocks,
  compiledPrompt: assembleCompiledPrompt(seg1_tenBlocks),
  generationPayload: { engine: 'seedance-2.5', durationSec: 19, resolution: '480p', aspectRatio: '16:9', fps: 24 },
  segmentIndex: 1,
  extendsFrom: null,
  references: [
    { tag: '@Shaz', kind: 'character', sourceTag: '@Image 1', assetKey: 'asset:master-render:shaz' },
    { tag: '@Mom', kind: 'character', sourceTag: '@Image 3', assetKey: 'asset:master-render:mom' },
    { tag: '@Sister', kind: 'character', sourceTag: '@Image 4', assetKey: 'asset:master-render:sister' },
    { tag: '@Brother', kind: 'character', sourceTag: '@Image 5', assetKey: 'asset:master-render:brother' },
    { tag: '@family_living_room_day', kind: 'location', sourceTag: '@Loc 1', assetKey: 'asset:location-plate:family-living-room-day' }
  ],
  shots: seg1_shots
};

// Build segment 2 (30s, 7 shots)
const seg2_shots = [
  {
    shotNumber: 1,
    startSec: 0,
    endSec: 4,
    sceneId: '2.1',
    locationTag: '@suburban_driveway_day',
    cast: ['@TeenShaz'],
    action: '@TeenShaz stands in the driveway beside the black Honda Accord coupe with faded paint, swinging his car key on his finger and bouncing lightly on his heels.',
    dialogue: { speaker: '@AdultShaz', line: '{My first freedom was my license at 17.}', mode: 'voiceover' },
    sfx: ['key jingle', 'sneaker scuff'],
    cut: 'Hard cut.'
  },
  {
    shotNumber: 2,
    startSec: 4,
    endSec: 9,
    sceneId: '2.2',
    locationTag: '@honda_accord_interior_day',
    cast: ['@TeenShaz'],
    action: '@TeenShaz sits in the driver seat, gripping the steering wheel with both hands and tapping his thumbs to an unheard beat while glancing out the front windshield.',
    dialogue: { speaker: '@AdultShaz', line: '{My 2000 Honda Accord Coupe had faded paint and no air conditioning.}', mode: 'voiceover' },
    sfx: ['car door shut thud', 'steering wheel leather squeak'],
    cut: 'Hard cut.'
  },
  {
    shotNumber: 3,
    startSec: 9,
    endSec: 12,
    sceneId: '2.3',
    locationTag: '@honda_accord_interior_day',
    cast: ['@TeenShaz'],
    action: '@TeenShaz plugs the aux cable into the cassette adapter and dials the volume knob, nodding his head to the rhythm with a satisfied grin.',
    dialogue: { speaker: '@AdultShaz', line: '{Aux cable in, tunes with friends.}', mode: 'voiceover' },
    sfx: ['aux click', 'cassette tape mechanism whir'],
    cut: 'Hard cut.'
  },
  {
    shotNumber: 4,
    startSec: 12,
    endSec: 16,
    sceneId: '2.4',
    locationTag: '@honda_accord_interior_day',
    cast: ['@TeenShaz'],
    action: '@TeenShaz rests one arm comfortably on the door sill while holding the top of the steering wheel, gazing out through the driver window with fond nostalgia.',
    dialogue: { speaker: '@AdultShaz', line: '{Honestly, that was still the best car I ever had.}', mode: 'voiceover' },
    sfx: ['gentle breeze flutter'],
    cut: 'Hard cut.'
  },
  {
    shotNumber: 5,
    startSec: 16,
    endSec: 19,
    sceneId: '2.5',
    locationTag: '@home_desk_corner_day',
    cast: ['@AdultShaz'],
    action: '@AdultShaz sits upright at the wooden desk, adjusting his posture and opening his laptop with focused composure.',
    dialogue: { speaker: '@AdultShaz', line: '{I graduated early from Mckinney Boyd High School.}', mode: 'voiceover' },
    sfx: ['laptop hinge creak'],
    cut: 'Hard cut.'
  },
  {
    shotNumber: 6,
    startSec: 19,
    endSec: 25,
    sceneId: '2.6',
    locationTag: '@home_desk_corner_day',
    cast: ['@AdultShaz'],
    action: '@AdultShaz types steadily across the laptop keyboard, his eyes moving across code lines displayed on the bright glowing screen.',
    dialogue: { speaker: '@AdultShaz', line: '{Certifications in Python and Ruby on Rails got my job at 19.}', mode: 'voiceover' },
    sfx: ['mechanical keyboard keystrokes'],
    cut: 'Hard cut.'
  },
  {
    shotNumber: 7,
    startSec: 25,
    endSec: 30,
    sceneId: '2.7',
    locationTag: '@home_desk_corner_day',
    cast: ['@AdultShaz'],
    action: '@AdultShaz leans back in his office chair, stretching his arms comfortably behind his head with a serene, relieved smile.',
    dialogue: { speaker: '@AdultShaz', line: '{At home with family, 50k felt like 6 figures, no money worries.}', mode: 'voiceover' },
    sfx: ['office chair recline creak'],
    cut: 'Hard cut.'
  }
];

const seg2_shotsText = `SHOT 1 | 0–4s
Camera: wide, eye level, slow push in.
Location: @suburban_driveway_day.
On screen: @TeenShaz.
Look @TeenShaz: Charcoal-grey varsity jacket with ribbed cuffs; off-white t-shirt; black jeans; white sneakers.
Props: the 2000 Honda Accord Coupe with faded paint parked in the driveway.
@TeenShaz stands in the driveway beside the black Honda Accord coupe with faded paint, swinging his car key on his finger and bouncing lightly on his heels.
No one on screen speaks; every on-screen mouth stays closed.
@AdultShaz, voiceover: {My first freedom was my license at 17.}
Hard cut.

SHOT 2 | 4–9s
Camera: medium, eye level, static.
Location: @honda_accord_interior_day.
On screen: @TeenShaz.
Look @TeenShaz: Charcoal-grey varsity jacket with ribbed cuffs; off-white t-shirt; black jeans; white sneakers.
Props: the steering wheel and worn cloth seats inside the car.
@TeenShaz sits in the driver seat, gripping the steering wheel with both hands and tapping his thumbs to an unheard beat while glancing out the front windshield.
No one on screen speaks; every on-screen mouth stays closed.
@AdultShaz, voiceover: {My 2000 Honda Accord Coupe had faded paint and no air conditioning.}
Hard cut.

SHOT 3 | 9–12s
Camera: close-up, eye level, static.
Location: @honda_accord_interior_day.
On screen: @TeenShaz.
Look @TeenShaz: Charcoal-grey varsity jacket with ribbed cuffs; off-white t-shirt; black jeans; white sneakers.
Props: the steering wheel and worn cloth seats inside the car.
@TeenShaz plugs the aux cable into the cassette adapter and dials the volume knob, nodding his head to the rhythm with a satisfied grin.
No one on screen speaks; every on-screen mouth stays closed.
@AdultShaz, voiceover: {Aux cable in, tunes with friends.}
Hard cut.

SHOT 4 | 12–16s
Camera: medium, eye level, static.
Location: @honda_accord_interior_day.
On screen: @TeenShaz.
Look @TeenShaz: Charcoal-grey varsity jacket with ribbed cuffs; off-white t-shirt; black jeans; white sneakers.
Props: the steering wheel and worn cloth seats inside the car.
@TeenShaz rests one arm comfortably on the door sill while holding the top of the steering wheel, gazing out through the driver window with fond nostalgia.
No one on screen speaks; every on-screen mouth stays closed.
@AdultShaz, voiceover: {Honestly, that was still the best car I ever had.}
Hard cut.

SHOT 5 | 16–19s
Camera: medium, eye level, static.
Location: @home_desk_corner_day.
On screen: @AdultShaz.
Look @AdultShaz: Navy-blue overshirt jacket open over light heather-grey t-shirt; khaki chinos; tan canvas sneakers.
Props: the laptop open on the desk, screen lit.
@AdultShaz sits upright at the wooden desk, adjusting his posture and opening his laptop with focused composure.
No one on screen speaks; every on-screen mouth stays closed.
@AdultShaz, voiceover: {I graduated early from Mckinney Boyd High School.}
Hard cut.

SHOT 6 | 19–25s
Camera: medium, eye level, slow push in.
Location: @home_desk_corner_day.
On screen: @AdultShaz.
Look @AdultShaz: Navy-blue overshirt jacket open over light heather-grey t-shirt; khaki chinos; tan canvas sneakers.
Props: the laptop open on the desk, screen lit.
@AdultShaz types steadily across the laptop keyboard, his eyes moving across code lines displayed on the bright glowing screen.
No one on screen speaks; every on-screen mouth stays closed.
@AdultShaz, voiceover: {Certifications in Python and Ruby on Rails got my job at 19.}
Hard cut.

SHOT 7 | 25–30s
Camera: close-up, eye level, static.
Location: @home_desk_corner_day.
On screen: @AdultShaz.
Look @AdultShaz: Navy-blue overshirt jacket open over light heather-grey t-shirt; khaki chinos; tan canvas sneakers.
Props: the laptop open on the desk, screen lit.
@AdultShaz leans back in his office chair, stretching his arms comfortably behind his head with a serene, relieved smile.
No one on screen speaks; every on-screen mouth stays closed.
@AdultShaz, voiceover: {At home with family, 50k felt like 6 figures, no money worries.}
Hard cut.`;

const seg2_tenBlocks = {
  block1_referenceMaterials: `@TeenShaz = Slim eighteen-year-old young adult with light olive skin, short black hair faded at the sides and swept up on top, dark brown eyes, Charcoal-grey varsity jacket with ribbed cuffs, off-white t-shirt, black jeans, white sneakers.
@AdultShaz = Adult man in his twenties with slim athletic build, short black hair faded at sides and swept up on top, short full dark beard, dark brown eyes, Navy-blue overshirt jacket open over light heather-grey t-shirt, khaki chinos, tan canvas sneakers.
@suburban_driveway_day = Empty suburban driveway plate, bright sunny afternoon daylight, paved asphalt driveway in front of suburban garage.
@honda_accord_interior_day = Interior plate of two-door coupe, grey worn fabric upholstery, analog dashboard dials, sunlit front windshield.
@home_desk_corner_day = Home office corner plate, warm daylight from side window, wooden computer desk with monitor and desk lamp.
Each reference is one person or one object and appears once. No duplicates.`,

  block2_voices: `@AdultShaz VOICE: "An off-screen narrator voice; @AdultShaz on screen never speaks these lines. Man in his early thirties, American accent, warm low timbre, steady unhurried pace, earnest storytelling delivery that softens at the close"`,

  block3_goal: `A seven-shot, thirty-second segment following a young adult experiencing the freedom of his first car and transitioning to early career stability at home. It ends the instant @AdultShaz reclines in his office chair with a peaceful smile. Do not continue past that moment, do not resolve anything and do not add an ending.`,

  block4_continuity: `Location: the suburban driveway in @suburban_driveway_day for shot 1 and the honda accord interior in @honda_accord_interior_day for shots 2 to 4 and the home desk corner in @home_desk_corner_day for shots 5 to 7. Never leave them. The camera stays on the same side of the action as in @suburban_driveway_day for shot 1 and as in @honda_accord_interior_day for shots 2 to 4 and as in @home_desk_corner_day for shots 5 to 7 and never crosses to the other side. 180-degree axis locked and this never flips. Only characters in the shot cast on screen per shot, no background crowd, no face repeats. Costumes are fixed for the whole segment and never change. @TeenShaz wears charcoal-grey varsity jacket, @AdultShaz wears navy-blue overshirt jacket, and this never changes.`,

  block5_shots: seg2_shotsText,

  block6_visualStyle: `Feature-quality 3D animated film, production CG, not photorealistic and not flat cartoon. Bright daylight and clean interior sunbeams with soft subsurface glow on skin. Tactile materials for car cloth, steering wheel texture, cotton denim and laptop metal. Depth of field as a natural in-camera optical artifact keeping foreground subject crisp. Clean straight-played family memoir staging.`,

  block7_cameraAndPerformance: `This is a seven-shot segment with six cuts between shots, every shot ending in a hard cut, total thirty seconds. The body plays honest. The face stays natural. No mugging, no pulled faces, no comic reactions. Anticipation: movement winds the opposite way first. Snap and Settle: fast transition between poses with overshoot on arrival. Moving Holds: held poses settle and micro-shift, never frozen mannequins. Overlap and Secondary Action: hair, cloth and attachments arrive a beat late. Eye Life: micro-saccades, catchlights and blink rate, eyes never glaze over.`,

  block8_audio: `Foley: key jingle, car door latch, aux cable click, steering wheel grip, keyboard typing, chair tilt. Ambient room tone: gentle suburban outdoor breeze, muted car cabin presence, quiet home room tone. Score: rhythmic indie-pop guitar accents transition into focused optimistic synth pads, settling into warmth.`,

  block9_exclusions: `The only spoken words in the entire segment are the lines in braces. No humming, mumbling, breaths-as-words or partial words from anyone on screen. Nothing else written anywhere in this prompt is dialogue, and nobody speaks who is not named on a line. No extra cuts anywhere. No unison movement. No subtitles, no watermark, no logo.`,

  block10_maintainConsistency: `Maintain @TeenShaz, @AdultShaz, @suburban_driveway_day, @honda_accord_interior_day and @home_desk_corner_day with fixed costume, beard grooming and set geometry. Young adult @TeenShaz is 6.5 heads tall, adult @AdultShaz is 7 heads tall, adult equals 7 heads tall, child equals 5 heads tall for scale reference. No face repeats, no extra characters.`
};

const seg2 = {
  segmentId: 2,
  title: 'Part 2: Freedom and First Job',
  totalDurationSec: 30,
  shotCount: 7,
  attachedElements: ['@TeenShaz', '@AdultShaz', '@suburban_driveway_day', '@honda_accord_interior_day', '@home_desk_corner_day'],
  tenBlocks: seg2_tenBlocks,
  compiledPrompt: assembleCompiledPrompt(seg2_tenBlocks),
  generationPayload: { engine: 'seedance-2.5', durationSec: 30, resolution: '480p', aspectRatio: '16:9', fps: 24 },
  segmentIndex: 2,
  extendsFrom: 1,
  references: [
    { tag: '@TeenShaz', kind: 'character', sourceTag: '@Image 8', assetKey: 'asset:master-render:teen-shaz' },
    { tag: '@AdultShaz', kind: 'character', sourceTag: '@Image 2', assetKey: 'asset:master-render:adult-shaz' },
    { tag: '@suburban_driveway_day', kind: 'location', sourceTag: '@Loc 2', assetKey: 'asset:location-plate:suburban-driveway-day' },
    { tag: '@honda_accord_interior_day', kind: 'location', sourceTag: '@Loc 3', assetKey: 'asset:location-plate:honda-accord-interior-day' },
    { tag: '@home_desk_corner_day', kind: 'location', sourceTag: '@Loc 4', assetKey: 'asset:location-plate:home-desk-corner-day' }
  ],
  shots: seg2_shots
};

// Build segment 3 (23s, 6 shots)
const seg3_shots = [
  {
    shotNumber: 1,
    startSec: 0,
    endSec: 3,
    sceneId: '3.1',
    locationTag: '@dallas_bedroom_evening',
    cast: ['@AdultShaz'],
    action: "@AdultShaz sits on the edge of the bed holding the phone flat in @AdultShaz's right hand, screen lit, looking down with quiet curiosity.",
    dialogue: { speaker: '@AdultShaz', line: '{We met on a dating app for Muslims.}', mode: 'voiceover' },
    sfx: ['bed frame settle', 'phone tap'],
    cut: 'Hard cut.'
  },
  {
    shotNumber: 2,
    startSec: 3,
    endSec: 6,
    sceneId: '3.2',
    locationTag: '@chicago_nook_evening',
    cast: ['@Wife'],
    action: "@Wife sits curled in an armchair by the window holding the phone flat in @Wife's right hand, screen lit, glancing at the screen with an amused, gentle expression.",
    dialogue: { speaker: '@AdultShaz', line: '{She was in Chicago and I was in Dallas.}', mode: 'voiceover' },
    sfx: ['cushion compress', 'phone chime'],
    cut: 'Hard cut.'
  },
  {
    shotNumber: 3,
    startSec: 6,
    endSec: 10,
    sceneId: '3.3',
    locationTag: '@dallas_bedroom_evening',
    cast: ['@AdultShaz'],
    action: "@AdultShaz props his elbows on his knees holding the phone flat in @AdultShaz's right hand, screen lit, listening attentively and smiling softly.",
    dialogue: { speaker: '@AdultShaz', line: '{Once a week we talked, every week at 8pm on Facetime.}', mode: 'voiceover' },
    sfx: ['gentle fabric rustle'],
    cut: 'Hard cut.'
  },
  {
    shotNumber: 4,
    startSec: 10,
    endSec: 14,
    sceneId: '3.4',
    locationTag: '@chicago_nook_evening',
    cast: ['@Wife'],
    action: "@Wife props her chin on her hand holding the phone flat in @Wife's right hand, screen lit, listening calmly with steady, affectionate eyes.",
    dialogue: { speaker: '@AdultShaz', line: "{I'm distant, her consistency made me fall.}", mode: 'voiceover' },
    sfx: ['soft breath settle'],
    cut: 'Hard cut.'
  },
  {
    shotNumber: 5,
    startSec: 14,
    endSec: 18,
    sceneId: '3.5',
    locationTag: '@cozy_family_living_room_evening',
    cast: ['@AdultShaz', '@Wife', '@Mia'],
    action: "@AdultShaz sits on the warm living room sofa with @Mia beside him on the couch with a folded blanket across the arm. @Wife sits adjacent, resting a gentle hand over @Mia's shoulder.",
    dialogue: { speaker: '@AdultShaz', line: '{If you want to love someone, think about the good things they do.}', mode: 'voiceover' },
    sfx: ['blanket rustle', 'tea mug set down'],
    cut: 'Hard cut.'
  },
  {
    shotNumber: 6,
    startSec: 18,
    endSec: 23,
    sceneId: '3.6',
    locationTag: '@cozy_family_living_room_evening',
    cast: ['@AdultShaz', '@Wife', '@Mia'],
    action: "@Wife chimes in with an affectionate, playful smile and leans forward; @AdultShaz leans in warmly as both parents kiss @Mia on both cheeks at the same time on the couch with a folded blanket across the arm, while @Mia giggles in sheer joy.",
    dialogue: { speaker: '@Wife', line: '{No, WE love you!}', mode: 'on-camera' },
    sfx: ['kiss mwah sound effect', 'child giggle'],
    cut: 'Hard cut.'
  }
];

const seg3_shotsText = `SHOT 1 | 0–3s
Camera: medium, eye level, static.
Location: @dallas_bedroom_evening.
On screen: @AdultShaz.
Look @AdultShaz: Navy-blue overshirt jacket open over light heather-grey t-shirt; khaki chinos; tan canvas sneakers.
Props: the phone held flat in @AdultShaz's right hand, screen lit.
@AdultShaz sits on the edge of the bed holding the phone flat in @AdultShaz's right hand, screen lit, looking down with quiet curiosity.
No one on screen speaks; every on-screen mouth stays closed.
@AdultShaz, voiceover: {We met on a dating app for Muslims.}
Hard cut.

SHOT 2 | 3–6s
Camera: medium, eye level, static.
Location: @chicago_nook_evening.
On screen: @Wife.
Look @Wife: wears a hijab; hijab fully covering the hair and hairline; warm taupe hijab; Warm taupe long tunic with warm taupe hijab; deep chocolate-brown trousers; cream shoes.
Props: the phone held flat in @Wife's right hand, screen lit.
@Wife sits curled in an armchair by the window holding the phone flat in @Wife's right hand, screen lit, glancing at the screen with an amused, gentle expression.
No one on screen speaks; every on-screen mouth stays closed.
@AdultShaz, voiceover: {She was in Chicago and I was in Dallas.}
Hard cut.

SHOT 3 | 6–10s
Camera: close-up, eye level, static.
Location: @dallas_bedroom_evening.
On screen: @AdultShaz.
Look @AdultShaz: Navy-blue overshirt jacket open over light heather-grey t-shirt; khaki chinos; tan canvas sneakers.
Props: the phone held flat in @AdultShaz's right hand, screen lit.
@AdultShaz props his elbows on his knees holding the phone flat in @AdultShaz's right hand, screen lit, listening attentively and smiling softly.
No one on screen speaks; every on-screen mouth stays closed.
@AdultShaz, voiceover: {Once a week we talked, every week at 8pm on Facetime.}
Hard cut.

SHOT 4 | 10–14s
Camera: close-up, eye level, static.
Location: @chicago_nook_evening.
On screen: @Wife.
Look @Wife: wears a hijab; hijab fully covering the hair and hairline; warm taupe hijab; Warm taupe long tunic with warm taupe hijab; deep chocolate-brown trousers; cream shoes.
Props: the phone held flat in @Wife's right hand, screen lit.
@Wife props her chin on her hand holding the phone flat in @Wife's right hand, screen lit, listening calmly with steady, affectionate eyes.
No one on screen speaks; every on-screen mouth stays closed.
@AdultShaz, voiceover: {I'm distant, her consistency made me fall.}
Hard cut.

SHOT 5 | 14–18s
Camera: medium, eye level, slow push in.
Location: @cozy_family_living_room_evening.
On screen: @AdultShaz, @Wife, @Mia.
Look @AdultShaz: Navy-blue overshirt jacket open over light heather-grey t-shirt; khaki chinos; tan canvas sneakers.
Look @Wife: wears a hijab; hijab fully covering the hair and hairline; warm taupe hijab; Warm taupe long tunic with warm taupe hijab; deep chocolate-brown trousers; cream shoes.
Look @Mia: wears a hijab; hijab fully covering the hair and hairline; Sky-blue pinafore dress over white long-sleeve top; white leggings; light brown shoes; sky-blue hijab.
Props: the couch with a folded blanket across the arm.
@AdultShaz sits on the warm living room sofa with @Mia beside him on the couch with a folded blanket across the arm. @Wife sits adjacent, resting a gentle hand over @Mia's shoulder.
No one on screen speaks; every on-screen mouth stays closed.
@AdultShaz, voiceover: {If you want to love someone, think about the good things they do.}
Hard cut.

SHOT 6 | 18–23s
Camera: close-up, eye level, slow push in.
Location: @cozy_family_living_room_evening.
On screen: @AdultShaz, @Wife, @Mia.
Look @AdultShaz: Navy-blue overshirt jacket open over light heather-grey t-shirt; khaki chinos; tan canvas sneakers.
Look @Wife: wears a hijab; hijab fully covering the hair and hairline; warm taupe hijab; Warm taupe long tunic with warm taupe hijab; deep chocolate-brown trousers; cream shoes.
Look @Mia: wears a hijab; hijab fully covering the hair and hairline; Sky-blue pinafore dress over white long-sleeve top; white leggings; light brown shoes; sky-blue hijab.
Props: the couch with a folded blanket across the arm.
@Wife chimes in with an affectionate, playful smile and leans forward; @AdultShaz leans in warmly as both parents kiss @Mia on both cheeks at the same time on the couch with a folded blanket across the arm, while @Mia giggles in sheer joy.
No one on screen speaks; every on-screen mouth stays closed.
@AdultShaz, voiceover: {Mia, I love you.}
@Wife: {No, WE love you!}
Hard cut.`;

const seg3_tenBlocks = {
  block1_referenceMaterials: `@AdultShaz = Adult man in his twenties with slim athletic build, short black hair faded at sides and swept up on top, short full dark beard, dark brown eyes, Navy-blue overshirt jacket open over light heather-grey t-shirt, khaki chinos, tan canvas sneakers.
@Wife = Adult woman in her twenties with light olive skin, warm taupe hijab fully covering hair and hairline with no visible hair, Warm taupe long tunic with warm taupe hijab, deep chocolate-brown trousers, cream shoes.
@Mia = Young eight-year-old girl with light olive skin, sky-blue hijab fully covering hair and hairline with no visible hair, Sky-blue pinafore dress over white long-sleeve top, white leggings, light brown shoes.
@dallas_bedroom_evening = Dallas bedroom evening interior plate, soft warm bedside lamp light, neutral walls and headboard.
@chicago_nook_evening = Chicago reading nook evening plate, warm interior floor lamp glow, cozy window armchair.
@cozy_family_living_room_evening = Cozy family living room evening plate, warm amber lamps, comfortable fabric sofa with throw blanket.
Each reference is one person or one object and appears once. No duplicates.`,

  block2_voices: `@AdultShaz VOICE: "An off-screen narrator voice; @AdultShaz on screen never speaks these lines. Man in his early thirties, American accent, warm low timbre, steady unhurried pace, earnest storytelling delivery that softens at the close"
@Wife VOICE: "Woman in her late twenties, American accent, soft calm timbre, slow steady pace, gentle reassuring delivery"`,

  block3_goal: `A six-shot, twenty-three-second segment following a long-distance relationship blossoming into marriage and loving parenthood. It ends the instant both parents kiss Mia on both cheeks and celebrate their shared love. Do not continue past that moment, do not resolve anything and do not add an ending.`,

  block4_continuity: `Location: the dallas bedroom in @dallas_bedroom_evening for shots 1 and 3 and the chicago nook in @chicago_nook_evening for shots 2 and 4 and the cozy family living room in @cozy_family_living_room_evening for shots 5 to 6. Never leave them. The camera stays on the same side of the action as in @dallas_bedroom_evening for shots 1 and 3 and as in @chicago_nook_evening for shots 2 and 4 and as in @cozy_family_living_room_evening for shots 5 to 6 and never crosses to the other side. 180-degree axis locked and this never flips. Only characters in the shot cast on screen per shot, no background crowd, no face repeats. Costumes are fixed for the whole segment and never change. @Wife wears warm taupe hijab fully covering hair and hairline, @Mia wears sky-blue hijab fully covering hair and hairline, and this never changes.`,

  block5_shots: seg3_shotsText,

  block6_visualStyle: `Feature-quality 3D animated film, production CG, not photorealistic and not flat cartoon. Warm evening lighting with golden incandescent amber practicals, soft subsurface scattering through skin and gentle cloth folds. Depth of field as a natural in-camera optical artifact keeping foreground subject crisp. Clean straight-played family drama and romance staging.`,

  block7_cameraAndPerformance: `This is a six-shot segment with five cuts between shots, every shot ending in a hard cut, total twenty-three seconds. The body plays honest. The face stays natural. No mugging, no pulled faces, no comic reactions. Anticipation: movement winds the opposite way first. Snap and Settle: fast transition between poses with overshoot on arrival. Moving Holds: held poses settle and micro-shift, never frozen mannequins. Overlap and Secondary Action: hair, cloth and attachments arrive a beat late. Eye Life: micro-saccades, catchlights and blink rate, eyes never glaze over.`,

  block8_audio: `Foley: phone tap, fabric rustle, sofa cushion settle, tea mug clink, warm cheek kiss, happy child giggle. Ambient room tone: quiet evening bedroom hum, subtle evening apartment atmosphere, warm cozy living room stillness. Score: gentle piano melody joins warm cello harmonies, building to an emotional, heartwarming crescendo on the family kiss.`,

  block9_exclusions: `The only spoken words in the entire segment are the lines in braces. No humming, mumbling, breaths-as-words or partial words from anyone on screen. Nothing else written anywhere in this prompt is dialogue, and nobody speaks who is not named on a line. No extra cuts anywhere. No unison movement. No subtitles, no watermark, no logo.`,

  block10_maintainConsistency: `Maintain @AdultShaz, @Wife, @Mia, @dallas_bedroom_evening, @chicago_nook_evening and @cozy_family_living_room_evening with fixed costume, hijab coverage, beard grooming and room sets. Child @Mia is 5 heads tall, adults @AdultShaz and @Wife are 6.5 to 7 heads tall, adult equals 7 heads tall, child equals 5 heads tall for scale reference. No face repeats, no extra characters.`
};

const seg3 = {
  segmentId: 3,
  title: 'Part 3: Showing Up and Love',
  totalDurationSec: 23,
  shotCount: 6,
  attachedElements: ['@AdultShaz', '@Wife', '@Mia', '@dallas_bedroom_evening', '@chicago_nook_evening', '@cozy_family_living_room_evening'],
  tenBlocks: seg3_tenBlocks,
  compiledPrompt: assembleCompiledPrompt(seg3_tenBlocks),
  generationPayload: { engine: 'seedance-2.5', durationSec: 23, resolution: '480p', aspectRatio: '16:9', fps: 24 },
  segmentIndex: 3,
  extendsFrom: 2,
  references: [
    { tag: '@AdultShaz', kind: 'character', sourceTag: '@Image 2', assetKey: 'asset:master-render:adult-shaz' },
    { tag: '@Wife', kind: 'character', sourceTag: '@Image 6', assetKey: 'asset:master-render:wife' },
    { tag: '@Mia', kind: 'character', sourceTag: '@Image 7', assetKey: 'asset:master-render:mia' },
    { tag: '@dallas_bedroom_evening', kind: 'location', sourceTag: '@Loc 5', assetKey: 'asset:location-plate:dallas-bedroom-evening' },
    { tag: '@chicago_nook_evening', kind: 'location', sourceTag: '@Loc 6', assetKey: 'asset:location-plate:chicago-nook-evening' },
    { tag: '@cozy_family_living_room_evening', kind: 'location', sourceTag: '@Loc 7', assetKey: 'asset:location-plate:cozy-family-living-room-evening' }
  ],
  shots: seg3_shots
};

const fullOutput = {
  segments: [seg1, seg2, seg3],
  totalRuntimeSec: 72,
  assumptions: []
};

console.log('Validating full output against check-seedance-prompts.mjs...');
const validation = validateSeedancePrompts(fullOutput, input);

console.log('isValid:', validation.isValid);
console.log('Errors (' + validation.errors.length + '):');
validation.errors.forEach(e => console.log('  ❌', e));
console.log('Warnings (' + validation.warnings.length + '):');
validation.warnings.forEach(w => console.log('  ⚠️', w));

if (validation.isValid) {
  const outPath = 'runs/r6-live/outputs/seedance-compiler.json';
  writeFileSync(outPath, JSON.stringify(fullOutput, null, 2), 'utf8');
  console.log('✅ Successfully wrote valid output to:', outPath);
} else {
  console.error('Validation failed!');
  process.exit(1);
}
