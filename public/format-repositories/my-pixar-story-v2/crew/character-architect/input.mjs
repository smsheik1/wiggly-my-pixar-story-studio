// Character Architect v2 input slice: the ONLY state this agent may see.
// Included: Story Director cast cards, per-segment outfit/location context, photo-derived TEXT notes.
// Excluded: dialogue + timing, storyboard, HTML deck, secrets, URLs, photo paths/bytes.
import { z } from 'zod';
import { CastCardSchema } from '../story-director/schema.mjs';

export const CharacterArchitectInput = z.object({
  cast: z.array(CastCardSchema).min(1),
  segments: z.array(z.object({
    segmentId: z.number().int().positive(),
    title: z.string(),
    continuityLocks: z.array(z.string()),
    locations: z.array(z.string()),
    visualContext: z.array(z.string()).describe('whatWeSee per shot (wardrobe/action context only)'),
  }).strict()).min(1),
  photoNotes: z.array(z.object({ elementTag: z.string().regex(/^@[\w_]+$/), notes: z.string().min(1) }).strict()).default([]),
}).strict();

const URLISH = /\b(?:https?:\/\/|file:\/\/)\S+|(?:\/Users|\/home|~)\/\S+|\b\S+\.(?:jpe?g|png|heic|webp)\b/gi;
const scrub = (s) => String(s ?? '').replace(URLISH, '[removed]');

/** Filter shared pipeline state to the Character Architect slice. */
export function selectCharacterArchitectInput(state = {}) {
  const p = state.project ?? state;
  const sd = p.storyDirector ?? p.stagePlay ?? {};
  const segments = (sd.segments ?? []).map((seg) => ({
    segmentId: seg.segmentId,
    title: seg.title,
    continuityLocks: seg.continuityLocks ?? [],
    locations: [...new Set((seg.shots ?? []).map((s) => s.location).filter(Boolean))],
    visualContext: (seg.shots ?? []).map((s) => s.whatWeSee),
  }));
  const photoNotes = (p.photoNotes ?? p.inputs?.photoNotes ?? [])
    .map(({ elementTag, notes }) => ({ elementTag, notes: scrub(notes) }));
  return CharacterArchitectInput.parse({ cast: sd.cast ?? [], segments, photoNotes });
}
