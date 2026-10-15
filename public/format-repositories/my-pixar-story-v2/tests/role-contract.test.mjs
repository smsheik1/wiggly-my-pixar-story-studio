import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StoryDirectorOutputSchema } from '../crew/story-director/schema.mjs';

const role = readFileSync(new URL('../crew/story-director/role.md', import.meta.url), 'utf8');
const gemini = readFileSync(new URL('./fixtures/gemini-SKILL.md', import.meta.url), 'utf8');
test('role.md documents every top-level output key', () => {
  for (const k of Object.keys(StoryDirectorOutputSchema.shape)) assert.ok(role.includes(`"${k}"`), `role.md missing ${k}`);
});
test('role.md keeps Gemini base text (kindergarten examples) and Wiggly additions', () => {
  for (const s of ['Direct, Don\'t Transcribe', 'kindergarten classroom with carpet squares', 'Rung 3 (Loss of Control)',
    'Miss Park: {Okay — so who\'s next?}', 'The 30-Second Hard Ceiling Law', 'Human Approval Gate'])
    assert.ok(role.includes(s), s);
  for (const s of ['Nano Banana 2.1', 'Google Flow', 'hijab', 'depicted as 18', 'Shaz himself', 'cloned storyteller voice',
    'assumptions', 'One shot = one cut', 'moving hold'])
    assert.ok(role.includes(s), s);
  assert.ok(!/GPT Image 2/.test(role));
});
test('role.md diverges from Gemini only by additions + engine swap', () => {
  const norm = (s) => s.replaceAll('GPT Image 2', 'Nano Banana 2.1');
  const roleNorm = norm(role);
  const missing = norm(gemini).split('\n').filter((l) => l.trim() && !l.startsWith('description:') && !roleNorm.includes(l));
  assert.deepEqual(missing, []);
});
