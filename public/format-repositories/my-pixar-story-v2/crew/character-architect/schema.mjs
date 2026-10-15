// Character Architect v2 output contract (Zod, plain JS).
// BASE: Gemini's CharacterArchitectOutputSchema (gemini-ca-output.md), one object per character.
// Wiggly additions are marked "WIGGLY".
import { z } from 'zod';

export const IMAGE_ENGINE = 'nano-banana-2.1'; // WIGGLY: both phases, Google Flow (was gpt-image-2 / seedream-5.0-pro)
export const SHEET_MIN = 3500; // WIGGLY sheet length bounds
export const SHEET_MAX = 5000;
export const MASTER_MAX = 5000;
export const SHEET_EXPRESSIONS = ['NEUTRAL', 'HAPPY', 'DELIGHTED', 'SAD', 'SURPRISED', 'CONFUSED', 'ANGRY', 'TALKING'];
export const ASSET_KEY = /^[A-Za-z0-9][\w.:-]*$/; // local project asset key; no URLs, no paths
const singleLine = (s) => !/[\r\n]/.test(s);

export const DesignSpecsSchema = z.object({
  headsTall: z.number().min(4).max(7.5).describe('Toddler 4, Child 4.5-5, Teen 6-6.5, Adult 7'),
  dominantSilhouette: z.string().min(5).describe('Shape reading in pure black silhouette'),
  exaggeration: z.string().min(5).describe('The one exaggerated feature'),
  counterpart: z.string().min(5).describe('Neighbouring features kept small'),
  skinZoning: z.enum(['light', 'deep']).describe('Light: pink nose, translucent red ears; Deep: red-orange nose, plum-red flush, grey-violet'),
  signatureAccent: z.string().min(5).describe('Only saturated colour'),
  isChildProportionRiderApplied: z.boolean().describe('Long torso, short legs, enlarged head; MUST be false for adults'),
  cleanSkinGuarantee: z.boolean().default(true).describe('No tattoos/ink'),
  emptyHandsGuarantee: z.boolean().default(true).describe('Open empty hands, no props'),
});

export const MasterRenderPromptSchema = z.object({
  targetEngine: z.literal(IMAGE_ENGINE).default(IMAGE_ENGINE),
  promptText: z.string().min(200).max(MASTER_MAX).refine(singleLine, 'promptText must be a single line (Google Flow)')
    .describe('12 fixed+swap lines, flattened to one line'),
  aspectRatio: z.literal('1:1').default('1:1'),
});

export const ModelSheetPromptSchema = z.object({
  targetEngine: z.literal(IMAGE_ENGINE).default(IMAGE_ENGINE),
  promptText: z.string().min(SHEET_MIN, `modelSheetPrompt.promptText must be at least ${SHEET_MIN} characters`)
    .max(SHEET_MAX, `modelSheetPrompt.promptText must be at most ${SHEET_MAX} characters`)
    .refine(singleLine, 'promptText must be a single line (Google Flow)')
    .describe('Format B: 4 turnaround views + 8 standardized expressions, #B5B5B5 background hex'),
  aspectRatio: z.literal('16:9').default('16:9'),
  resolution: z.literal('2K').default('2K'),
  // WIGGLY: replaces referenceImageUrl. A local project asset key for the approved master render, attached in Flow.
  masterRenderRef: z.string().regex(ASSET_KEY, 'masterRenderRef must be a local asset key, not a URL or file path'),
  expressionCount: z.literal(8).default(8),
});

export const OutfitSchema = z.object({ // WIGGLY
  segmentIds: z.array(z.number().int().positive()).min(1),
  description: z.string().min(20),
  isMain: z.boolean().default(false).describe('The outfit drawn on the render/sheet; others are later edits'),
});

export const CharacterSchema = z.object({
  characterId: z.string().min(1),
  name: z.string().min(1),
  elementTag: z.string().regex(/^@[\w_]+$/),
  designSpecs: DesignSpecsSchema,
  masterRenderPrompt: MasterRenderPromptSchema,
  modelSheetPrompt: ModelSheetPromptSchema.optional(),
  // WIGGLY
  age: z.number().int().positive(),
  gender: z.enum(['female', 'male']),
  family: z.boolean().default(true),
  skinTone: z.string().min(3),
  imageTag: z.string().regex(/^@Image \d+$/, "imageTag must look like '@Image 1'"),
  outfits: z.array(OutfitSchema).min(1),
}).refine((d) => !(d.designSpecs.headsTall >= 6.5 && d.designSpecs.isChildProportionRiderApplied), {
  message: 'Bobblehead Anti-Pattern: Adult character (>=6.5 heads) cannot have child proportion rider applied!',
  path: ['designSpecs', 'isChildProportionRiderApplied'],
}).refine((d) => !(d.designSpecs.headsTall <= 5.0 && !d.designSpecs.isChildProportionRiderApplied), {
  message: 'Child Proportion Rider is MANDATORY for young characters (<= 5.0 heads tall) to prevent adult long legs',
  path: ['designSpecs', 'isChildProportionRiderApplied'],
}).refine((d) => !(d.age >= 13 && d.age <= 17), { message: 'Teens are depicted as 18: age 13-17 is not allowed', path: ['age'] }) // WIGGLY
  .refine((d) => !(d.age >= 18 && d.designSpecs.isChildProportionRiderApplied), { message: 'Characters depicted at 18+ never get the child proportion rider', path: ['designSpecs', 'isChildProportionRiderApplied'] })
  .refine((d) => d.outfits.filter((o) => o.isMain).length === 1, { message: 'exactly one outfit must be isMain', path: ['outfits'] })
  .refine((d) => d.designSpecs.cleanSkinGuarantee && d.designSpecs.emptyHandsGuarantee, { message: 'cleanSkinGuarantee and emptyHandsGuarantee must be true', path: ['designSpecs'] });

export const CharacterArchitectOutputSchema = z.object({ // WIGGLY wrapper: characters[] of Gemini's object
  mode: z.enum(['master-render', 'model-sheet']),
  characters: z.array(CharacterSchema).min(1),
  assumptions: z.array(z.string()).default([]),
}).strict().superRefine((d, ctx) => {
  const tags = d.characters.map((c) => c.elementTag);
  if (new Set(tags).size !== tags.length) ctx.addIssue({ code: 'custom', path: ['characters'], message: 'duplicate elementTag' });
  d.characters.forEach((c, i) => {
    if (c.imageTag !== `@Image ${i + 1}`)
      ctx.addIssue({ code: 'custom', path: ['characters', i, 'imageTag'], message: `imageTag must be '@Image ${i + 1}' (positional, in cast order)` });
    if (d.mode === 'model-sheet' && !c.modelSheetPrompt)
      ctx.addIssue({ code: 'custom', path: ['characters', i, 'modelSheetPrompt'], message: 'modelSheetPrompt is REQUIRED in model-sheet mode' });
    if (d.mode === 'master-render' && c.modelSheetPrompt)
      ctx.addIssue({ code: 'custom', path: ['characters', i, 'modelSheetPrompt'], message: 'master-render mode outputs master renders only (no modelSheetPrompt)' });
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
