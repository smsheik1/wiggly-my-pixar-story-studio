// v2 shared pipeline state: Zod shape (validation) + LangGraph Annotation (channels + reducers).
// Key layout (no ambiguity between an agent's inputs and its output):
//   inputs                         intake / questionnaire answers (Story Director slice)
//   storyDirector                  approved stage play (Story Director output)
//   characterArchitect.options     CA run options (mode, masterRenderRef, variationDirectives)
//   characterArchitect.output      CA output
//   locationScout.hints            per-setting LS hints
//   locationScout.output           LS output
//   approvedAssets                 { '@Image N' | '@Loc N' -> local asset key }, set by the human approval gate
//   storyboardArtist.output/.sheets Storyboard Artist panels + compiled sheet prompts (made by hand in Google Flow)
//   animaticApproval / approvedShotTimings  parent's animatic decision; approved timings go to the Seedance Compiler
//   seedanceCompiler.output        compiled Seedance prompts (no video generation in the graph)
import { z } from 'zod';
import { Annotation } from '@langchain/langgraph';
import { ASSET_KEY } from '../crew/character-architect/schema.mjs';

export const AGENTS = ['story-director', 'character-architect', 'location-scout', 'storyboard-artist', 'seedance-compiler', 'producer', 'assembly'];
export const STATUSES = ['running', 'done', 'awaiting-approval', 'awaiting-production', 'approved', 'escalated', 'failed'];

const Issue = z.object({ severity: z.string().default('error'), code: z.string(), message: z.string().default(''), path: z.string().optional() }).passthrough();
export const EscalationSchema = z.object({ agent: z.string(), reason: z.string(), attempts: z.number().int(), issues: z.array(Issue) });

export const ValidationErrorSchema = z.object({ node: z.string(), attempt: z.number().int().positive(), errors: z.array(Issue), timestamp: z.string() });

export const HeroPropSchema = z.object({
  propTag: z.string(),
  elementTag: z.string(),
  name: z.string(),
  description: z.string(),
  assetKey: z.string(),
  occurrences: z.number().optional()
});

export const PipelineStateSchema = z.object({
  inputs: z.object({ subject: z.string().optional(), answers: z.record(z.string(), z.unknown()) }).passthrough(),
  castDescriptions: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })).default([]),
  format: z.record(z.string(), z.unknown()).default({}),
  storyDirector: z.unknown().optional(),
  heroProps: z.array(HeroPropSchema).default([]),
  characterArchitect: z.object({ options: z.record(z.string(), z.unknown()).optional(), output: z.unknown().optional() }).default({}),
  locationScout: z.object({ hints: z.record(z.string(), z.unknown()).optional(), output: z.unknown().optional() }).default({}),
  approvedAssets: z.record(z.string().regex(/^@(?:Image|Loc|Prop) \d+$/), z.string().regex(ASSET_KEY)).optional(),
  seedanceCompiler: z.object({ output: z.unknown().optional() }).default({}),
  storyboardArtist: z.object({ output: z.unknown().optional(), sheets: z.unknown().optional() }).default({}),
  // parent decision on the animatic: { decision: 'approve' } | { decision: 'reject', target: 'story-director'|'storyboard-artist', notes }
  animaticApproval: z.object({ decision: z.enum(['approve', 'reject']), target: z.enum(['story-director', 'storyboard-artist']).optional(), notes: z.string().optional(), shotTimings: z.array(z.object({ shotId: z.string(), startSec: z.number(), endSec: z.number(), durationSec: z.number() }).passthrough()).optional(), panels: z.record(z.string(), z.string().regex(ASSET_KEY)).optional() }).nullable().optional(),
  approvedShotTimings: z.array(z.object({ shotId: z.string(), startSec: z.number(), endSec: z.number(), durationSec: z.number() }).passthrough()).optional(),
  approvedPanels: z.record(z.string(), z.string().regex(ASSET_KEY)).optional(),
  approvedLooks: z.record(z.string(), z.string().min(10)).optional(), // element tag -> outfit as the approved sheet shows it // shotId -> approved storyboard panel key
  productionApproval: z.object({ decision: z.enum(['approve', 'reject']), notes: z.string().optional() }).nullable().optional(),
  renderedClips: z.array(z.object({ clipId: z.union([z.string(), z.number()]), videoPath: z.string(), durationSec: z.number().optional(), predictionId: z.string().optional(), costUsd: z.number().optional() }).passthrough()).default([]),
  masterVideo: z.object({ videoPath: z.string().optional(), durationSec: z.number().optional(), resolution: z.string().optional(), screeningGridPath: z.string().optional(), reportPath: z.string().optional() }).optional(),
  revisionNotes: z.record(z.string(), z.string()).default({}),
  attempts: z.record(z.string(), z.number().int()).default({}),
  gateIssues: z.record(z.string(), z.array(Issue)).default({}),
  escalations: z.array(EscalationSchema).default([]),
  retryCounts: z.record(z.string(), z.number().int().nonnegative()).default({}),
  validationErrors: z.array(ValidationErrorSchema).default([]),
  reflections: z.record(z.string(), z.array(z.unknown())).default({}), // { agent: [{ attempt, rounds, log: [{ round, critique, ... }] }] }
  status: z.enum(STATUSES).default('running'),
  pendingApproval: z.array(z.string()).default([]),
});

