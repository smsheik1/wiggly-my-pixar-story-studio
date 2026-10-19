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
  for (const s of ['Nano Banana 2.1', 'Google Flow', 'hijab', 'depicted as 18', 'Only the people in the answers exist', 'cloned storyteller voice',
    'assumptions', 'One shot = one cut', 'moving hold'])
    assert.ok(role.includes(s), s);
  assert.ok(!/GPT Image 2/.test(role));
});
test('role.md diverges from Gemini only by additions + engine swap', () => {
  // Approved swaps: engine, and storyboard style painted -> 3D Pixar render (Shaz, 2026-10-16),
  // and one storyboard sheet per part, always 8 panels with unused slots empty (Shaz, 2026-10-16): the Panel 1-8 [shot n]
  // slots become 'Panel K, labelled "P.S"' / 'Panel K [empty]' lines, and the label is the exact part.shot.
  // Gemini's fictional child Mia is renamed Wren (examples must not reuse a real family's names).
  const norm = (s) => s.replaceAll('GPT Image 2', 'Nano Banana 2.1').replace(/\bMia\b/g, 'Wren')
    .replaceAll('evenly spaced, with a small hand-written shot number in the corner of each panel.',
      'evenly spaced. Each panel has its exact label (part.shot, like 1.4) hand-written small in the corner, with no other codes; empty panels have no label.')
    .replaceAll('Exactly 8 panels per sheet, arranged in two even rows of four ($2 \\times 4$ in 16:9).',
      'Exactly 8 panels per sheet, arranged in two even rows of four ($2 \\times 4$ in 16:9). Unused slots are plain empty frames.')
    .replaceAll('No text or writing in the panels other than the shot numbers.', 'No text or writing in the panels other than the panel labels.')
    .replace(/^Panel [1-8] \[shot [1-8]\]: .*$\n?/gm, '')
    .replaceAll('Painted digital storyboard art — soft loose brushwork, simplified appealing character shapes, minimal facial detail,',
      'Each panel is a polished 3D Pixar-style animated film render with appealing stylized characters, soft global illumination,');
  const roleNorm = norm(role);
  const missing = norm(gemini).split('\n').filter((l) => l.trim() && !l.startsWith('description:') && !roleNorm.includes(l));
  assert.deepEqual(missing, []);
});
test('storyboard default style is 3D Pixar render, not painted', () => {
  assert.ok(role.includes('polished 3D Pixar-style animated film render'));
  assert.ok(!/loose brushwork/.test(role));
});
test('storyboard template is one eight-panel sheet per part with exact "P.S" labels and empty slots', () => {
  assert.ok(role.includes('Panel 1, labelled "P.S":') && role.includes('"storyboardSheets"'));
  assert.ok(role.includes('Panel 8 [empty]: a plain blank off-white frame with a thin dark border, clearly empty, no characters, no drawing, no text.'));
  assert.ok(!role.includes('[Part P, shot S]') && !role.includes('[LAYOUT]') && !/four panels on the top row|a single row of/.test(role));
  assert.ok(!/Panel 8 \[shot 8\]/.test(role) && !role.includes('"storyboardPrompt"'));
});
