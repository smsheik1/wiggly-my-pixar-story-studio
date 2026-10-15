// Seedance Compiler v2 input slice: the ONLY state this agent may see.
// Included: approved stage play (cast cards, segments, shots, dialogue), approved character refs (@Image N -> asset key,
// main outfit text), approved location plates (@Loc N -> asset key, scene ids, lighting).
// Excluded: photos, photo notes, raw image prompts, storyboard, HTML deck, secrets, URLs, file paths.
import { z } from 'zod';
import { CastCardSchema, DialogueSchema, NarrationSchema } from '../story-director/schema.mjs';
import { ASSET_KEY } from '../character-architect/schema.mjs';

const KEY = z.string().regex(ASSET_KEY, 'asset key must be a local asset key, not a URL or file path');

// From Gemini's input contract (no URLs: asset keys only).
export const ReferenceElement = z.object({
  tag: z.string().regex(/^@[\w_]+$/),
  type: z.enum(['character', 'location', 'prop', 'staging']),
  plainEnglishDescription: z.string().min(10),
  sourceTag: z.string().regex(/^@(?:Image|Loc) \d+$/).optional(),
  assetKey: KEY,
}).strict();
export const VoiceRegistryEntry = z.object({
  speakerTag: z.string().regex(/^@[\w_]+$/),
  verbatimVoicePrompt: z.string().min(20).describe('Age, timbre, pace, delivery; identical across segments'),
  audioReference: KEY.optional(),
}).strict();
export const VideoSettings = z.object({
  resolution: z.literal('480p').default('480p'),
  frameRate: z.union([z.literal(24), z.literal(30)]).default(24),
  aspectRatio: z.literal('16:9').default('16:9'),
}).strict();

export const InputShotSchema = z.object({
  sceneId: z.string().regex(/^\d+\.\d+$/),
  shotNumber: z.number().int().positive(),
  startSec: z.number().int().nonnegative(),
  endSec: z.number().int().positive(),
  location: z.string().min(1),
  whatWeSee: z.string().min(10),
  whatWeHear: z.string().optional(),
  directorsNote: z.string().optional(),
  tag: z.string().optional(),
  isContinuousMove: z.boolean().default(false),
  dialogue: DialogueSchema.optional(),
  narration: NarrationSchema.optional(),
}).strict().refine((s) => s.endSec > s.startSec, { message: 'endSec must be > startSec', path: ['endSec'] });

export const SeedanceCompilerInput = z.object({
  cast: z.array(CastCardSchema).min(1),
  segments: z.array(z.object({
    segmentId: z.number().int().positive(),
    title: z.string(),
    targetDurationSec: z.number().int().min(1).max(30),
    goalSummary: z.string().min(10),
    continuityLocks: z.array(z.string()).min(1),
    shots: z.array(InputShotSchema).min(1),
  }).strict()).min(1),
  characters: z.array(z.object({
    elementTag: z.string().regex(/^@[\w_]+$/),
    imageTag: z.string().regex(/^@Image \d+$/),
    assetKey: KEY,
    mainOutfit: z.string().optional(),
  }).strict()).min(1),
  locations: z.array(z.object({
    settingName: z.string().min(1),
    elementTag: z.string().regex(/^@Loc \d+$/),
    elementName: z.string().regex(/^@[\w_]+$/).describe('Element-name tag used in the Seedance prompt, e.g. @kitchen'),
    assetKey: KEY,
    sceneIds: z.array(z.string()).min(1),
    lighting: z.string().optional(),
  }).strict()).min(1),
  // Gemini additions
  references: z.array(ReferenceElement).min(1),
  voiceRegistry: z.array(VoiceRegistryEntry).default([]),
  videoSettings: VideoSettings.prefault({}),
}).strict().superRefine((d, ctx) => {
  d.segments.forEach((seg, i) => {
    let t = 0;
    for (const s of seg.shots) {
      if (s.startSec !== t) ctx.addIssue({ code: 'custom', path: ['segments', i, 'shots'], message: `timecodes must be contiguous (shot ${s.shotNumber})` });
      t = s.endSec;
    }
    if (t > 30) ctx.addIssue({ code: 'custom', path: ['segments', i], message: 'segment shots exceed 30s' });
  });
});

