// Character Architect v2 output contract (Zod, plain JS).
import { z } from 'zod';

export const IMAGE_ENGINE = 'nano-banana-2.1'; // Nano Banana 2.1 via Google Flow
export const PROMPT_MIN = 3500;
export const PROMPT_MAX = 5000;
export const TURNAROUND_VIEWS = ['front', 'three-quarter', 'side', 'back'];

export const OutfitSchema = z.object({
  segmentIds: z.array(z.number().int().positive()).min(1).describe('Story Director segments this outfit is worn in'),
  description: z.string().min(20).describe('Garment by garment with colours: crisp bright main garment against a darker piece'),
  isMain: z.boolean().default(false).describe('The outfit drawn in the turnaround row'),
});

export const CharacterSheetSchema = z.object({
  elementTag: z.string().regex(/^@[\w_]+$/, "elementTag must match a Story Director cast tag, e.g. '@Shaz'"),
  name: z.string().min(1),
  age: z.number().int().positive().refine((a) => !(a >= 13 && a <= 17), 'Teens are depicted as 18: age 13-17 is not allowed'),
  gender: z.enum(['female', 'male']),
  family: z.boolean().default(true),
  skinTone: z.string().min(3),
  turnaroundViews: z.array(z.enum(TURNAROUND_VIEWS)).length(4).default(TURNAROUND_VIEWS),
  expressionCount: z.number().int().min(4).max(12),
  expressions: z.array(z.string().min(3)).min(4).max(12),
  outfits: z.array(OutfitSchema).min(1),
  imageTag: z.string().regex(/^@Image \d+$/, "imageTag must look like '@Image 1'"),
  targetEngine: z.literal(IMAGE_ENGINE).default(IMAGE_ENGINE),
  sheetPrompt: z.string()
    .min(PROMPT_MIN, `sheetPrompt must be at least ${PROMPT_MIN} characters`)
    .max(PROMPT_MAX, `sheetPrompt must be at most ${PROMPT_MAX} characters`)
    .refine((s) => !/[\r\n]/.test(s), 'sheetPrompt must be a single line (Google Flow)'),
  likenessSource: z.enum(['photo-notes', 'script-only']).describe('Where the face description came from'),
}).refine((c) => c.expressions.length === c.expressionCount, { message: 'expressions.length must equal expressionCount', path: ['expressions'] })
  .refine((c) => c.outfits.filter((o) => o.isMain).length === 1, { message: 'exactly one outfit must be isMain', path: ['outfits'] });

export const CharacterArchitectOutputSchema = z.object({
  characters: z.array(CharacterSheetSchema).min(1),
  assumptions: z.array(z.string()).default([]),
}).strict().superRefine((d, ctx) => {
  const tags = d.characters.map((c) => c.elementTag);
  if (new Set(tags).size !== tags.length) ctx.addIssue({ code: 'custom', path: ['characters'], message: 'duplicate elementTag' });
  d.characters.forEach((c, i) => {
    if (c.imageTag !== `@Image ${i + 1}`)
      ctx.addIssue({ code: 'custom', path: ['characters', i, 'imageTag'], message: `imageTag must be '@Image ${i + 1}' (positional, in cast order)` });
  });
});

export class CharacterSheetParseError extends Error {
  constructor(issues) {
    super('Character Architect output failed the contract:\n' +
      issues.map((i) => `  - ${(i.path ?? []).join('.') || '(root)'}: ${i.message}`).join('\n'));
    this.name = 'CharacterSheetParseError';
    this.issues = issues;
  }
}

/** Parse Character Architect output (object or JSON string). Throws CharacterSheetParseError. */
export function parseCharacterSheets(input) {
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); } catch (e) { throw new CharacterSheetParseError([{ path: [], message: `not valid JSON (${e.message})` }]); }
  }
  const r = CharacterArchitectOutputSchema.safeParse(obj);
  if (!r.success) throw new CharacterSheetParseError(r.error.issues);
  return r.data;
}
