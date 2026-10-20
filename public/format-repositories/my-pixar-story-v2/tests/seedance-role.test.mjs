import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SeedanceCompilerOutputSchema, SeedanceSegmentSchema } from '../crew/seedance-compiler/schema.mjs';

const role = readFileSync(new URL('../crew/seedance-compiler/role.md', import.meta.url), 'utf8');
const gemini = readFileSync(new URL('./fixtures/gemini-sc-SKILL.md', import.meta.url), 'utf8');
// Wiggly overrides of Gemini lines (r4-dry15 SC review): two-sentence hard stop; [VISUAL STYLE] never names a forbidden word.
const OVERRIDES = [
  // Gemini's fictional child @Mia is renamed @Wren (Mia is a real recipient's name in the test family; examples stay obviously made up).
  ['@Mia', '@Wren'],
  ['Higgsfield / Volcano Engine', 'Seedance 2.5 via Replicate (bytedance/seedance-2.5) at 480p'],
  ['It ends the instant X finishes — do not continue into her story, do not resolve anything, do not add an ending.', 'It ends the instant X finishes. Do not continue past that moment, do not resolve anything and do not add an ending.'],
  ['Feature-quality 3D animated film, production CG, not photorealistic and not flat cartoon.', 'Feature-quality 3D animated film in stylized production CG with appealing animated proportions, never flat cartoon.'],
];
  // Wiggly: subsurface glow through skin removed (it pushed skin toward a waxy, sick look).
OVERRIDES.push(['Warm morning daylight, soft subsurface glow through ears and skin, tactile materials.', 'Warm morning daylight, tactile materials.']);
const norm = (s) => OVERRIDES.reduce((x, [a, b]) => x.replaceAll(a, b), s);

test('SC role.md contains Gemini SKILL.md word for word (only the engine swap)', () => {
  const missing = norm(gemini).split('\n').filter((l) => l.trim() && !role.includes(l));
  assert.deepEqual(missing, []);
  assert.ok(!/Higgsfield|Volcano/.test(role));
});
test('SC role.md has Wiggly additions and the JSON contract', () => {
  for (const k of [...Object.keys(SeedanceCompilerOutputSchema.shape), ...Object.keys(SeedanceSegmentSchema.shape)]) assert.ok(role.includes(`"${k}"`), k);
  for (const k of ['tag', 'kind', 'sourceTag', 'assetKey', 'locationTag', 'cast', 'action', 'dialogue', 'sfx', 'cut', 'mode']) assert.ok(role.includes(`"${k}"`), k);
  for (const s of ['480p', 'Extend', 'Element-name tags only', '@kitchen', 'never appear in the prompt', 'Never write a URL', 'approved local asset key',
    'Dialogue verbatim from the stage play', '3 spoken words per second', 'No `35mm`', 'no visible hair, hairline or dark band', 'Teens are depicted as 18',
    "Only the stage play's cast exists", '180 seconds', 'configured but disabled', 'dan-kieft-pixar-prompter.md', 'assumptions'])
    assert.ok(role.includes(s), s);
});
