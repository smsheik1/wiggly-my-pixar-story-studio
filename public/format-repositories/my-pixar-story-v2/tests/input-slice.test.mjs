import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectStoryDirectorInput, StoryDirectorInput } from '../crew/story-director/input.mjs';

const state = { project: {
  inputs: { subject: 'Shaz', answers: { scene1Childhood: 'sunglasses everywhere' },
    photos: ['/Users/x/p.jpg'], videoUrl: 'https://example.invalid/secret', castDescriptions: [{ id: 'mom', name: 'Mom', description: 'hijab', photoPath: '/p.jpg' }] },
  format: { maxPartSeconds: 30 },
  secrets: { OPENROUTER_API_KEY: 'k' }, characterSheets: [1], clips: [2], stagePlay: { old: true },
} };

test('selector keeps only answers, cast text, format', () => {
  const s = selectStoryDirectorInput(state);
  assert.deepEqual(Object.keys(s).sort(), ['answers', 'castDescriptions', 'format', 'subject']);
  assert.deepEqual(s.castDescriptions, [{ id: 'mom', name: 'Mom', description: 'hijab' }]);
  const flat = JSON.stringify(s);
  for (const bad of ['photo', 'videoUrl', 'secret', 'OPENROUTER', 'characterSheets', 'clips', 'stagePlay', '.jpg'])
    assert.ok(!flat.includes(bad), `leaked ${bad}`);
  assert.equal(s.format.maxTotalSeconds, 90);
});
test('input schema is strict and caps format', () => {
  assert.throws(() => StoryDirectorInput.parse({ answers: {}, photos: [] }));
  assert.throws(() => StoryDirectorInput.parse({ answers: {}, format: { maxPartSeconds: 31 } }));
});
