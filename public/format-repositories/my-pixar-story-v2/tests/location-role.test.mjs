import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LocationScoutOutputSchema, LocationSchema } from '../crew/location-scout/schema.mjs';

const role = readFileSync(new URL('../crew/location-scout/role.md', import.meta.url), 'utf8');
const gemini = readFileSync(new URL('./fixtures/gemini-ls-SKILL.md', import.meta.url), 'utf8');
// Deliberate stylization edits (anti-photoreal): Gemini lines we rewrote on purpose.
const STYLIZED = [
  ['* **Lens & Perspective:** 35mm (wide establishing) or 50mm (medium master). Deep staging with clear foreground, midground, and background layers.', '* **Framing:** a wide shot or medium shot in plain words, with clear foreground, midground and background layers.'],
  ['(warm white walls, honey-oak wood, scuffed painted cubbies, soft desaturated teal)', '(warm white walls, honey-oak wood, soft teal)'],
  ['Sets use **muted, warm, natural palettes**', 'Sets use a **gently saturated, cohesive palette**'],
  ['shelves, desks, cubbies, textures with soft wear and tactile production CG materials]. [WALL DRESSING — drawings, textures, soft paint wear]', 'simplified rounded chunky shapes, clean stylized materials]. [WALL DRESSING — a few simple items]'],
  ['stacking chairs, coat racks, aquarium tank, plants, small tactile details creating believable living space without clutter]', 'a few clear story props from the answers, no clutter]'],
  [' Warm ambient daylight bounce. Subtle atmospheric dust motes in light beams, no fog, no haze]', ' Soft simple bounce light, no fog, no haze]'],
  ['[FOCAL LENGTH, CAMERA HEIGHT, ANGLE — e.g. 35mm wide shot at adult chest height looking down at the carpet staging area, level horizon, deep depth of field keeping background readable]', '[SHOT SIZE, CAMERA HEIGHT, ANGLE — e.g. wide shot at adult chest height looking down at the carpet staging area, level horizon]'],
  [', no photorealistic film grain, no 35mm noise.', '.'],
  ['feature-quality 3D animated film, production CG, not photorealistic and not flat cartoon', 'stylized 3D animated feature film: storybook look, simplified chunky shapes with soft rounded edges, smooth clean materials, gently saturated colors'],
  ['Authors production CG background', 'Authors stylized 3D background'],
];
const norm = (s) => STYLIZED.reduce((t, [a, b]) => t.replaceAll(a, b), s).replaceAll(' (and GPT Image 2)', '').replaceAll(' and GPT Image 2', '').replaceAll('Nano Banana Pro', 'Nano Banana 2.1 (Google Flow)');

test('LS role.md contains Gemini SKILL.md word for word (only engine swaps)', () => {
  const missing = norm(gemini).split('\n').filter((l) => l.trim() && !role.includes(l));
  assert.deepEqual(missing, []);
  assert.ok(!/GPT Image|Nano Banana Pro|Seedream|Claude/.test(role));
});
test('LS role.md has Wiggly additions and the JSON contract', () => {
  for (const k of [...Object.keys(LocationScoutOutputSchema.shape), ...Object.keys(LocationSchema.shape)]) assert.ok(role.includes(`"${k}"`), k);
  for (const s of ['Nano Banana 2.1 (Google Flow)', 'ONE line', 'PARALLEL with the Character Architect', '"@Loc 1"', 'NOT known', 'inherits the previous',
    'Time of day', 'Stylized, not photographed', 'No people at all', 'Comedy-friendly staging space', 'assumptions', 'dan-kieft-pixar-prompter.md', 'nano-banana-2.1'])
    assert.ok(role.includes(s), s);
});
