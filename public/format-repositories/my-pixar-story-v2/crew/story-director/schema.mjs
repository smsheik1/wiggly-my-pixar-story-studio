// Story Director v2 output contract (Zod, plain JS).
// BASE: Gemini's StoryDirectorOutputSchema (gemini-schema.ts). Wiggly additions are marked "WIGGLY".
import { z } from 'zod';
import { withRenderedArtifacts, buildStoryboardSheets } from '../../scripts/lib/sd-render.mjs';
/** 'none' / 'n/a' / 'no accessory' etc. count as empty: no accessory. */
export const NO_ACCESSORY = /^(?:none|n\/?a|nil|null|-+|no (?:signature |always[- ]worn |worn )?(?:accent|accessor(?:y|ies)|item)s?(?: given| stated)?)\.?$/i;
/** The accent text, or '' when there is none (missing, empty, whitespace, 'none'). */
export const accentOf = (v) => { const t = typeof v === 'string' ? v.trim() : ''; return !t || NO_ACCESSORY.test(t) ? '' : t; };
/** Optional accessory field (plain string so the submit tool's JSON schema stays representable). */
export const OptionalAccent = z.string().trim().optional();
/** Drop empty / 'none' signatureAccent keys from cast-like cards (parsers call this; empty = no accessory). */
export const dropEmptyAccents = (cards) => (cards ?? []).map((c) => {
  if (!c || typeof c !== 'object' || !('signatureAccent' in c) || accentOf(c.signatureAccent)) return c;
  const { signatureAccent: _none, ...rest } = c; return rest;
});

export const MAX_SEGMENT_SECONDS = 30;
export const MAX_TOTAL_SECONDS = 180; // WIGGLY: matches input targetTotalRuntimeSec max
export const IMAGE_ENGINE = 'nano-banana-2.1'; // WIGGLY: Nano Banana 2.1 via Google Flow, not gpt-image-2

// Spoken line fields shared with the Seedance Compiler input (which does not need the source).
export const DialogueLineSchema = z.object({
  speaker: z.string().describe("The speaker handle, e.g. '@Ben' or '@Miss_Park'"),
  line: z.string().regex(/^\{.+\}$/, 'Dialogue line must be enclosed in curly braces {}').describe("Verbatim dialogue line enclosed in braces, e.g. '{This is my dad.}'"),
  isVoiceover: z.boolean().default(false).describe('True if spoken as voiceover from off-screen or memory'),
  isOffCamera: z.boolean().default(false).describe('True if speaker is in the scene but currently out of frame'),
});
// WIGGLY: optional narration in the maker's cloned storyteller voice, alongside or instead of dialogue.
export const NarrationLineSchema = z.object({
  speaker: z.string().describe("Narrator element tag, usually the maker, e.g. '@AdultTheo'"),
  line: z.string().regex(/^\{.+\}$/, 'Narration line must be enclosed in curly braces {}'),
});
// WIGGLY answer tracing: every line names the family answer it comes from (crew/linter/answer-sources.mjs checks it).
export const LineSourceSchema = z.object({
  answer: z.string().trim().min(1).optional().describe("Id of the answer in input.json the line comes from: its key path inside answers, e.g. 'scene1Childhood.memory'. Required unless kind is 'connective'"),
  kind: z.enum(['verbatim', 'paraphrase', 'connective']).optional().describe("Omit for a line told in your own words from the answer's facts (wording is free; 'paraphrase' means the same). verbatim: the line quotes the family's own sentence near word for word. connective: a short scene-setting line that states no facts (answer may be omitted)."),
}).refine((s) => s.kind === 'connective' || !!s.answer, { message: "source.answer is required unless kind is 'connective'", path: ['answer'] });
export const DialogueSchema = DialogueLineSchema.extend({ source: LineSourceSchema });
export const NarrationSchema = NarrationLineSchema.extend({ source: LineSourceSchema });

const TAG_RE = /^@[\w_]+$/;
// WIGGLY shot locks: one lock per scene (a run of consecutive shots in one place) that every shot of the scene repeats.
export const SceneLockSchema = z.object({
  shots: z.array(z.number().int().positive()).min(1).describe('The consecutive shotNumbers of this scene'),
  present: z.array(z.string().regex(TAG_RE)).describe('Cast @tags in the scene (in the room, even when out of frame in a shot)'),
  props: z.array(z.string().trim().min(5)).default([]).describe("Each prop that matters with its ONE state for the whole scene, written once and repeated word for word downstream, e.g. \"the phone held flat in @Theo's right hand, screen lit\". A state change starts a new scene"),
});