/** Filter shared pipeline state to the Seedance Compiler slice. Throws if an approved reference is missing. */
export function selectSeedanceCompilerInput(state = {}) {
  const p = state.project ?? state;
  const sd = p.storyDirector ?? p.stagePlay ?? {};
  const ca = p.characterArchitect?.output ?? p.characterArchitect ?? {};
  const ls = p.locationScout?.output ?? p.locationScout ?? {};
  const assets = p.approvedAssets ?? {};
  let current;
  const segments = (sd.segments ?? []).map((seg) => ({
    segmentId: seg.segmentId, title: seg.title, targetDurationSec: seg.targetDurationSec, goalSummary: seg.goalSummary, continuityLocks: seg.continuityLocks ?? [],
    shots: (seg.shots ?? []).map((sh) => {
      if (sh.location) current = sh.location;
      const o = { sceneId: `${seg.segmentId}.${sh.shotNumber}`, shotNumber: sh.shotNumber, startSec: sh.startSec, endSec: sh.endSec,
        location: current, whatWeSee: sh.whatWeSee, isContinuousMove: sh.isContinuousMove ?? false };
      for (const k of ['whatWeHear', 'directorsNote', 'tag', 'dialogue', 'narration']) if (sh[k] !== undefined) o[k] = sh[k];
      return o;
    }),
  }));
  const characters = (ca.characters ?? []).map((c) => {
    const assetKey = assets[c.imageTag] ?? assets[c.elementTag] ?? c.modelSheetPrompt?.masterRenderRef;
    if (!assetKey) throw new Error(`selectSeedanceCompilerInput: no approved reference asset for ${c.elementTag} (${c.imageTag})`);
    const o = { elementTag: c.elementTag, imageTag: c.imageTag, assetKey };
    const main = (c.outfits ?? []).find((x) => x.isMain);
    if (main) o.mainOutfit = main.description;
    return o;
  });
  const locations = (ls.locations ?? []).map((l) => {
    const assetKey = assets[l.elementTag] ?? assets[l.locationId];
    if (!assetKey) throw new Error(`selectSeedanceCompilerInput: no approved plate asset for ${l.settingName} (${l.elementTag})`);
    const o = { settingName: l.settingName, elementTag: l.elementTag, elementName: '@' + l.locationId.replaceAll('-', '_'), assetKey, sceneIds: l.sceneIds };
    if (l.lightingAnchor) o.lighting = `${l.lightingAnchor.sourceDescription}, ${l.lightingAnchor.keyLightDirection}; ${l.lightingAnchor.shadowCharacteristics}`;
    return o;
  });
  const castByTag = new Map((sd.cast ?? []).map((c) => [c.elementTag, c]));
  const references = [
    ...characters.map((c) => ({ tag: c.elementTag, type: 'character', sourceTag: c.imageTag, assetKey: c.assetKey,
      plainEnglishDescription: castByTag.get(c.elementTag)?.physicalDescription ?? c.mainOutfit ?? `${c.elementTag} character reference` })),
    ...locations.map((l) => ({ tag: l.elementName, type: 'location', sourceTag: l.elementTag, assetKey: l.assetKey,
      plainEnglishDescription: `Empty ${l.settingName} plate${l.lighting ? `, ${l.lighting}` : ''}` })),
  ];
  const audio = p.voiceAudioRefs ?? {};
  const voiceRegistry = (sd.cast ?? []).map((c) => ({ speakerTag: c.elementTag, verbatimVoicePrompt: c.voiceDescription, ...(audio[c.elementTag] ? { audioReference: audio[c.elementTag] } : {}) }));
  return SeedanceCompilerInput.parse({ cast: sd.cast ?? [], segments, characters, locations, references, voiceRegistry, videoSettings: p.videoSettings ?? {} });
}
