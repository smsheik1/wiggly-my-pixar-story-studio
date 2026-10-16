// Character Architect v2 input slice: the ONLY state this agent may see.
// Included: Story Director cast cards, per-segment outfit/location context, photo-derived TEXT notes.
// Excluded: dialogue + timing, storyboard, HTML deck, secrets, URLs, photo paths/bytes.
import { z } from 'zod';
import { CastCardSchema } from '../story-director/schema.mjs';
import { ASSET_KEY } from './schema.mjs';

export const CharacterArchitectInput = z.object({
  cast: z.array(CastCardSchema).min(1),
  segments: z.array(z.object({
    segmentId: z.number().int().positive(),
    title: z.string(),
    continuityLocks: z.array(z.string()),
    locations: z.array(z.string()),
    visualContext: z.array(z.string()).describe('whatWeSee per shot (wardrobe/action context only)'),
  }).strict()).min(1),
  photoNotes: z.array(z.object({ elementTag: z.string().regex(/^@[\w_]+$/), notes: z.string().min(1),
    // WIGGLY: read-only reference photo inside the workspace (virtual path, never a host path or URL).
    photoFile: z.string().regex(/^\/references\/photos\/[\w.-]+$/).optional() }).strict()).default([]),
  mode: z.enum(['master-render', 'model-sheet']).default('master-render'),
  // Approved master render per character, as a LOCAL project asset key (never a URL or photo path).
  masterRenderRef: z.record(z.string().regex(/^@[\w_]+$/), z.string().regex(ASSET_KEY, 'masterRenderRef must be a local asset key, not a URL or file path')).optional(),
  variationDirectives: z.object({ focusTrait: z.string().min(1).optional() }).strict().optional(),
}).strict().superRefine((d, ctx) => {
  if (d.mode !== 'model-sheet') return;
  const missing = d.cast.map((c) => c.elementTag).filter((t) => !d.masterRenderRef?.[t]);
  if (missing.length) ctx.addIssue({ code: 'custom', path: ['masterRenderRef'],
    message: `masterRenderRef is REQUIRED when generating a model-sheet (Format B)${d.masterRenderRef ? ` (missing for ${missing.join(', ')})` : ''}` });
});

const URLISH = /\b(?:https?:\/\/|file:\/\/)\S+|(?:\/Users|\/home|~)\/\S+|\b\S+\.(?:jpe?g|png|heic|webp)\b/gi;
const scrub = (s) => String(s ?? '').replace(URLISH, '[removed]');

/** Virtual workspace path for a photo reference (the bytes are copied there by the deep-agent node). */
export const photoVirtualPath = (r) => `/references/photos/${String(r.id).replace(/[^\w-]/g, '_')}${(/\.[a-z0-9]+$/i.exec(r.path ?? '')?.[0] ?? '.jpg').toLowerCase()}`;

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
  // WIGGLY: cast cards drawn from a reference photo get the photo (copied read-only into /references/photos/).
  const refs = p.inputs?.photoReferences ?? p.photoReferences ?? [];
  for (const c of sd.cast ?? []) {
    const r = c.photoRef && refs.find((x) => x.id === c.photoRef);
    if (!r) continue;
    photoNotes.push({ elementTag: c.elementTag, notes: scrub(`${r.description} Skin tone: ${r.skinTone}.${r.photoNote ? ' ' + r.photoNote : ''}`), ...(r.path ? { photoFile: photoVirtualPath(r) } : {}) });
  }
  const ca = p.characterArchitect?.options ?? {}; // options only; the CA output lives at characterArchitect.output
  const opt = {};
  for (const k of ['mode', 'masterRenderRef', 'variationDirectives']) if (ca[k] !== undefined) opt[k] = ca[k];
  return CharacterArchitectInput.parse({ cast: sd.cast ?? [], segments, photoNotes, ...opt });
}
