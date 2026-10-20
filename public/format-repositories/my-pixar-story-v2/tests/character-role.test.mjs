import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CharacterArchitectOutputSchema } from '../crew/character-architect/schema.mjs';

const role = readFileSync(new URL('../crew/character-architect/role.md', import.meta.url), 'utf8');
const gemini = readFileSync(new URL('./fixtures/gemini-ca-SKILL.md', import.meta.url), 'utf8');
const SWAPS = [['GPT Image 2', 'Nano Banana 2.1'], ['Seedream 5.0 Pro', 'Nano Banana 2.1'], ['Higgsfield / OpenAI', 'Google Flow'],
  ['Heavy cloth with weight, few large folds, grime in creases, unbranded]', 'Cloth with weight, few large folds, clean, unbranded]'],
  ['. ONE WORN/ATTACHED SIGNATURE ELEMENT carrying the ONLY saturated color in an otherwise muted palette.', " in this character's own main colour, one supporting colour and one small accent. Signature element only if the card gives one."],
  ['Camera: 50mm straight', 'Camera: straight'], ['backdrop, 50mm lens.', 'backdrop, camera straight on at chest height.'],
  ['- [ ] Signature element only', '- [ ] Signature element only'],
  ['feature-quality 3D animated film, production CG, not photorealistic and not flat cartoon', 'stylized 3D animated feature film: storybook look, simplified chunky shapes with soft rounded edges, smooth clean materials, gently saturated colors'], ["Skin: [LIGHT ZONING | DEEP ZONING. Warm subsurface glow through ears and fingertips. Uneven freckles/marks].", "Skin: [matte SKIN TONE, even and healthy, with a soft natural warmth on the cheeks. Freckles/marks only if the card gives them]."], ["### Skin Zoning Settings:", "### Skin Settings:"], ["* **Light Skin:** Pink nose tip, red translucent ear tips, flushed cheeks, cool purple-grey under eyes.", "* **All skin tones:** even, healthy skin with a soft natural warmth on the cheeks; deep skin stays warm and rich in the shadow turn."], ["* **Deep Skin:** Deep red-orange at nose tip and rims of ears, plum-red flush across cheeks and through shadow turn, cooler grey-violet under eyes.", "* **Rules for you, not prompt words:** no under-eye colour, no red ears or nose, no flush zones, no subsurface glow. Describe only the healthy look in the prompt; never list the unwanted features there."], ["*(Warning: Applying the light setting to dark skin produces grey, ashen, dead skin. Always switch).*", "*(`skinZoning`: `deep` for dark or brown skin so it never turns grey or ashen; `light` otherwise.)*"], ["- [ ] Skin zoning setting strictly matches character ethnicity (Deep vs Light).", "- [ ] Skin: `skinZoning` matches skin tone (deep vs light); Skin line describes even, healthy skin only (no under-eye colour, red ears/nose or glow words)."]]; // deliberate: no wear/grime; healthy skin, no zoning words (anti-photoreal)

test('CA role.md contains Gemini SKILL.md word for word (only engine swaps)', () => {
  const norm = (s) => SWAPS.reduce((t, [a, b]) => t.replaceAll(a, b), s);
  const missing = norm(gemini).split('\n').filter((l) => l.trim() && !l.startsWith('description:') && !role.includes(l));
  assert.deepEqual(missing, []);
  assert.ok(!/GPT Image 2|Seedream|Higgsfield/.test(role));
});
test('CA role.md has Wiggly additions, worked examples and the JSON contract', () => {
  for (const s of ['Google Flow', 'no visible hair, hairline or dark band', 'Hair: none visible', 'Teens are depicted as 18', 'Only the cast you are given',
    'Never write "minor"', 'masterRenderRef', 'Match the attached approved master render', '@Image 1', 'isMain', 'assumptions',
    'warm cinematic key', 'catchlights', 'own dominant outfit colour, never repeated', 'read apart in grayscale', 'vary garment shapes', 'firefighter dad', 'heavy khaki-tan turnout trousers', '8) TALKING — caught mid-word'])
    assert.ok(role.includes(s), s);
  for (const k of Object.keys(CharacterArchitectOutputSchema.shape)) assert.ok(role.includes(`"${k}"`), k);
});
