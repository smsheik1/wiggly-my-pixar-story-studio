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
  assert.deepEqual(Object.keys(s).sort(), ['answers', 'castDescriptions', 'format', 'subject', 'targetTotalRuntimeSec', 'toneDirectives']);
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
test('optional intake fields: defaults, pass-through, bounds', () => {
  const s = selectStoryDirectorInput(state);
  assert.equal(s.targetTotalRuntimeSec, 90);
  assert.deepEqual(s.toneDirectives, { genre: 'comedy-subversion', pacing: 'standard-pixar' });
  assert.ok(!('settingSeed' in s) && !('voiceNoteTranscript' in s));
  const st = structuredClone(state); Object.assign(st.project.inputs, { targetTotalRuntimeSec: 45, settingSeed: 'kitchen',
    voiceNoteTranscript: 'hi', toneDirectives: { genre: 'emotional-journey', pacing: 'slow-burn', runningGagSeed: 'sunglasses' } });
  const t = selectStoryDirectorInput(st);
  assert.equal(t.targetTotalRuntimeSec, 45); assert.equal(t.settingSeed, 'kitchen'); assert.equal(t.voiceNoteTranscript, 'hi');
  assert.equal(t.toneDirectives.runningGagSeed, 'sunglasses');
  for (const v of [19, 181, 30.5]) assert.throws(() => StoryDirectorInput.parse({ answers: {}, targetTotalRuntimeSec: v }));
  assert.throws(() => StoryDirectorInput.parse({ answers: {}, toneDirectives: { genre: 'horror' } }));
  assert.throws(() => StoryDirectorInput.parse({ answers: {}, toneDirectives: { pacing: 'fast' } }));
});