export const ShotCardSchema = z.object({
  shotNumber: z.number().int().positive().describe('Sequential shot number within the segment'),
  startSec: z.number().int().nonnegative().describe('Start timecode in whole integer seconds'),
  endSec: z.number().int().positive().describe('End timecode in whole integer seconds'),
  tag: z.string().optional().describe("Optional shot tag, e.g. 'Montage', 'Continuous camera move', 'Fire wipe'"),
  location: z.string().min(1).describe('WIGGLY: REQUIRED on every shot; must exactly match one entry name in the top-level locations list'),
  // WIGGLY: camera direction is required on every shot so the Seedance Compiler never invents it.
  framing: z.string().min(3).describe("Shot size / framing in plain words, e.g. 'wide', 'medium', 'close-up', 'over her shoulder'"),
  cameraAngle: z.string().min(3).describe("Camera angle, e.g. 'eye level', 'low angle from the floor', 'high angle looking down'"),
  cameraMove: z.string().min(3).describe("Camera move, e.g. 'static', 'slow push in', 'pan left to follow', 'crane up'"),
  whatWeSee: z.string().min(10).describe('Visual action in plain English. Refer to people ONLY by their @tag (e.g. @Mom); never re-describe looks'),
  whatWeHear: z.string().optional().describe('Foley, room tone, or music cues; mandatory on silent shots'),
  dialogue: DialogueSchema.optional(),
  narration: NarrationSchema.optional(), // WIGGLY
  // WIGGLY shot locks: exactly who is in frame, and the only way someone arrives or leaves mid-scene.
  onScreen: z.array(z.string().regex(TAG_RE)).describe('Exactly the cast @tags in frame in this shot (the same people whatWeSee names); [] for nobody. An on-camera speaker is always here'),
  enters: z.array(z.string().regex(TAG_RE)).optional().describe('Cast @tags who arrive in this shot (they are on screen here and not earlier in the scene)'),
  exits: z.array(z.string().regex(TAG_RE)).optional().describe('Cast @tags who leave in this shot (on screen here, not later in the scene)'),
  directorsNote: z.string().optional().describe('Explains consequence: what breaks if this shot is got wrong'),
  isContinuousMove: z.boolean().default(false).describe('True if camera move is unbroken across the entire duration'),
}).refine((shot) => shot.endSec > shot.startSec, { message: 'endSec must be strictly greater than startSec' });

export const ScriptSegmentSchema = z.object({
  segmentId: z.number().int().positive().describe('Segment index (e.g. 1 for Original, 2 for Sequel, 3 for Sequel 2)'),
  title: z.string().min(3).describe("Part title, e.g. 'Part 1: Ben's Presentation'"),
  targetDurationSec: z.number().int().min(1).max(30).describe('Total segment duration in seconds — HARD CEILING IS 30s'),
  goalSummary: z.string().min(10).describe('2-3 sentences explaining goal, shot count, and the hard narrative stop'),
  continuityLocks: z.array(z.string()).min(1).describe('Character counts, seating positions, 180-degree axis lock'),
  // WIGGLY answer tracing: the answers whose memories this part depicts.
  scenes: z.array(SceneLockSchema).min(1).describe('WIGGLY shot locks: every shot in exactly one scene, in order'),
  answerSources: z.array(z.string().trim().min(1)).min(1).describe("Answer ids (key paths inside input.json answers) whose memories this part depicts, e.g. ['scene1Childhood.memory']"),
  shots: z.array(ShotCardSchema).min(1).describe('Ordered shot sequence'),
}).refine((segment) => {
  const total = segment.shots.reduce((acc, shot) => acc + (shot.endSec - shot.startSec), 0);
  return total <= 30;
}, { message: 'The sum of shot durations in a segment CANNOT EXCEED 30 seconds' })
  // WIGGLY: contiguous, non-overlapping, starting at 0 in every segment.
  .refine((segment) => segment.shots.every((s, i) => s.startSec === (i === 0 ? 0 : segment.shots[i - 1].endSec)),
    { message: 'Timecodes must start at 0 and be strictly consecutive within each segment' });

