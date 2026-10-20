// Seedance Compiler v2 output contract (Zod, plain JS). Mirrors the other v2 crew contracts.
import { z } from 'zod';
import { ASSET_KEY } from '../character-architect/schema.mjs';

export const VIDEO_ENGINE = 'seedance-2.5';
export const VIDEO_RESOLUTION = '480p';
export const MAX_SEGMENT_SECONDS = 30;
// WIGGLY: target video engines. segmentMaxSec = longest clip the engine renders; durations = the clip lengths it offers
// (null = any whole second up to the cap). A staged part longer than the cap is split into clips at shot boundaries.
export const VIDEO_ENGINES = Object.freeze({
  'seedance-2.5': Object.freeze({ provider: 'replicate', segmentMaxSec: 30, durations: null, continuation: 'extend' }),
  // Replicate bytedance/seedance-2.0-mini (checked 2026-10-20): duration 4-15s any whole second, prompt max 4000 chars, up to 9 reference images.
  // Replicate caps the mini prompt at 4000 chars; 150 are reserved for the [ImageN] / [AudioN] tags added at send time.
  'seedance-2.0-mini': Object.freeze({ provider: 'replicate', model: 'bytedance/seedance-2.0-mini', segmentMaxSec: 15, durations: null, promptMaxChars: 3850, continuation: 'cut' }),
  'omni-1.1-flash': Object.freeze({ provider: 'google-flow', segmentMaxSec: 10, durations: Object.freeze([4, 6, 8, 10]), continuation: 'cut', postNarration: true /* narration is TTS laid in post; Omni voices any words it is given */ }),
});
export const ENGINE_IDS = Object.keys(VIDEO_ENGINES);
/** generationPayload.durationSec for a clip: the smallest duration the engine offers that is >= the clip's true length. */
export function engineDurationFor(engine, lenSec) {
  const e = VIDEO_ENGINES[engine];
  if (!e) return undefined;
  if (!e.durations) return lenSec <= e.segmentMaxSec ? lenSec : undefined;
  return e.durations.find((d) => d >= lenSec);
}
export const MAX_TOTAL_SECONDS = 180;
export const REF_TAG = /^@(?:Image|Loc) \d+$/;
export const SLOT_TAG = /^@(?:Image|Loc)\b/i;
const ELEMENT = /^@[\w_]+$/;

