// Vera one-text exception: craft [L-MIN-TEXT], Vera skill, visual rubric,
// background recipe and Theo agree that at most one hand-lettered item named
// by the brief may pass. No network, no live models.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('craft [L-MIN-TEXT] allows one brief-named hand-lettered item, rejects the rest', async () => {
  const guide = await read('../craft-guide.md');
  const line = guide.split('\n').find(l => l.startsWith('- [L-MIN-TEXT]'));
  assert.ok(line, 'L-MIN-TEXT bullet exists');
  assert.match(line, /\[L-MIN-TEXT\] \(check: vera, sage\)/);
  assert.match(line, /No readable text in plates/);
  assert.match(line, /at most one hand-lettered item/i);
  assert.match(line, /brief explicitly names/);
  assert.match(line, /reading exactly as named/);
  assert.match(line, /extra or unrequested text/);
  assert.match(line, /brands\/logos\/real landmarks/);
  assert.match(line, /garbled lettering fails/);
  assert.equal(guide.split('\n').filter(l => l.startsWith('- [L-MIN-TEXT]')).length, 1, 'still one bullet line');
});

test('Vera skill states the same one-text exception and transcribes all text', async () => {
  const vera = await read('../crew/vera/SKILL.md');
  assert.match(vera, /One hand-lettered item the prompt\/brief names passes only if it reads exactly as named/);
  assert.match(vera, /a second text item, any unrequested text, any brand\/logo\/real landmark, or misspelled\/garbled lettering fails `story-specific-set`/);
  assert.match(vera, /Transcribe all text exactly in `evidence`/);
  assert.doesNotMatch(vera, /Any readable text, brand, logo or real landmark in the plate also fails/);
  // Character-sheet no-text rule is unchanged.
  assert.match(vera, /Any baked-in text, label, caption/);
});

test('visual rubric keeps the fail mapping and states the same exception', async () => {
  const visual = await read('../evaluation/rubrics/visual.md');
  assert.match(visual, /fails `story-specific-set` \(\[L-MIN-TEXT\]\)/);
  assert.match(visual, /except at most one hand-lettered item the brief explicitly names/);
  assert.match(visual, /reads exactly as named/);
  assert.match(visual, /a second item, any unrequested text, any brand\/logo\/real landmark, or misspelled\/garbled lettering still fails/);
  assert.match(visual, /Transcribe all text exactly in evidence/);
});

test('Theo role/skill and the craft guide agree, recipe aligns', async () => {
  const guide = await read('../craft-guide.md');
  const role = await read('../crew/theo/role.md');
  const skill = await read('../crew/theo/SKILL.md');
  const recipe = await read('../background-prompter.md');
  for (const [name, text] of [['theo role', role], ['theo skill', skill]]) {
    assert.match(text, /At most one piece of text, and only when the brief/, `${name} allows one item only when the brief names it`);
    assert.match(text, /\[L-MIN-TEXT\]/, `${name} cites the craft rule`);
  }
  assert.match(guide.split('\n').find(l => l.startsWith('- [L-MIN-TEXT]')), /at most one hand-lettered item/i);
  assert.match(recipe, /at most one hand-lettered item only when the brief names it.*\(apply \[L-MIN-TEXT\]\)/);
});
