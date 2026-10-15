// Location Scout v2 input slice: the ONLY state this agent may see.
// Included: stage-play scenes (with inherited locations), distinct settings, settingSeed, toneDirectives.
// Excluded: character sheets, cast photos/notes, dialogue lines, storyboard, HTML deck, secrets, URLs, photo paths.
import { z } from 'zod';
import { SCENE_ID } from './schema.mjs';

export const SceneSchema = z.object({
  sceneId: z.string().regex(SCENE_ID),
  location: z.string().min(1),
  whatWeSee: z.string(),
}).strict();

// Per-setting hints (from Gemini's input contract; all optional except what the selector derives).
export const PaletteRestrictions = z.object({
  forbiddenWallColors: z.array(z.string()).default([]),
  dominantEnvironmentTones: z.array(z.string()).min(1).default(['warm white', 'natural wood', 'muted teal']),
}).strict();
export const StagingRequirements = z.object({
  actorCount: z.number().int().positive(),
  blockingGeometry: z.string().min(10).optional(),
  cameraPerspective: z.string().min(10).optional(),
}).strict();
export const LightingAnchorInput = z.object({
  source: z.string().min(5), timeOfDay: z.string().min(3), shadowCharacteristics: z.string().min(5),
}).strict();
export const SettingSchema = z.object({
  name: z.string().min(1),
  sceneIds: z.array(z.string().regex(SCENE_ID)).min(1),
  paletteRestrictions: PaletteRestrictions.prefault({}),
  stagingRequirements: StagingRequirements.optional(),
  lightingAnchor: LightingAnchorInput.optional(),
  singleSignText: z.string().max(30).optional(),
}).strict();

export const LocationScoutInput = z.object({
  scenes: z.array(SceneSchema).min(1),
  settings: z.array(SettingSchema).min(1),
  continuityLocks: z.array(z.string()).default([]),
  settingSeed: z.string().optional(),
  toneDirectives: z.object({
    genre: z.enum(['comedy-subversion', 'emotional-journey', 'character-vignette']).default('comedy-subversion'),
    pacing: z.enum(['slow-burn', 'standard-pixar', 'rapid-fire']).default('standard-pixar'),
    runningGagSeed: z.string().optional(),
  }).strict().prefault({}),
}).strict().superRefine((d, ctx) => {
  const names = d.settings.map((s) => s.name);
  if (names.length !== new Set(names).size) ctx.addIssue({ code: 'custom', path: ['settings'], message: 'duplicate setting name' });
});

const URLISH = /\b(?:https?:\/\/|file:\/\/)\S+|(?:\/Users|\/home|~)\/\S+|\b\S+\.(?:jpe?g|png|heic|webp)\b/gi;
const scrub = (s) => String(s ?? '').replace(URLISH, '[removed]');

/** Filter shared pipeline state to the Location Scout slice. A shot without a location inherits the previous one. */
export function selectLocationScoutInput(state = {}) {
  const p = state.project ?? state;
  const sd = p.storyDirector ?? p.stagePlay ?? {};
  const inputs = p.inputs ?? {};
  const scenes = [];
  const actors = new Map(); // setting -> Set of cast present (derived actorCount)
  const castTags = (sd.cast ?? []).map((c) => [c.elementTag, c.name]);
  let current;
  for (const seg of sd.segments ?? []) for (const sh of seg.shots ?? []) {
    if (sh.location) current = sh.location;
    if (!current) throw new Error(`selectLocationScoutInput: shot ${seg.segmentId}.${sh.shotNumber} has no location and none to inherit`);
    const who = actors.get(current) ?? new Set(); actors.set(current, who);
    const text = `${sh.whatWeSee ?? ''} ${JSON.stringify(sh.dialogue ?? '')}`;
    for (const [tag, name] of castTags) if (text.includes(tag) || new RegExp(`\\b${name}\\b`, 'i').test(text)) who.add(tag);
    scenes.push({ sceneId: `${seg.segmentId}.${sh.shotNumber}`, location: current, whatWeSee: scrub(sh.whatWeSee) });
  }
  const settings = [];
  for (const s of scenes) {
    let e = settings.find((x) => x.name === s.location);
    if (!e) settings.push(e = { name: s.location, sceneIds: [] });
    e.sceneIds.push(s.sceneId);
  }
  // Optional overrides: state.locationScout.settings[<name>] = { paletteRestrictions, stagingRequirements, lightingAnchor, singleSignText }
  const hints = p.locationScout?.settings ?? {};
  // Forbidden wall colours derived from cast signature accents (colour words only; the cast itself is not passed on).
  const COLOURS = /\b(red|orange|yellow|mustard|green|teal|blue|navy|purple|magenta|pink|grey|black|white|brown|gold)\b/gi;
  const accentColours = [...new Set((sd.cast ?? []).flatMap((c) => (c.signatureAccent ?? '').match(COLOURS) ?? []).map((c) => c.toLowerCase()))];
  for (const e of settings) {
    const h = hints[e.name] ?? {};
    e.paletteRestrictions = { forbiddenWallColors: accentColours, ...(h.paletteRestrictions ?? {}) };
    e.stagingRequirements = { actorCount: Math.max(1, actors.get(e.name)?.size ?? 0), ...(h.stagingRequirements ?? {}) };
    for (const k of ['lightingAnchor', 'singleSignText']) if (h[k] !== undefined) e[k] = h[k];
  }
  const continuityLocks = (sd.segments ?? []).flatMap((s) => s.continuityLocks ?? []);
  const opt = {};
  for (const k of ['settingSeed', 'toneDirectives']) if (inputs[k] !== undefined) opt[k] = inputs[k];
  return LocationScoutInput.parse({ scenes, settings, continuityLocks, ...opt });
}
