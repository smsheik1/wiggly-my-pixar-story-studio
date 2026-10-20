// Story Director v2 input slice: the ONLY state this agent may see.
import { z } from 'zod';

export const SCENE_KEYS = ['scene1Childhood', 'scene2TeenFreedom', 'scene3LeapOfFaith', 'scene4Romance', 'scene5LegacyFinale'];

export const StoryDirectorInput = z.object({
  subject: z.string().default(''),
  answers: z.record(z.string(), z.unknown()),
  castDescriptions: z.array(z.object({
    id: z.string(), name: z.string(), description: z.string(),
  })).default([]),
  // WIGGLY: main characters with real reference photos. Text only (no paths/bytes); use these looks, never guess.
  photoCharacters: z.array(z.object({
    id: z.string().min(1), name: z.string().min(1), realPerson: z.string().min(1),
    age: z.number().int().positive().nullable().default(null),
    skinTone: z.string().min(3), description: z.string().min(10),
  }).strict()).default([]),
  format: z.object({
    maxPartSeconds: z.number().int().max(30).default(30),
    // Reconciled with targetTotalRuntimeSec and the schema cap: target 90s, hard cap 180s.
    targetTotalSeconds: z.number().int().max(180).default(90),
    maxTotalSeconds: z.number().int().max(180).default(180),
    narrationAllowed: z.boolean().default(true),
    dialogueAllowed: z.boolean().default(true),
  }).prefault({}),
  targetTotalRuntimeSec: z.number().int().min(20).max(180).default(90),
  settingSeed: z.string().optional(),
  voiceNoteTranscript: z.string().optional(),
  toneDirectives: z.object({
    genre: z.enum(['comedy-subversion', 'emotional-journey', 'character-vignette']).default('comedy-subversion'),
    pacing: z.enum(['slow-burn', 'standard-pixar', 'rapid-fire']).default('standard-pixar'),
    runningGagSeed: z.string().optional(),
  }).strict().prefault({}),
}).strict();

/** Filter shared pipeline state down to the Story Director's slice (drops photos, URLs, secrets, other agents' outputs). */
export function selectStoryDirectorInput(state = {}) {
  const p = state.project ?? state;
  const inputs = p.inputs ?? {};
  // The graph's top-level castDescriptions defaults to [], so `??` silently dropped inputs.castDescriptions (r4-dry11/12). Merge both.
  const castDescriptions = [...(p.castDescriptions ?? []), ...(inputs.castDescriptions ?? [])]
    .map(({ id, name, description }) => ({ id, name, description }));
  return StoryDirectorInput.parse({
    subject: inputs.subject ?? '',
    answers: inputs.answers ?? {},
    castDescriptions,
    photoCharacters: (inputs.photoReferences ?? p.photoReferences ?? [])
      .map(({ id, name, realPerson, age, skinTone, description }) => ({ id, name, realPerson: realPerson ?? name, age: age ?? null, skinTone, description })),
    format: p.format ?? {},
    ...pick(inputs, ['targetTotalRuntimeSec', 'settingSeed', 'voiceNoteTranscript', 'toneDirectives']),
  });
}

function pick(o, keys) { return Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]])); }
