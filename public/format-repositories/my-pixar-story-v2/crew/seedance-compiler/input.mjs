// Seedance Compiler v2 input slice: the ONLY state this agent may see.
// Included: approved stage play (cast cards, segments, shots, dialogue), approved character refs (@Image N -> asset key,
// main outfit text), approved location plates (@Loc N -> asset key, scene ids, lighting).
// Excluded: photos, photo notes, raw image prompts, storyboard, HTML deck, secrets, URLs, file paths.
import { z } from 'zod';
import { CastCardSchema, DialogueLineSchema, NarrationLineSchema } from '../story-director/schema.mjs';
import { ASSET_KEY } from '../character-architect/schema.mjs';
import { VIDEO_ENGINES, ENGINE_IDS, VIDEO_ENGINE } from './schema.mjs';

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
  // WIGGLY (r4-dry15): the Story Director's camera direction, passed through so [SHOTS] states framing, angle and move.
  framing: z.string().min(1).optional(),
  cameraAngle: z.string().min(1).optional(),
  cameraMove: z.string().min(1).optional(),
  whatWeSee: z.string().min(10),
  whatWeHear: z.string().optional(),
  directorsNote: z.string().optional(),
  tag: z.string().optional(),
  isContinuousMove: z.boolean().default(false),
  // WIGGLY shot locks: exactly who is in frame (restated per shot as "On screen:"), and entrances / exits.
  onScreen: z.array(z.string().regex(/^@[\w_]+$/)).optional(),
  enters: z.array(z.string().regex(/^@[\w_]+$/)).optional(),
  exits: z.array(z.string().regex(/^@[\w_]+$/)).optional(),
  dialogue: DialogueLineSchema.optional(), // the Story Director's source field is dropped here (not needed downstream)
  narration: NarrationLineSchema.optional(),
}).strict().refine((s) => s.endSec > s.startSec, { message: 'endSec must be > startSec', path: ['endSec'] });

