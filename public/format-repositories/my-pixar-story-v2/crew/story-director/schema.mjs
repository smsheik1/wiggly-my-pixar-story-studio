// Story Director v2 output contract (Zod). Structural shape only; semantic rules live in
// ../linter/check-stage-play.mjs. parseStagePlay() throws StagePlayParseError with readable paths.
import { z } from 'zod';

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be a lowercase slug');
const sec = z.number().int('must be a whole second').nonnegative();
// Dialogue line: `@speaker-id: {exact words}`
export const DIALOGUE_RE = /^@([a-z0-9]+(?:-[a-z0-9]+)*): \{([^{}]+)\}$/;

export const CastMember = z.object({
  id: slug,
  name: z.string().min(1),
  ageVariant: z.string().min(1),
  minor: z.boolean(),
  gender: z.enum(['female', 'male']),
  family: z.boolean().default(true),
  skinTone: z.string().min(3),
  look: z.string().min(10),
  voice: z.string().default(''),
  storyPurpose: z.string().min(1),
});

export const Location = z.object({
  id: slug, name: z.string().min(1), description: z.string().min(1),
  keyLight: z.string().min(1), timeOfDay: z.string().min(1),
});

export const Shot = z.object({
  id: z.string().min(1),
  start: sec, end: sec,
  job: z.string().min(1),
  size: z.enum(['wide', 'medium', 'close-up', 'extreme close-up', 'insert', 'over-the-shoulder']),
  angle: z.enum(['eye level', 'low', 'high', 'overhead']),
  cameraMove: z.enum(['static', 'slow push-in', 'pull back', 'pan', 'track']),
  characterIds: z.array(slug),
  locationId: slug,
  action: z.string().min(1),
  acting: z.string().min(1),
  skinTones: z.string().default(''),
  keyLight: z.string().min(1),
  continuity: z.string().min(1),
});

export const DialogueLine = z.object({
  line: z.string().regex(DIALOGUE_RE, 'dialogue must be `@speaker-id: {exact words}`'),
  shotId: z.string().min(1),
  seconds: sec.min(1),
});

export const Beat = z.object({
  beat: z.number().int().positive(),
  part: z.number().int().positive(),
  durationSeconds: sec.min(2).max(30, 'a Part segment can never exceed 30 s'),
  emotionalPurpose: z.string().min(1),
  devices: z.array(z.string()).default([]),
  sourceAnswers: z.array(z.string()).min(1),
  narration: z.string().default(''),
  directQuotes: z.array(z.object({ text: z.string().min(1), sourceAnswer: z.string().min(1) })).default([]),
  dialogue: z.array(DialogueLine).default([]),
  shots: z.array(Shot).min(1),
});

export const StagePlay = z.object({
  title: z.string().min(1),
  logline: z.string().min(1),
  clarifyingQuestion: z.string().min(1).nullable(),
  assumptions: z.array(z.string()).default([]),
  cast: z.array(CastMember).min(1),
  locations: z.array(Location).min(1),
  beats: z.array(Beat).min(1),
  directorsNotes: z.array(z.string()).default([]),
  storyboardPrompt: z.string().min(20),
  commonSenseChecks: z.array(z.object({
    category: z.string(), finding: z.string(), resolution: z.string(),
  })).default([]),
  deckHtml: z.string().regex(/<html[\s>]/i, 'deckHtml must be an HTML document'),
}).strict();

export class StagePlayParseError extends Error {
  constructor(issues) {
    super('Story Director output failed the contract:\n' +
      issues.map(i => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n'));
    this.name = 'StagePlayParseError';
    this.issues = issues;
  }
}

/** Parse a stage play (object or JSON string). Throws StagePlayParseError on any violation. */
export function parseStagePlay(input) {
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); }
    catch (e) { throw new StagePlayParseError([{ path: [], message: `not valid JSON (${e.message})` }]); }
  }
  const r = StagePlay.safeParse(obj);
  if (!r.success) throw new StagePlayParseError(r.error.issues);
  return r.data;
}
