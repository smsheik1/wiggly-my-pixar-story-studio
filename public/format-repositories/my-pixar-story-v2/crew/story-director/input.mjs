// Story Director v2 input slice: the ONLY state this agent may see.
import { z } from 'zod';

export const SCENE_KEYS = ['scene1Childhood', 'scene2TeenFreedom', 'scene3LeapOfFaith', 'scene4Romance', 'scene5LegacyFinale'];

export const StoryDirectorInput = z.object({
  subject: z.string().default(''),
  answers: z.record(z.string(), z.unknown()),
  castDescriptions: z.array(z.object({
    id: z.string(), name: z.string(), description: z.string(),
  })).default([]),
  format: z.object({
    maxPartSeconds: z.number().int().max(30).default(30),
    targetTotalSeconds: z.number().int().max(90).default(60),
    maxTotalSeconds: z.number().int().max(90).default(90),
    narrationAllowed: z.boolean().default(true),
    dialogueAllowed: z.boolean().default(true),
  }).default({}),
}).strict();

/** Filter shared pipeline state down to the Story Director's slice (drops photos, URLs, secrets, other agents' outputs). */
export function selectStoryDirectorInput(state = {}) {
  const p = state.project ?? state;
  const inputs = p.inputs ?? {};
  const castDescriptions = (p.castDescriptions ?? inputs.castDescriptions ?? [])
    .map(({ id, name, description }) => ({ id, name, description }));
  return StoryDirectorInput.parse({
    subject: inputs.subject ?? '',
    answers: inputs.answers ?? {},
    castDescriptions,
    format: p.format ?? {},
  });
}
