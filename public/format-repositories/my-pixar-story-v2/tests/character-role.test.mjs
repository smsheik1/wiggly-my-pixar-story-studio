import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CharacterArchitectOutputSchema } from '../crew/character-architect/schema.mjs';

const role = readFileSync(new URL('../crew/character-architect/role.md', import.meta.url), 'utf8');
const gemini = readFileSync(new URL('./fixtures/gemini-ca-SKILL.md', import.meta.url), 'utf8');
const SWAPS = [['GPT Image 2', 'Nano Banana 2.1'], ['Seedream 5.0 Pro', 'Nano Banana 2.1'], ['Higgsfield / OpenAI', 'Google Flow'],
  ['Heavy cloth with weight, few large folds, grime in creases, unbranded]', 'Cloth with weight, few large folds, clean, unbranded]'],
  ['feature-quality 3D animated film, production CG, not photorealistic and not flat cartoon', 'stylized 3D animated feature film: storybook look, simplified chunky shapes with soft rounded edges, smooth clean materials, gently saturated colors']]; // deliberate: no wear/grime (anti-photoreal)

test('CA role.md contains Gemini SKILL.md word for word (only engine swaps)', () => {
  const norm = (s) => SWAPS.reduce((t, [a, b]) => t.replaceAll(a, b), s);
  const missing = norm(gemini).split('\n').filter((l) => l.trim() && !l.startsWith('description:') && !role.includes(l));
  assert.deepEqual(missing, []);
  assert.ok(!/GPT Image 2|Seedream|Higgsfield/.test(role));
});
test('CA role.md has Wiggly additions, worked examples and the JSON contract', () => {
  for (const s of ['Google Flow', 'no visible hair, hairline or dark band', 'Hair: none visible', 'Teens are depicted as 18', 'Only the cast you are given',
    'Never write "minor"', 'masterRenderRef', 'Match the attached approved master render', '@Image 1', 'isMain', 'assumptions',
    'warm cinematic key', 'catchlights', 'crisp white, cream or bright main garment', 'firefighter dad', 'heavy khaki-tan turnout trousers', '8) TALKING — caught mid-word'])
    assert.ok(role.includes(s), s);
  for (const k of Object.keys(CharacterArchitectOutputSchema.shape)) assert.ok(role.includes(`"${k}"`), k);
});
