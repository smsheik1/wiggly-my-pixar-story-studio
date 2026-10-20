// Location Scout v2 output contract (Zod, plain JS). Mirrors Character Architect patterns.
import { z } from 'zod';

export const IMAGE_ENGINE = 'nano-banana-2.1'; // Google Flow
export const PLATE_MIN = 300; // gate bound; schema floor is Gemini's 200
export const PLATE_MAX = 3000;
export const TIMES_OF_DAY = ['dawn', 'morning', 'midday', 'afternoon', 'late-afternoon', 'golden-hour', 'dusk', 'evening', 'night'];
export const SCENE_ID = /^\d+\.\d+$/;
const singleLine = (s) => !/[\r\n]/.test(s);

// BASE: Gemini's Location Scout schema (gemini-ls-schema.ts). Wiggly additions are marked "WIGGLY".
export const EMPTY_PHRASE = 'completely empty of people';
export const ANTI_RUNE_DEFAULT = 'No other text, no posters, no alphabet strips, no charts, no writing on chalkboards or walls';

export const LightingAnchorSpecSchema = z.object({
  keyLightDirection: z.string().min(5),
  sourceDescription: z.string().min(5),
  shadowCharacteristics: z.string().min(5),
});

export const CameraStagingSpecSchema = z.object({
  lensMm: z.number().int().min(24).max(85).default(35),
  cameraElevation: z.string().min(5),
  stagingCoordinates: z.string().min(10).describe('Where the scripted action must be stageable'),
});

export const SingleSignRuleSchema = z.object({
  hasSign: z.boolean().default(false),
  signText: z.string().max(30).optional(),
  antiRuneExclusion: z.string().min(10).default(ANTI_RUNE_DEFAULT),
});

export const LocationPlatePromptSchema = z.object({
  targetEngine: z.literal(IMAGE_ENGINE).default(IMAGE_ENGINE), // WIGGLY: Nano Banana 2.1 only
  aspectRatio: z.literal('16:9').default('16:9'),
  promptText: z.string().min(200).max(PLATE_MAX).refine(singleLine, 'promptText must be a single line (Google Flow)'), // WIGGLY single line
  negativePrompt: z.string().optional(),
});

export const LocationSchema = z.object({
  locationId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(2),
  elementTag: z.string().regex(/^@Loc \d+$/, "elementTag must look like '@Loc 1'"), // WIGGLY format
  emptySetGuarantee: z.literal(true).default(true),
  singleSignRule: SingleSignRuleSchema.prefault({}),
  lightingAnchor: LightingAnchorSpecSchema,
  cameraStaging: CameraStagingSpecSchema,
  locationPlatePrompt: LocationPlatePromptSchema,
  // WIGGLY
  settingName: z.string().min(1).describe('Exact stage-play location string'),
  timeOfDay: z.enum(TIMES_OF_DAY),
  sceneIds: z.array(z.string().regex(SCENE_ID, "sceneIds look like '1.3'")).min(1),
}).strict()
  .refine((d) => d.locationPlatePrompt.promptText.includes(EMPTY_PHRASE), { message: `Empty Set Law: promptText must include verbatim "${EMPTY_PHRASE}"`, path: ['locationPlatePrompt', 'promptText'] })
  .refine((d) => !d.singleSignRule.hasSign || !!d.singleSignRule.signText, { message: 'signText is REQUIRED when hasSign is true', path: ['singleSignRule', 'signText'] })
  .refine((d) => !d.singleSignRule.signText || d.locationPlatePrompt.promptText.includes(d.singleSignRule.signText), { message: 'Anti-Rune: signText must appear verbatim in promptText', path: ['singleSignRule', 'signText'] });

export const LocationScoutOutputSchema = z.object({
  locations: z.array(LocationSchema).min(1),
  assumptions: z.array(z.string()).default([]),
}).strict().superRefine((d, ctx) => {
  const seen = (k) => { const v = d.locations.map((l) => l[k]); return v.length !== new Set(v).size; };
  for (const k of ['locationId', 'settingName']) if (seen(k)) ctx.addIssue({ code: 'custom', path: ['locations'], message: `duplicate ${k}` });
  const ids = d.locations.flatMap((l) => l.sceneIds);
  if (ids.length !== new Set(ids).size) ctx.addIssue({ code: 'custom', path: ['locations'], message: 'a scene id is claimed by two locations' });
  d.locations.forEach((l, i) => {
    if (l.elementTag !== `@Loc ${i + 1}`) ctx.addIssue({ code: 'custom', path: ['locations', i, 'elementTag'], message: `elementTag must be '@Loc ${i + 1}' (positional)` });
  });
});

export class LocationPlateParseError extends Error {
  constructor(issues) {
    super('Location Scout output failed the contract:\n' +
      issues.map((i) => `  - ${(i.path ?? []).join('.') || '(root)'}: ${i.message}`).join('\n'));
    this.name = 'LocationPlateParseError';
    this.issues = issues;
  }
}

/** Parse Location Scout output (object or JSON string). Throws LocationPlateParseError. */
export function parseLocationPlates(input) {
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); } catch (e) { throw new LocationPlateParseError([{ path: [], message: `not valid JSON (${e.message})` }]); }
  }
  const r = LocationScoutOutputSchema.safeParse(obj);
  if (!r.success) throw new LocationPlateParseError(r.error.issues);
  return r.data;
}
