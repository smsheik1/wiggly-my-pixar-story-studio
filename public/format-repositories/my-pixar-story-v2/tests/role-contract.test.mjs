import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StoryDirectorOutputSchema } from '../crew/story-director/schema.mjs';

const role = readFileSync(new URL('../crew/story-director/3-script-writer.md', import.meta.url), 'utf8');
const render = readFileSync(new URL('../scripts/lib/sd-render.mjs', import.meta.url), 'utf8');
const gemini = readFileSync(new URL('./fixtures/gemini-SKILL.md', import.meta.url), 'utf8');
test('3-script-writer.md documents every top-level output key', () => {
  for (const k of Object.keys(StoryDirectorOutputSchema.shape)) assert.ok(role.includes(`"${k}"`), `3-script-writer.md missing ${k}`);
});
test('3-script-writer.md keeps Gemini base text, memory-film craft and Wiggly additions; toy examples gone', () => {
  for (const s of ['Direct, Don\'t Transcribe', 'The one moment that matters', 'The specific true detail', 'The turn', 'The reaction shot',
    'Let tender moments breathe', 'Comedy where it is earned, never in tender beats', 'The 30-Second Hard Ceiling Law', 'Human Approval Gate'])
    assert.ok(role.includes(s), s);
  assert.doesNotMatch(role, /\b(Theo|Gran|Wren|Ben|Miss Park|kindergarten|hitman|Rung \d|Rule of Three)\b/);
  for (const s of ['Nano Banana 2.1', 'Google Flow', 'hijab', 'depicted as 18', 'Only the people in the answers exist', 'expressive generated voice',
    'assumptions', 'One shot = one cut', 'moving hold'])
    assert.ok(role.includes(s), s);
  assert.ok(!/GPT Image 2/.test(role));
});
test('3-script-writer.md diverges from Gemini only by additions + engine swap', () => {
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
  // Approved removal (Shaz, 2026-10-20): code builds the HTML deck and storyboard sheets (scripts/lib/sd-render.mjs), so
  // Gemini's deck format (typography, document structure) and all of section 5, plus their checklist lines, left the role.
  const g = gemini.replace(/^Deliver the finalized screenplay[\s\S]*?(?=^### The Shot Card Anatomy)/m, '')
    .replace(/^## 4\. The HTML Script Card Deck Format\n/m, '').replace(/^## 5\. [\s\S]*?(?=^## 6\.)/m, '')
    .replace(/^- \[ \] Storyboard prompt names skin tone in every panel line\.\n/m, '')
    // Approved (Shaz, 2026-10-20): parts are 30s render chunks (one multi-shot prompt each), not an Original/Sequel Extend chain.
    .replace(/^\* If a scene runs longer than 30 seconds, split it into named modular segments.*\n/m, '')
    .replaceAll('Part 1: Original', 'Part 1')
    // Approved (Shaz, 2026-10-20): the approval gate is run by code, so its checklist box left the role.
    .replace(/^- \[ \] Pauses at the Human Approval Gate.*\n/m, '');
  // Approved rewrite (Shaz, 2026-10-20): section 1 became memory-film craft; the kindergarten / toy examples, the teacher
  // vernacular and the comedy checklist boxes (ordinary world, rule of three, gag ladder) left the role.
  const toy = /Miss Park|\bBen\b|\bWren\b|\bMia\b|Rule of Three|Ordinary world baseline|Running gag has|Authority \/ Teacher|Silent Reaction \/ Business Beat|Two-Line Exchange|Single Short Line/;
  // Approved renumbering (Shaz, 2026-10-20): with section 5 gone, the checklist is section 5.
  const missing = norm(g).replace('## 6. Pre-Send Quality Checklist', '## 5. Pre-Send Quality Checklist').replace(/^## 1\. [\s\S]*?(?=^## 2\.)/m, '').split('\n').filter((l) => !toy.test(l)).join('\n').split('\n').filter((l) => l.trim() && !l.startsWith('description:') && !roleNorm.includes(l));
  assert.deepEqual(missing, []);
});
test('storyboard default style is 3D Pixar render, not painted (now in code)', () => {
  assert.ok(render.includes('polished 3D Pixar-style animated film render'));
  assert.ok(!/loose brushwork/.test(render) && !/loose brushwork/.test(role));
});
test('role no longer asks the model for the HTML deck or storyboard sheets; code owns the eight-panel template', () => {
  assert.ok(!role.includes('"storyboardSheets"') && !role.includes('"htmlScriptDocument": "') && !role.includes('Panel 1, labelled "P.S":'));
  assert.ok(role.includes('Code builds the HTML script card deck and the storyboard sheet prompts'));
  assert.ok(render.includes('two even rows of four panels') && render.includes('[empty]: a plain blank off-white frame with a thin dark border, clearly empty, no characters, no drawing, no text.'));
  assert.ok(!role.includes('"storyboardPrompt"'));
});
