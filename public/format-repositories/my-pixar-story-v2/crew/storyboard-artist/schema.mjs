// Storyboard Artist output contract: one multi-panel storyboard SHEET per story part (max 8 panels, two rows of four, each
// panel 16:9, labelled with its shot id). The agent writes the panels; the sheet's fullPrompt and its reference list are
// assembled in code (crew/storyboard-artist/compile.mjs) so the layout text and the reference order never drift.
import { z } from 'zod';

export const SHOT_ID = /^\d+\.\d+$/;
export const PANELS_PER_SHEET = 8;

export const PanelCharacterSchema = z.object({
  tag: z.string().regex(/^@[\w_]+$/).describe('the cast elementTag, e.g. @Hero'),
  wardrobe: z.string().min(5).describe("the character's Character Architect outfit for this part, copied word for word"),
  props: z.array(z.string().min(2)).default([]).describe("hand props / accessories this character holds or wears in this panel; only items that are THIS character's"),
  pose: z.string().min(5),
  expression: z.string().min(3),
}).strict();

export const PanelSchema = z.object({
  panelNumber: z.number().int().min(1).max(PANELS_PER_SHEET),
  shotId: z.string().regex(SHOT_ID, "shotId looks like '1.3' (part.shot)"),
  locationTag: z.string().regex(/^@Loc \d+$/),
  shotSizeAndAngle: z.string().min(5),
  characters: z.array(PanelCharacterSchema).default([]),
  staging: z.string().min(10).describe('where each character stands in frame, screen direction, foreground/background'),
  lightAndPalette: z.string().min(10),
}).strict();

export const SheetSchema = z.object({
  segmentId: z.number().int().positive(),
  sheetIndex: z.number().int().positive().default(1).describe('1 unless a part has more than 8 shots'),
  panels: z.array(PanelSchema).min(1).max(PANELS_PER_SHEET),
}).strict();

export const StoryboardArtistOutputSchema = z.object({
  sheets: z.array(SheetSchema).min(1),
  assumptions: z.array(z.string()).default([]),
}).strict();

export class StoryboardParseError extends Error {
  constructor(issues) {
    super('Storyboard Artist output failed the contract:\n' + issues.map((i) => `  - ${(i.path ?? []).join('.') || '(root)'}: ${i.message}`).join('\n'));
    this.name = 'StoryboardParseError'; this.issues = issues;
  }
}

/** Parse Storyboard Artist output (object or JSON string). Throws StoryboardParseError. */
export function parseStoryboard(input) {
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); } catch (e) { throw new StoryboardParseError([{ path: [], message: `not valid JSON (${e.message})` }]); }
  }
  const r = StoryboardArtistOutputSchema.safeParse(obj);
  if (!r.success) throw new StoryboardParseError(r.error.issues);
  return r.data;
}

export const sheetIdOf = (s) => (s.sheetIndex > 1 ? `${s.segmentId}-${s.sheetIndex}` : `${s.segmentId}`);