export const SeedanceCompilerInput = z.object({
  cast: z.array(CastCardSchema).min(1),
  segments: z.array(z.object({
    segmentId: z.number().int().positive(),
    title: z.string(),
    targetDurationSec: z.number().int().min(1).max(30),
    goalSummary: z.string().min(10),
    continuityLocks: z.array(z.string()).min(1),
    // WIGGLY (r4-dry15): who is seen in this part vs only heard (voiceover / off camera). Voice-only cast gets no image reference.
    onScreenCast: z.array(z.string().regex(/^@[\w_]+$/)).default([]),
    voiceOnlyCast: z.array(z.string().regex(/^@[\w_]+$/)).default([]),
    // WIGGLY shot locks: per scene, who is present and each prop's one state (repeated word for word in every shot of the scene).
    scenes: z.array(z.object({ shots: z.array(z.number().int().positive()).min(1), present: z.array(z.string()).default([]), props: z.array(z.string()).default([]) }).strict()).default([]),
    shots: z.array(InputShotSchema).min(1),
  }).strict()).min(1),
  characters: z.array(z.object({
    elementTag: z.string().regex(/^@[\w_]+$/),
    imageTag: z.string().regex(/^@Image \d+$/),
    assetKey: KEY,
    mainOutfit: z.string().optional(),
    visualTell: z.string().optional(), // WIGGLY: the Character Architect's distinct tell, part of the per-shot Look lock
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
  // WIGGLY: the video engine these prompts are for, its clip cap and the clip lengths it offers (null = any whole second).
  targetEngine: z.enum(ENGINE_IDS).default(VIDEO_ENGINE),
  segmentMaxSec: z.number().int().positive().max(30).optional(),
  allowedDurationsSec: z.array(z.number().int().positive()).nullable().optional(),
  promptMaxChars: z.number().int().positive().optional().describe('longest compiledPrompt the engine accepts'),
  postNarration: z.boolean().optional().describe('true: narration / voiceover / off-camera lines are added in post; never put their words in the prompt'),
}).strict().transform((d) => ({ ...d, ...(d.promptMaxChars ?? VIDEO_ENGINES[d.targetEngine].promptMaxChars ? { promptMaxChars: d.promptMaxChars ?? VIDEO_ENGINES[d.targetEngine].promptMaxChars } : {}), postNarration: d.postNarration ?? !!VIDEO_ENGINES[d.targetEngine].postNarration, segmentMaxSec: d.segmentMaxSec ?? VIDEO_ENGINES[d.targetEngine].segmentMaxSec,
  allowedDurationsSec: d.allowedDurationsSec !== undefined ? d.allowedDurationsSec : (VIDEO_ENGINES[d.targetEngine].durations ? [...VIDEO_ENGINES[d.targetEngine].durations] : null) })).superRefine((d, ctx) => {
  d.segments.forEach((seg, i) => {
    let t = 0;
    for (const s of seg.shots) {
      if (s.startSec !== t) ctx.addIssue({ code: 'custom', path: ['segments', i, 'shots'], message: `timecodes must be contiguous (shot ${s.shotNumber})` });
      t = s.endSec;
    }
    if (t > 30) ctx.addIssue({ code: 'custom', path: ['segments', i], message: 'segment shots exceed 30s' });
  });
});

const heardOnlyLine = (d) => !!(d?.isVoiceover || d?.isOffCamera || /^(voiceover|off[- _]?camera)$/i.test(d?.mode ?? ''));
/**
 * Cast presence for one stage-play segment. On screen: tagged in a shot's whatWeSee, or speaks on camera.
 * Voice only: speaks only as narration / voiceover / off camera and is never on screen in this segment.
 */
export function segmentCastPresence(seg, castTags) {
  const known = new Set(castTags ?? []);
  const onScreen = new Set(), heard = new Set();
  for (const sh of seg?.shots ?? []) {
    for (const m of String(sh.whatWeSee ?? '').matchAll(/@[\w_]+/g)) if (!known.size || known.has(m[0])) onScreen.add(m[0]);
    for (const t of sh.onScreen ?? []) if (!known.size || known.has(t)) onScreen.add(t);
    if (sh.dialogue?.speaker) (heardOnlyLine(sh.dialogue) ? heard : onScreen).add(sh.dialogue.speaker);
    if (sh.narration?.speaker) heard.add(sh.narration.speaker);
  }
  return { onScreenCast: [...onScreen], voiceOnlyCast: [...heard].filter((t) => !onScreen.has(t)) };
}

/** The Seedance Compiler's per-part slice of a stage play (no assets needed). Patch mode diffs these to find affected parts. */
export function seedanceSegmentsOf(sd = {}) {
  let current;
  const castTags = (sd.cast ?? []).map((c) => c.elementTag);
  return (sd.segments ?? []).map((seg) => ({
    segmentId: seg.segmentId, title: seg.title, targetDurationSec: seg.targetDurationSec, goalSummary: seg.goalSummary, continuityLocks: seg.continuityLocks ?? [],
    ...segmentCastPresence(seg, castTags),
    scenes: (seg.scenes ?? []).map(({ shots, present, props }) => ({ shots, present: present ?? [], props: props ?? [] })),
    shots: (seg.shots ?? []).map((sh) => {
      if (sh.location) current = sh.location;
      const o = { sceneId: `${seg.segmentId}.${sh.shotNumber}`, shotNumber: sh.shotNumber, startSec: sh.startSec, endSec: sh.endSec,
        location: current, whatWeSee: sh.whatWeSee, isContinuousMove: sh.isContinuousMove ?? false };
      for (const k of ['framing', 'cameraAngle', 'cameraMove', 'whatWeHear', 'directorsNote', 'tag', 'onScreen', 'enters', 'exits', 'dialogue', 'narration']) if (sh[k] !== undefined) o[k] = sh[k];
      return o;
    }),
  }));
}

/** Filter shared pipeline state to the Seedance Compiler slice. Throws if an approved reference is missing. */
export function selectSeedanceCompilerInput(state = {}) {
  const p = state.project ?? state;
  const sd = p.storyDirector ?? p.stagePlay ?? {};
  const ca = p.characterArchitect?.output ?? {}; // outputs only (hints/options live beside them)
  const ls = p.locationScout?.output ?? {};
  const assets = p.approvedAssets ?? {};
  const segments = seedanceSegmentsOf(sd);
  const characters = (ca.characters ?? []).map((c) => {
    const assetKey = assets[c.imageTag] ?? assets[c.elementTag] ?? c.modelSheetPrompt?.masterRenderRef;
    if (!assetKey) throw new Error(`selectSeedanceCompilerInput: no approved reference asset for ${c.elementTag} (${c.imageTag})`);
    const o = { elementTag: c.elementTag, imageTag: c.imageTag, assetKey };
    const main = (c.outfits ?? []).find((x) => x.isMain);
    if (main) o.mainOutfit = main.description;
    if (c.visualTell) o.visualTell = c.visualTell;
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
  const targetEngine = p.videoEngine ?? state.videoEngine ?? VIDEO_ENGINE;
  return SeedanceCompilerInput.parse({ cast: sd.cast ?? [], segments, characters, locations, references, voiceRegistry, videoSettings: p.videoSettings ?? {}, targetEngine });
}
