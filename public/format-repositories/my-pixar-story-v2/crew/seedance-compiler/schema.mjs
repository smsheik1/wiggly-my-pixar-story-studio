// Seedance Compiler v2 output contract (Zod, plain JS). Mirrors the other v2 crew contracts.
import { z } from 'zod';
import { ASSET_KEY } from '../character-architect/schema.mjs';

export const VIDEO_ENGINE = 'seedance-2.5';
export const VIDEO_RESOLUTION = '480p';
export const MAX_SEGMENT_SECONDS = 30;
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
  engine: z.literal(VIDEO_ENGINE).default(VIDEO_ENGINE),
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
}).strict();

export const SeedanceSegmentSchema = SeedanceSegmentBase.superRefine((seg, ctx) => {
  const pos = headerPositions(seg.compiledPrompt);
  pos.forEach((p, i) => { if (p < 0) ctx.addIssue({ code: 'custom', path: ['compiledPrompt'], message: `missing block header ${BLOCK_HEADERS[i]}` }); });
  const present = pos.filter((p) => p >= 0);
  if (present.some((p, i) => i > 0 && p < present[i - 1])) ctx.addIssue({ code: 'custom', path: ['compiledPrompt'], message: 'block headers must appear in sequential order' });
  if (seg.generationPayload.durationSec !== seg.totalDurationSec)
    ctx.addIssue({ code: 'custom', path: ['generationPayload', 'durationSec'], message: `generationPayload.durationSec (${seg.generationPayload.durationSec}) must equal totalDurationSec (${seg.totalDurationSec})` });
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
    if (s.dialogue && !castTags.has(s.dialogue.speaker))
      ctx.addIssue({ code: 'custom', path: ['shots', i, 'dialogue', 'speaker'], message: `speaker ${s.dialogue.speaker} is not a bound cast reference` });
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
