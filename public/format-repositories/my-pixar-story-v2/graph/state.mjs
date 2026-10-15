// v2 shared pipeline state: Zod shape (validation) + LangGraph Annotation (channels + reducers).
// Key layout (no ambiguity between an agent's inputs and its output):
//   inputs                         intake / questionnaire answers (Story Director slice)
//   storyDirector                  approved stage play (Story Director output)
//   characterArchitect.options     CA run options (mode, masterRenderRef, variationDirectives)
//   characterArchitect.output      CA output
//   locationScout.hints            per-setting LS hints
//   locationScout.output           LS output
//   approvedAssets                 { '@Image N' | '@Loc N' -> local asset key }, set by the human approval gate
//   seedanceCompiler.output        compiled Seedance prompts (no video generation in the graph)
import { z } from 'zod';
import { Annotation } from '@langchain/langgraph';
import { ASSET_KEY } from '../crew/character-architect/schema.mjs';

export const AGENTS = ['story-director', 'character-architect', 'location-scout', 'seedance-compiler'];
export const STATUSES = ['running', 'awaiting-approval', 'escalated', 'done'];

const Issue = z.object({ severity: z.string(), code: z.string(), message: z.string(), path: z.string().optional() }).passthrough();
export const EscalationSchema = z.object({ agent: z.string(), reason: z.string(), attempts: z.number().int(), issues: z.array(Issue) });

export const PipelineStateSchema = z.object({
  inputs: z.object({ subject: z.string().optional(), answers: z.record(z.string(), z.unknown()) }).passthrough(),
  castDescriptions: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })).default([]),
  format: z.record(z.string(), z.unknown()).default({}),
  storyDirector: z.unknown().optional(),
  characterArchitect: z.object({ options: z.record(z.string(), z.unknown()).optional(), output: z.unknown().optional() }).default({}),
  locationScout: z.object({ hints: z.record(z.string(), z.unknown()).optional(), output: z.unknown().optional() }).default({}),
  approvedAssets: z.record(z.string().regex(/^@(?:Image|Loc) \d+$/), z.string().regex(ASSET_KEY)).optional(),
  seedanceCompiler: z.object({ output: z.unknown().optional() }).default({}),
  attempts: z.record(z.string(), z.number().int()).default({}),
  gateIssues: z.record(z.string(), z.array(Issue)).default({}),
  escalations: z.array(EscalationSchema).default([]),
  status: z.enum(STATUSES).default('running'),
  pendingApproval: z.array(z.string()).default([]),
});

/** Validate an initial state (throws ZodError). */
export const parseInitialState = (s) => PipelineStateSchema.parse(s);

const replace = (a, b) => (b === undefined ? a : b);
const mergeObj = (a = {}, b = {}) => ({ ...a, ...b });
const mergeSlot = (a = {}, b = {}) => ({ ...a, ...b }); // e.g. {options} + {output}
// escalated > awaiting-approval > done > running: a parallel branch that escalates is never overwritten by its sibling.
const RANK = { running: 0, done: 1, 'awaiting-approval': 2, escalated: 3 };
export const statusReducer = (a = 'running', b) => (b === undefined ? a : (b === 'running' && a !== 'escalated') ? b : (RANK[b] >= RANK[a] ? b : a));

export const PipelineAnnotation = Annotation.Root({
  inputs: Annotation({ reducer: replace, default: () => ({ answers: {} }) }),
  castDescriptions: Annotation({ reducer: replace, default: () => [] }),
  format: Annotation({ reducer: replace, default: () => ({}) }),
  storyDirector: Annotation({ reducer: replace, default: () => undefined }),
  characterArchitect: Annotation({ reducer: mergeSlot, default: () => ({}) }),
  locationScout: Annotation({ reducer: mergeSlot, default: () => ({}) }),
  approvedAssets: Annotation({ reducer: replace, default: () => undefined }),
  seedanceCompiler: Annotation({ reducer: mergeSlot, default: () => ({}) }),
  attempts: Annotation({ reducer: mergeObj, default: () => ({}) }),
  gateIssues: Annotation({ reducer: mergeObj, default: () => ({}) }),
  escalations: Annotation({ reducer: (a = [], b = []) => [...a, ...b], default: () => [] }),
  status: Annotation({ reducer: statusReducer, default: () => 'running' }),
  pendingApproval: Annotation({ reducer: replace, default: () => [] }),
});
