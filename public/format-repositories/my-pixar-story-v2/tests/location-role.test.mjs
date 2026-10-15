import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LocationScoutOutputSchema, LocationSchema } from '../crew/location-scout/schema.mjs';

const role = readFileSync(new URL('../crew/location-scout/role.md', import.meta.url), 'utf8');
const gemini = readFileSync(new URL('./fixtures/gemini-ls-SKILL.md', import.meta.url), 'utf8');
const norm = (s) => s.replaceAll(' (and GPT Image 2)', '').replaceAll(' and GPT Image 2', '').replaceAll('Nano Banana Pro', 'Nano Banana 2.1 (Google Flow)');

test('LS role.md contains Gemini SKILL.md word for word (only engine swaps)', () => {
  const missing = norm(gemini).split('\n').filter((l) => l.trim() && !role.includes(l));
  assert.deepEqual(missing, []);
  assert.ok(!/GPT Image|Nano Banana Pro|Seedream|Claude/.test(role));
});
test('LS role.md has Wiggly additions and the JSON contract', () => {
  for (const k of [...Object.keys(LocationScoutOutputSchema.shape), ...Object.keys(LocationSchema.shape)]) assert.ok(role.includes(`"${k}"`), k);
  for (const s of ['Nano Banana 2.1 (Google Flow)', 'ONE line', 'PARALLEL with the Character Architect', '"@Loc 1"', 'NOT known', 'inherits the previous',
    'Time of day', 'Family / home realism', 'No people at all', 'Comedy-friendly staging space', 'assumptions', 'dan-kieft-pixar-prompter.md', 'nano-banana-2.1'])
    assert.ok(role.includes(s), s);
});