/** Validate an initial state (throws ZodError). */
export const parseInitialState = (s) => PipelineStateSchema.parse(s);

const replace = (a, b) => (b === undefined ? a : b);
const mergeObj = (a = {}, b = {}) => ({ ...a, ...b });
const mergeSlot = (a = {}, b = {}) => ({ ...a, ...b }); // e.g. {options} + {output}
// failed > escalated > awaiting-approval > done > running: once a branch fails, no sibling or later node can clear it.
const RANK = { running: 0, done: 1, 'awaiting-approval': 2, 'awaiting-production': 2, escalated: 3, failed: 4 };
export const statusReducer = (a = 'running', b) => (b === undefined ? a : (RANK[b] >= RANK[a] ? b : a));

export const PipelineAnnotation = Annotation.Root({
  inputs: Annotation({ reducer: replace, default: () => ({ answers: {} }) }),
  castDescriptions: Annotation({ reducer: replace, default: () => [] }),
  format: Annotation({ reducer: replace, default: () => ({}) }),
  storyDirector: Annotation({ reducer: replace, default: () => undefined }),
  heroProps: Annotation({ reducer: replace, default: () => [] }),
  characterArchitect: Annotation({ reducer: mergeSlot, default: () => ({}) }),
  locationScout: Annotation({ reducer: mergeSlot, default: () => ({}) }),
  approvedAssets: Annotation({ reducer: replace, default: () => undefined }),
  seedanceCompiler: Annotation({ reducer: mergeSlot, default: () => ({}) }),
  storyboardArtist: Annotation({ reducer: mergeSlot, default: () => ({}) }),
  animaticApproval: Annotation({ reducer: replace, default: () => undefined }),
  approvedShotTimings: Annotation({ reducer: replace, default: () => undefined }),
  approvedPanels: Annotation({ reducer: replace, default: () => undefined }),
  approvedLooks: Annotation({ reducer: replace, default: () => undefined }),
  productionApproval: Annotation({ reducer: replace, default: () => undefined }),
  renderedClips: Annotation({ reducer: (a = [], b = []) => [...a, ...b], default: () => [] }),
  masterVideo: Annotation({ reducer: replace, default: () => undefined }),
  revisionNotes: Annotation({ reducer: mergeObj, default: () => ({}) }),
  attempts: Annotation({ reducer: mergeObj, default: () => ({}) }),
  gateIssues: Annotation({ reducer: mergeObj, default: () => ({}) }),
  escalations: Annotation({ reducer: (a = [], b = []) => [...a, ...b], default: () => [] }),
  retryCounts: Annotation({ reducer: mergeObj, default: () => ({}) }),
  validationErrors: Annotation({ reducer: (a = [], b = []) => [...a, ...b], default: () => [] }), // append-only log
  reflections: Annotation({ reducer: mergeObj, default: () => ({}) }), // per-agent self-critique log (reviewable)
  status: Annotation({ reducer: statusReducer, default: () => 'running' }),
  pendingApproval: Annotation({ reducer: replace, default: () => [] }),
});