export const ReferenceSchema = z.object({
  tag: z.string().regex(ELEMENT, "tag is an element name like '@Theo' or '@kitchen'").refine((t) => !SLOT_TAG.test(t), 'use element names, never @Image N / @Loc N slots'),
  kind: z.enum(['character', 'location', 'prop', 'staging']),
  sourceTag: z.string().regex(REF_TAG).optional().describe('Upstream slot: @Image N (Character Architect) or @Loc N (Location Scout)'),
  assetKey: z.string().regex(ASSET_KEY, 'assetKey must be a local asset key, not a URL or file path').refine((s) => !/^https?:|\//.test(s), 'assetKey must not be a URL or path'),
}).strict()
  .refine((r) => !r.sourceTag || (r.kind === 'character') === r.sourceTag.startsWith('@Image '), { message: 'character refs come from @Image N, location refs from @Loc N', path: ['sourceTag'] });

export const ShotDialogueSchema = z.object({
  speaker: z.string().regex(ELEMENT),
  line: z.string().regex(/^\{.+\}$/, 'line must be enclosed in {}'),
  mode: z.enum(['on-camera', 'off-camera', 'voiceover']).default('on-camera'),
}).strict();

export const CompiledShotSchema = z.object({
  shotNumber: z.number().int().positive(),
  startSec: z.number().int().nonnegative(),
  endSec: z.number().int().positive(),
  sceneId: z.string().regex(/^\d+\.\d+$/),
  locationTag: z.string().regex(ELEMENT),
  cast: z.array(z.string().regex(ELEMENT)).default([]),
  action: z.string().min(10),
  dialogue: ShotDialogueSchema.optional(),
  sfx: z.array(z.string()).default([]),
  cut: z.literal('Hard cut.').default('Hard cut.'),
}).strict().refine((s) => s.endSec > s.startSec, { message: 'endSec must be > startSec', path: ['endSec'] });

// BASE: Gemini's per-segment object (gemini-sc-schema.md). Wiggly additions marked "WIGGLY".
export const BLOCK_HEADERS = ['[REFERENCE MATERIALS]', '[VOICES]', '[GOAL]', '[CONTINUITY]', '[SHOTS]', '[VISUAL STYLE]', '[CAMERA AND PERFORMANCE]', '[AUDIO]', '[EXCLUSIONS]', '[MAINTAIN CONSISTENCY]'];
export const BLOCK_KEYS = ['block1_referenceMaterials', 'block2_voices', 'block3_goal', 'block4_continuity', 'block5_shots', 'block6_visualStyle', 'block7_cameraAndPerformance', 'block8_audio', 'block9_exclusions', 'block10_maintainConsistency'];

export const TenBlocksSchema = z.object({
  block1_referenceMaterials: z.string().min(20),
  block2_voices: z.string().min(20),
  block3_goal: z.string().min(20),
  block4_continuity: z.string().min(20),
  block5_shots: z.string().min(50),
  block6_visualStyle: z.string().min(20),
  block7_cameraAndPerformance: z.string().min(20),
  block8_audio: z.string().min(10).refine((a) => !/[{}]/.test(a), 'block8_audio must contain zero dialogue (no { or })'),
  block9_exclusions: z.string().min(20),
  block10_maintainConsistency: z.string().min(20),
}).strict();

export const GenerationPayloadSchema = z.object({
  engine: z.enum(ENGINE_IDS).default(VIDEO_ENGINE),
  durationSec: z.number().int().min(1).max(MAX_SEGMENT_SECONDS),
  resolution: z.literal(VIDEO_RESOLUTION).default(VIDEO_RESOLUTION), // WIGGLY: 480p only
  aspectRatio: z.literal('16:9').default('16:9'),
  fps: z.number().int().default(24),
}).strict();

/** Ordered position of each header in a compiled prompt (-1 if missing). */
export const headerPositions = (text) => BLOCK_HEADERS.map((h) => text.indexOf(h));

export const SeedanceSegmentBase = z.object({
  segmentId: z.number().int().positive().describe('Stage-play segment id'),
  title: z.string().min(3),
  totalDurationSec: z.number().int().min(1).max(MAX_SEGMENT_SECONDS),
  shotCount: z.number().int().positive(),
  attachedElements: z.array(z.string().regex(ELEMENT)).min(1),
  tenBlocks: TenBlocksSchema,
  compiledPrompt: z.string().min(500),
  generationPayload: GenerationPayloadSchema,
  // WIGGLY
  segmentIndex: z.number().int().positive(),
  // Absent = first segment (null). Muse omitted it on segment 1 in r4-dry5; the chain refine still enforces 2+.
  extendsFrom: z.number().int().positive().nullable().default(null).describe('null for the first segment; otherwise the previous segmentIndex'),
  references: z.array(ReferenceSchema).min(1),
  shots: z.array(CompiledShotSchema).min(1),
  // WIGGLY clips: when a staged part is longer than the engine's clip cap it is split into consecutive clips at shot
  // boundaries. segmentId stays the source part; shots restart at 0 and keep the source sceneId.
  clipId: z.string().regex(/^\d+[a-z]$/, 'clipId is the part id plus a letter, e.g. "2a"').optional(),
  sourceShotNumbers: z.array(z.number().int().positive()).min(1).optional().describe('the staged shotNumbers this clip covers, in order'),
  sourceStartSec: z.number().int().nonnegative().default(0).describe('where this clip starts inside its staged part'),
}).strict();

export const SeedanceSegmentSchema = SeedanceSegmentBase.superRefine((seg, ctx) => {
  const pos = headerPositions(seg.compiledPrompt);
  pos.forEach((p, i) => { if (p < 0) ctx.addIssue({ code: 'custom', path: ['compiledPrompt'], message: `missing block header ${BLOCK_HEADERS[i]}` }); });
  const present = pos.filter((p) => p >= 0);
  if (present.some((p, i) => i > 0 && p < present[i - 1])) ctx.addIssue({ code: 'custom', path: ['compiledPrompt'], message: 'block headers must appear in sequential order' });
  const wantDur = engineDurationFor(seg.generationPayload.engine, seg.totalDurationSec);
  if (seg.generationPayload.durationSec !== wantDur)
    ctx.addIssue({ code: 'custom', path: ['generationPayload', 'durationSec'], message: wantDur === undefined
      ? `totalDurationSec ${seg.totalDurationSec}s is longer than ${seg.generationPayload.engine} renders (${VIDEO_ENGINES[seg.generationPayload.engine].segmentMaxSec}s): split the part into clips at shot boundaries`
      : `generationPayload.durationSec (${seg.generationPayload.durationSec}) must be ${wantDur} (${VIDEO_ENGINES[seg.generationPayload.engine].durations ? `the smallest ${seg.generationPayload.engine} duration >= the clip's ${seg.totalDurationSec}s` : `equal to totalDurationSec`})` });
  if (seg.sourceShotNumbers && seg.sourceShotNumbers.length !== seg.shots.length)
    ctx.addIssue({ code: 'custom', path: ['sourceShotNumbers'], message: `sourceShotNumbers lists ${seg.sourceShotNumbers.length} shots but the clip has ${seg.shots.length}` });
  if (seg.shotCount !== seg.shots.length) ctx.addIssue({ code: 'custom', path: ['shotCount'], message: `shotCount ${seg.shotCount} != ${seg.shots.length} shots` });
  let t = 0;
  seg.shots.forEach((s, i) => {
    if (s.shotNumber !== i + 1) ctx.addIssue({ code: 'custom', path: ['shots', i, 'shotNumber'], message: `shotNumber must be ${i + 1}` });
    if (s.startSec !== t) ctx.addIssue({ code: 'custom', path: ['shots', i, 'startSec'], message: `timecodes must be contiguous: expected startSec ${t}` });
    t = s.endSec;
  });
  if (t !== seg.totalDurationSec) ctx.addIssue({ code: 'custom', path: ['totalDurationSec'], message: `last shot ends at ${t}s but totalDurationSec is ${seg.totalDurationSec}` });
  const tags = seg.references.map((r) => r.tag);
  if (new Set(tags).size !== tags.length) ctx.addIssue({ code: 'custom', path: ['references'], message: 'duplicate reference tag' });
  for (const t2 of tags) if (!seg.attachedElements.includes(t2)) ctx.addIssue({ code: 'custom', path: ['attachedElements'], message: `reference ${t2} missing from attachedElements` });
  const castTags = new Set(seg.references.filter((r) => r.kind === 'character').map((r) => r.tag));
  const locTags = new Set(seg.references.filter((r) => r.kind === 'location').map((r) => r.tag));
  seg.shots.forEach((s, i) => {
    // Voice-over / off-camera speakers are heard, not seen: they need no picture attached to this part (r5-dry2: the
    // narrator was rejected in a part he never appears in). The gate still checks they are in the stage-play cast.
    if (s.dialogue && s.dialogue.mode === 'on-camera' && !castTags.has(s.dialogue.speaker))
      ctx.addIssue({ code: 'custom', path: ['shots', i, 'dialogue', 'speaker'], message: `speaker ${s.dialogue.speaker} speaks on camera but is not a bound cast reference (attach their picture to this part, or mark the line mode 'voiceover' / 'off-camera')` });
    if (!locTags.has(s.locationTag)) ctx.addIssue({ code: 'custom', path: ['shots', i, 'locationTag'], message: `locationTag ${s.locationTag} is not a bound location reference` });
  });
});

/** Assemble compiledPrompt in code from the 10 ordered blocks (headers can never go missing or out of order). */
export function assembleCompiledPrompt(tenBlocks = {}) {
  return BLOCK_HEADERS.map((h, i) => `${h}\n${String(tenBlocks[BLOCK_KEYS[i]] ?? '').trim()}`).join('\n\n');
}
/** Return a copy of an output object with every segment's compiledPrompt assembled from its tenBlocks. */
export function withAssembledPrompts(obj) {
  if (!obj || !Array.isArray(obj.segments)) return obj;
  return { ...obj, segments: obj.segments.map((s) => (s && s.tenBlocks ? { ...s, compiledPrompt: assembleCompiledPrompt(s.tenBlocks) } : s)) };
}
/** Submit-tool schema: same contract, but compiledPrompt is optional (code assembles it). */
export const SeedanceSubmitSchema = z.object({
  segments: z.array(SeedanceSegmentBase.extend({ compiledPrompt: z.string().optional() })).min(1),
  totalRuntimeSec: z.number().int().positive().max(MAX_TOTAL_SECONDS),
  assumptions: z.array(z.string()).default([]),
}).strict();

export const SeedanceCompilerOutputSchema = z.object({
  segments: z.array(SeedanceSegmentSchema).min(1),
  totalRuntimeSec: z.number().int().positive().max(MAX_TOTAL_SECONDS),
  assumptions: z.array(z.string()).default([]),
}).strict().superRefine((d, ctx) => {
  d.segments.forEach((s, i) => {
    if (s.segmentIndex !== i + 1) ctx.addIssue({ code: 'custom', path: ['segments', i, 'segmentIndex'], message: `segmentIndex must be ${i + 1}` });
    const want = i === 0 ? null : i;
    if (s.extendsFrom !== want) ctx.addIssue({ code: 'custom', path: ['segments', i, 'extendsFrom'], message: `extendsFrom must be ${want} (Extend chain)` });
  });
  const total = d.segments.reduce((n, s) => n + s.totalDurationSec, 0);
  if (total !== d.totalRuntimeSec) ctx.addIssue({ code: 'custom', path: ['totalRuntimeSec'], message: `totalRuntimeSec ${d.totalRuntimeSec} != sum of segments ${total}` });
});

/**
 * WIGGLY patch mode: the compiler recompiles only the parts a Story Director patch touched. Each submitted segment keeps
 * its place in the whole film (segmentIndex / extendsFrom from positions: { segmentId: segmentIndex }); requiredIds, when
 * given, must all be present and nothing else. Code then merges these segments into the prior output (graph/patch.mjs).
 */
export function makeSeedancePatchSchema(positions = {}, requiredIds) {
  return z.object({
    segments: z.array(SeedanceSegmentSchema).min(1),
    totalRuntimeSec: z.number().int().positive().max(MAX_TOTAL_SECONDS),
    assumptions: z.array(z.string()).default([]),
  }).strict().superRefine((d, ctx) => {
    const ids = d.segments.map((s) => s.segmentId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['segments'], message: 'a part is compiled twice' });
    d.segments.forEach((s, i) => {
      const at = positions[s.segmentId];
      if (at === undefined) { ctx.addIssue({ code: 'custom', path: ['segments', i, 'segmentId'], message: `part ${s.segmentId} is not in this film` }); return; }
      if (requiredIds && !requiredIds.includes(s.segmentId)) ctx.addIssue({ code: 'custom', path: ['segments', i, 'segmentId'], message: `part ${s.segmentId} is not affected by the patch; compile only parts ${requiredIds.join(', ')}` });
      if (s.segmentIndex !== at) ctx.addIssue({ code: 'custom', path: ['segments', i, 'segmentIndex'], message: `segmentIndex must be ${at} (its place in the whole film)` });
      const want = at === 1 ? null : at - 1;
      if (s.extendsFrom !== want) ctx.addIssue({ code: 'custom', path: ['segments', i, 'extendsFrom'], message: `extendsFrom must be ${want} (Extend chain of the whole film)` });
    });
    for (const id of requiredIds ?? []) if (!ids.includes(id)) ctx.addIssue({ code: 'custom', path: ['segments'], message: `part ${id} is affected by the patch and must be compiled` });
    const total = d.segments.reduce((n, s) => n + s.totalDurationSec, 0);
    if (total !== d.totalRuntimeSec) ctx.addIssue({ code: 'custom', path: ['totalRuntimeSec'], message: `totalRuntimeSec ${d.totalRuntimeSec} != sum of the compiled parts ${total}` });
  });
}

export class SeedancePromptParseError extends Error {
  constructor(issues) {
    super('Seedance Compiler output failed the contract:\n' +
      issues.map((i) => `  - ${(i.path ?? []).join('.') || '(root)'}: ${i.message}`).join('\n'));
    this.name = 'SeedancePromptParseError';
    this.issues = issues;
  }
}

/** Parse Seedance Compiler output (object or JSON string). Throws SeedancePromptParseError. */
export function parseSeedancePrompts(input) {
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); } catch (e) { throw new SeedancePromptParseError([{ path: [], message: `not valid JSON (${e.message})` }]); }
  }
  const r = SeedanceCompilerOutputSchema.safeParse(withAssembledPrompts(obj));
  if (!r.success) throw new SeedancePromptParseError(r.error.issues);
  return r.data;
}
