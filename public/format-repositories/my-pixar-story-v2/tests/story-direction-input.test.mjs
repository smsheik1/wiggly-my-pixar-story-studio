// The family's story direction (tone, setting, voice note, runtime) survives every hop: project json -> inputsFromProject
// (every run script uses it) -> graph state -> the Story Director input. Fake invoke only: zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inputsFromProject } from '../scripts/run-rehearsal.mjs';
import { buildGraph } from '../graph/graph.mjs';
import { STORY_DIRECTION_KEYS, selectStoryDirectorInput } from '../crew/story-director/input.mjs';
import { GOOD_ANSWERS } from './fixtures/good-answers.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const DIRECTION = {
  targetTotalRuntimeSec: 60,
  settingSeed: 'a small apartment in Karachi, 1998',
  voiceNoteTranscript: 'Keep it gentle. No jokes about the move.',
  toneDirectives: { genre: 'emotional-journey', pacing: 'slow-burn' },
};
const project = (extra = {}) => ({ inputs: { subject: { preferredName: 'Shaz', recipientName: 'Mia' }, answers: GOOD_ANSWERS, ...extra } });

test('inputsFromProject passes every story direction field through unchanged', () => {
  assert.deepEqual([...STORY_DIRECTION_KEYS].sort(), Object.keys(DIRECTION).sort());
  const inputs = inputsFromProject(project(DIRECTION));
  for (const [k, v] of Object.entries(DIRECTION)) assert.deepEqual(inputs[k], v, k);
});

test('absent fields stay absent (the Story Director schema defaults apply, nothing invented)', () => {
  const inputs = inputsFromProject(project());
  for (const k of STORY_DIRECTION_KEYS) assert.ok(!(k in inputs), k);
});

test('graph: the Story Director receives tone, setting, voice note and runtime from the project', async () => {
  const seen = [];
  const invoke = async (req) => { if (req.agent === 'story-director') seen.push(req.input); return JSON.stringify(json('good-stage-play.json')); };
  await buildGraph({ invoke, maxAttempts: 1 }).invoke({ inputs: inputsFromProject(project(DIRECTION)), approvedAssets: json('good-approved-assets.json') });
  assert.ok(seen.length >= 1);
  const sd = seen[0];
  assert.equal(sd.targetTotalRuntimeSec, 60);
  assert.equal(sd.settingSeed, DIRECTION.settingSeed);
  assert.equal(sd.voiceNoteTranscript, DIRECTION.voiceNoteTranscript);
  assert.equal(sd.toneDirectives.genre, 'emotional-journey');
  assert.equal(sd.toneDirectives.pacing, 'slow-burn');
});

test('direct selector: same fields arrive from state.inputs', () => {
  const sd = selectStoryDirectorInput({ inputs: { answers: { a: 1 }, ...DIRECTION } });
  assert.equal(sd.toneDirectives.genre, 'emotional-journey'); assert.equal(sd.targetTotalRuntimeSec, 60);
});
