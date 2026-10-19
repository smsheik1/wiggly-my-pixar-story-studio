// Story Director v2 output contract (Zod, plain JS).
// BASE: Gemini's StoryDirectorOutputSchema (gemini-schema.ts). Wiggly additions are marked "WIGGLY".
import { z } from 'zod';

export const MAX_SEGMENT_SECONDS = 30;
export const MAX_TOTAL_SECONDS = 180; // WIGGLY: matches input targetTotalRuntimeSec max
export const IMAGE_ENGINE = 'nano-banana-2.1'; // WIGGLY: Nano Banana 2.1 via Google Flow, not gpt-image-2

export const DialogueSchema = z.object({
  speaker: z.string().describe("The speaker handle, e.g. '@Ben' or '@Miss_Park'"),
  line: z.string().regex(/^\{.+\}$/, 'Dialogue line must be enclosed in curly braces {}').describe("Verbatim dialogue line enclosed in braces, e.g. '{This is my dad.}'"),
  isVoiceover: z.boolean().default(false).describe('True if spoken as voiceover from off-screen or memory'),
  isOffCamera: z.boolean().default(false).describe('True if speaker is in the scene but currently out of frame'),
});

// WIGGLY: optional narration in the maker's cloned storyteller voice, alongside or instead of dialogue.
export const NarrationSchema = z.object({
  speaker: z.string().describe("Narrator element tag, usually the maker, e.g. '@Shaz'"),
  line: z.string().regex(/^\{.+\}$/, 'Narration line must be enclosed in curly braces {}'),
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
  directorsNote: z.string().optional().describe('Explains consequence: what breaks if this shot is got wrong'),
  isContinuousMove: z.boolean().default(false).describe('True if camera move is unbroken across the entire duration'),
}).refine((shot) => shot.endSec > shot.startSec, { message: 'endSec must be strictly greater than startSec' });

export const ScriptSegmentSchema = z.object({
  segmentId: z.number().int().positive().describe('Segment index (e.g. 1 for Original, 2 for Sequel, 3 for Sequel 2)'),
  title: z.string().min(3).describe("Part title, e.g. 'Part 1: Ben's Presentation'"),
  targetDurationSec: z.number().int().min(1).max(30).describe('Total segment duration in seconds — HARD CEILING IS 30s'),
  goalSummary: z.string().min(10).describe('2-3 sentences explaining goal, shot count, and the hard narrative stop'),
  continuityLocks: z.array(z.string()).min(1).describe('Character counts, seating positions, 180-degree axis lock'),
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
  elementTag: z.string().regex(/^@[\w_]+$/, "Element tag must start with @ and contain alphanumeric or underscore, e.g. '@Mia'"),
  age: z.number().int().positive(),
  oneWordRole: z.string().min(2).describe("e.g. 'presenter', 'teacher', 'father'"),
  physicalDescription: z.string().min(20).describe('Plain visual description anyone could draw from; no non-visual adjectives'),
  signatureAccent: z.string().min(5).describe('One worn/attached item carrying the only saturated color in an otherwise muted palette'),
  voiceDescription: z.string().min(20).describe('Age, nationality, timbre, pace, delivery, emotional shifts'),
  // WIGGLY
  skinTone: z.string().min(3).describe('Plain-words skin tone; repeated in every panel and shot that shows them'),
  gender: z.enum(['female', 'male']),
  family: z.boolean().default(true).describe('Member of the maker’s family (hijab rule applies to female family)'),
  realPerson: z.string().min(1).describe("WIGGLY: the real person this card depicts, e.g. 'Shaz'. At most 2 cards (age variants) per real person"),
  ageNote: z.string().min(3).nullable().default(null).describe("WIGGLY: the true age from the answers math when the depicted age differs, e.g. 'true age 15 (7 years older than Shaz at 8); shown as 18'"),
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

/** Read storyboard sheets from new outputs, or from old single-sheet `storyboardPrompt` run outputs (segment 1). */
export function storyboardSheetsOf(d) {
  if (Array.isArray(d?.storyboardSheets)) return d.storyboardSheets;
  if (d?.storyboardPrompt) return [{ segmentId: d.segments?.[0]?.segmentId ?? 1, ...d.storyboardPrompt }];
  return [];
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
  // WIGGLY: one storyboard sheet (max 8 panels) per part, extra sheets when a part has >8 shots; every shot drawn once.
  storyboardSheets: z.array(StoryboardSheetSchema).min(1),
  htmlScriptDocument: z.string().min(200).describe('Rendered HTML card deck formatted in Fraunces, Karla, Space Mono and warm paper palette'),
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
  return r.data;
}