export const CastCardSchema = z.object({
  name: z.string().min(1),
  elementTag: z.string().regex(/^@[\w_]+$/, "Element tag must start with @ and contain alphanumeric or underscore, e.g. '@Wren'"),
  age: z.number().int().positive(),
  oneWordRole: z.string().min(2).describe("e.g. 'presenter', 'teacher', 'father'"),
  physicalDescription: z.string().min(20).describe('Plain visual description anyone could draw from; no non-visual adjectives'),
  // Optional (r5-dry1: the SD invented accents and hijab colours to fill a required field). Empty/none = no accessory,
  // and it is then left out of the per-shot Look locks. Never invented: only an item the answers / cast notes give, in their wording.
  signatureAccent: OptionalAccent.describe("The one always-worn item the answers / cast notes give, in their wording (e.g. 'wears a hijab'); omit or leave empty when none is given. Never invent details such as colours"),
  // WIGGLY shot locks: everything else this person always wears, each written once exactly as worn; repeated word for word in every shot they are on screen.
  signatureAccessories: z.array(z.string().trim().min(3)).default([]).describe("Other items they always wear, exactly as worn, e.g. 'hijab fully covering the hair and hairline', 'round glasses pushed up on the forehead'; only items the answers give, never invented details such as colours"),
  voiceDescription: z.string().min(20).describe('Age, nationality, timbre, pace, delivery, emotional shifts'),
  // WIGGLY
  skinTone: z.string().min(3).describe('Plain-words skin tone; repeated in every panel and shot that shows them'),
  gender: z.enum(['female', 'male']),
  family: z.boolean().default(true).describe('Member of the maker’s family (hijab rule applies to female family)'),
  realPerson: z.string().min(1).describe("WIGGLY: the real person this card depicts, e.g. 'Theo'. Up to 3 cards (child under 13, young adult shown as 18, adult) per real person"),
  ageNote: z.string().min(3).nullable().default(null).describe("WIGGLY: the true age from the answers math when the depicted age differs, e.g. 'true age 15 (7 years older than the maker at 8); shown as 18'"),
  photoRef: z.string().min(1).nullable().default(null).describe('WIGGLY: id of the photoCharacters entry this card is drawn from, or null when no photo exists'),
}).refine((c) => !(c.age >= 13 && c.age <= 17), { message: 'Teens are depicted as 18: age 13-17 is not allowed', path: ['age'] });

export const StoryboardPanelSchema = z.object({
  panelNumber: z.number().int().min(1).max(8).describe('Position on this sheet, 1..N'),
  shotNumberRef: z.number().int().positive().describe("The real shotNumber within this sheet's segment"),
  shotSizeAndAngle: z.string().min(3).describe("e.g. 'Wide shot at adult chest height'"),
  whatIsInFrame: z.string().min(10).describe('Who is in frame, naming skin tone explicitly, and what they are doing'),
  lightAndPalette: z.string().min(10).describe('Direction of key light, shadow warmth, and color tones'),
});

export const MAX_PANELS_PER_SHEET = 8;
// WIGGLY: was a single 8-panel storyboardPrompt (first 8 shots only). Now one sheet per part.
export const StoryboardSheetSchema = z.object({
  segmentId: z.number().int().positive().describe('The part (segment) every panel on this sheet comes from'),
  targetEngine: z.literal(IMAGE_ENGINE).default(IMAGE_ENGINE), // WIGGLY (was gpt-image-2)
  fullPrompt: z.string().min(100).refine((s) => !/[\r\n]/.test(s), 'fullPrompt must be a single line (Google Flow)')
    .describe('Copy-pasteable N-panel colour board prompt for Nano Banana 2.1 in Google Flow, one line'),
  panels: z.array(StoryboardPanelSchema).min(1).max(MAX_PANELS_PER_SHEET, `A storyboard sheet has at most ${MAX_PANELS_PER_SHEET} panels`),
});

/** Storyboard sheets of an output: the attached ones (parsed outputs carry code-built sheets; old run outputs carry
 * model-written ones or a single-sheet `storyboardPrompt`), else built in code from the shots (scripts/lib/sd-render.mjs). */
