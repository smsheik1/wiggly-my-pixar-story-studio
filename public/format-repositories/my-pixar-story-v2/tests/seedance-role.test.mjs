import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SeedanceCompilerOutputSchema, SeedanceSegmentSchema } from '../crew/seedance-compiler/schema.mjs';

const role = readFileSync(new URL('../crew/seedance-compiler/role.md', import.meta.url), 'utf8');
const gemini = readFileSync(new URL('./fixtures/gemini-sc-SKILL.md', import.meta.url), 'utf8');
const norm = (s) => s.replaceAll('Higgsfield / Volcano Engine', 'Seedance 2.5 via Replicate (bytedance/seedance-2.5) at 480p');

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
    'Shaz has no son', '180 seconds', 'configured but disabled', 'dan-kieft-pixar-prompter.md', 'assumptions'])
    assert.ok(role.includes(s), s);
});
