// Storyboard Artist input slice: shot list with timecodes and lines (SD), approved characters (CA) and location plates (LS).
// Excluded: questionnaire answers, photos, URLs, secrets, the SD's own HTML deck.
import { z } from 'zod';
import { SHOT_ID } from './schema.mjs';

const URLISH = /\b(?:https?:\/\/|file:\/\/)\S+|(?:\/Users|\/home|~)\/\S+|\b\S+\.(?:jpe?g|png|heic|webp)\b/gi;
const scrub = (s) => String(s ?? '').replace(URLISH, '[removed]');

export const SbShot = z.object({
  shotId: z.string().regex(SHOT_ID), segmentId: z.number().int(), shotNumber: z.number().int(),
  startSec: z.number(), endSec: z.number(), durationSec: z.number().positive(),
  location: z.string(), locationTag: z.string().nullable(),
  framing: z.string().optional(), cameraAngle: z.string().optional(), cameraMove: z.string().optional(),
  whatWeSee: z.string(), onScreen: z.array(z.string()).default([]),
  line: z.object({ speaker: z.string(), text: z.string(), kind: z.enum(['dialogue', 'narration']) }).nullable(),
}).strict();
export const SbCharacter = z.object({
  tag: z.string(), imageTag: z.string(), name: z.string(), age: z.number().optional(), gender: z.string().optional(), skinTone: z.string().optional(),
  outfits: z.array(z.object({ segmentIds: z.array(z.number().int()), description: z.string() }).passthrough()).default([]),
  visualTell: z.string().optional(), masterRenderPrompt: z.string().optional(),
}).strict();
export const SbLocation = z.object({ tag: z.string(), settingName: z.string(), sceneIds: z.array(z.string()), timeOfDay: z.string().optional(), lighting: z.string().optional(), platePrompt: z.string().optional() }).strict();
export const StoryboardArtistInput = z.object({ shots: z.array(SbShot).min(1), characters: z.array(SbCharacter).min(1), locations: z.array(SbLocation).min(1) }).strict();

/** The character's outfit for a part (the outfit listing that part, else the main one). */
export function outfitFor(c, segmentId) {
  const o = (c.outfits ?? []).find((x) => (x.segmentIds ?? []).includes(segmentId)) ?? (c.outfits ?? []).find((x) => x.isMain) ?? c.outfits?.[0];
  return o?.description ?? '';
}

export function selectStoryboardArtistInput(state = {}) {
  const sd = state.storyDirector ?? {};
  const chars = state.characterArchitect?.output?.characters ?? [];
  const locs = state.locationScout?.output?.locations ?? [];
  const locOf = (id) => locs.find((l) => (l.sceneIds ?? []).includes(id))?.elementTag ?? null;
  const shots = []; let current;
  for (const seg of sd.segments ?? []) for (const sh of seg.shots ?? []) {
    if (sh.location) current = sh.location;
    const shotId = `${seg.segmentId}.${sh.shotNumber}`;
    const l = sh.dialogue ?? sh.narration;
    shots.push({ shotId, segmentId: seg.segmentId, shotNumber: sh.shotNumber, startSec: sh.startSec, endSec: sh.endSec, durationSec: sh.endSec - sh.startSec,
      location: current ?? '', locationTag: locOf(shotId), framing: sh.framing, cameraAngle: sh.cameraAngle, cameraMove: sh.cameraMove,
      whatWeSee: scrub(sh.whatWeSee), onScreen: sh.onScreen ?? [],
      line: l?.line ? { speaker: l.speaker, text: String(l.line).replace(/^\{|\}$/g, ''), kind: sh.dialogue ? 'dialogue' : 'narration' } : null });
  }
  const characters = chars.map((c) => ({ tag: c.elementTag, imageTag: c.imageTag, name: c.name, age: c.age, gender: c.gender, skinTone: c.skinTone,
    outfits: (c.outfits ?? []).map((o) => ({ segmentIds: o.segmentIds ?? [], description: o.description, ...(o.isMain ? { isMain: true } : {}) })),
    ...(c.visualTell ? { visualTell: c.visualTell } : {}), ...(c.masterRenderPrompt?.promptText ? { masterRenderPrompt: scrub(c.masterRenderPrompt.promptText) } : {}) }));
  const locations = locs.map((l) => ({ tag: l.elementTag, settingName: l.settingName ?? l.name, sceneIds: l.sceneIds ?? [],
    ...(l.timeOfDay ? { timeOfDay: String(l.timeOfDay) } : {}), ...(l.lightingAnchor ? { lighting: typeof l.lightingAnchor === 'string' ? l.lightingAnchor : JSON.stringify(l.lightingAnchor) } : {}),
    ...(l.locationPlatePrompt?.promptText ? { platePrompt: scrub(l.locationPlatePrompt.promptText) } : {}) }));
  return StoryboardArtistInput.parse({ shots, characters, locations });
}