export function storyboardSheetsOf(d) {
  if (Array.isArray(d?.storyboardSheets)) return d.storyboardSheets;
  if (d?.storyboardPrompt) return [{ segmentId: d.segments?.[0]?.segmentId ?? 1, ...d.storyboardPrompt }];
  return Array.isArray(d?.segments) ? buildStoryboardSheets(d) : [];
}

// WIGGLY: the defined set of story locations; every shot names one of these exactly.
export const StoryLocationSchema = z.object({
  name: z.string().min(2).describe("Short unique location name, e.g. 'Family living room'"),
  description: z.string().min(20).describe('What the background must contain: place, era, time of day, key set dressing (for the Location Scout)'),
});

export const StoryDirectorOutputSchema = z.object({
  masthead: z.object({
    title: z.string().min(3),
    draftNumber: z.number().int().positive().default(1),
    oneLinePremise: z.string().min(10).describe('Gives away the tone and conflict, but NOT the ending'),
  }),
  // WIGGLY: the finale is built around ONE idea from the family's answers; every final-part line serves it.
  finaleThesis: z.string().trim().min(10).describe("One plain sentence naming the one idea the finale is built around, taken from the family's answers"),
  shapeBar: z.object({
    totalRuntimeSec: z.number().int().positive().max(MAX_TOTAL_SECONDS),
    parts: z.array(z.object({ name: z.string(), durationSec: z.number().int().positive() })),
  }),
  cast: z.array(CastCardSchema).min(1),
  locations: z.array(StoryLocationSchema).min(1).describe('WIGGLY: every background the film needs, each used by at least one shot'),
  segments: z.array(ScriptSegmentSchema).min(1),
  // WIGGLY: storyboardSheets and htmlScriptDocument are no longer written by the model; parseStagePlay builds them in
  // code from this JSON (scripts/lib/sd-render.mjs), so any model-written copies are dropped.
  // WIGGLY
  clarifyingQuestion: z.string().min(1).nullable().default(null),
  assumptions: z.array(z.string()).default([]),
}).superRefine((d, ctx) => {
  // WIGGLY tag parity: every speaker/narrator must be a cast elementTag.
  const tags = new Set(d.cast.map((c) => c.elementTag));
  d.segments.forEach((seg, si) => seg.shots.forEach((s, hi) => {
    for (const k of ['dialogue', 'narration']) if (s[k] && !tags.has(s[k].speaker))
      ctx.addIssue({ code: 'custom', path: ['segments', si, 'shots', hi, k, 'speaker'], message: `Speaker ${s[k].speaker} is not a cast elementTag` });
  }));
  // WIGGLY: every shot's location must be one of the defined locations.
  const locs = new Set((d.locations ?? []).map((l) => l.name));
  d.segments.forEach((seg, si) => seg.shots.forEach((s, hi) => {
    if (!locs.has(s.location)) ctx.addIssue({ code: 'custom', path: ['segments', si, 'shots', hi, 'location'], message: `Location '${s.location}' is not in the locations list (${[...locs].join(', ')})` });
  }));
  const total = d.segments.reduce((n, seg) => n + seg.shots.reduce((m, s) => m + (s.endSec - s.startSec), 0), 0);
  if (total > MAX_TOTAL_SECONDS) ctx.addIssue({ code: 'custom', path: ['segments'], message: `Film runtime ${total}s exceeds ${MAX_TOTAL_SECONDS}s` });
});

export const StagePlay = StoryDirectorOutputSchema;

export class StagePlayParseError extends Error {
  constructor(issues) {
    super('Story Director output failed the contract:\n' +
      issues.map((i) => `  - ${(i.path ?? []).join('.') || '(root)'}: ${i.message}`).join('\n'));
    this.name = 'StagePlayParseError';
    this.issues = issues;
  }
}

/** Parse Story Director output (object or JSON string). Throws StagePlayParseError on any violation. */
export function parseStagePlay(input) {
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); } catch (e) { throw new StagePlayParseError([{ path: [], message: `not valid JSON (${e.message})` }]); }
  }
  const r = StoryDirectorOutputSchema.safeParse(obj);
  if (!r.success) throw new StagePlayParseError(r.error.issues);
  return withRenderedArtifacts({ ...r.data, cast: dropEmptyAccents(r.data.cast) });
}
