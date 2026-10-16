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
  // Approved swaps: engine, and storyboard style painted -> 3D Pixar render (Shaz, 2026-10-16),
  // and one storyboard sheet per part instead of a single 8-panel sheet (Shaz, 2026-10-16): the sheet size, layout
  // and Panel 1-8 [shot n] slots become N-panel / [LAYOUT] / Panel n [Part P, shot S] slots.
  const norm = (s) => s.replaceAll('GPT Image 2', 'Nano Banana 2.1')
    .replaceAll("An eight-panel colour storyboard sheet from a feature animation studio's pre-production, arranged in two even rows of four panels on a warm off-white page.",
      "An [N-word]-panel colour storyboard sheet from a feature animation studio's pre-production, arranged in [LAYOUT] on a warm off-white page.")
    .replaceAll('* **Grid Layout:** Exactly 8 panels per sheet, arranged in two even rows of four ($2 \\times 4$ in 16:9).',
      '* **Grid Layout:** At most 8 panels per sheet. 8 panels: two even rows of four ($2 \\times 4$ in 16:9). 5 to 7 panels: two rows, four on the top row and the rest on the bottom row. 4 or fewer: a single row.')
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
test('storyboard template is one sheet per part with real part/shot labels', () => {
  assert.ok(role.includes('Panel 1 [Part P, shot S]') && role.includes('"storyboardSheets"'));
  assert.ok(!/Panel 8 \[shot 8\]/.test(role) && !role.includes('"storyboardPrompt"'));
});
