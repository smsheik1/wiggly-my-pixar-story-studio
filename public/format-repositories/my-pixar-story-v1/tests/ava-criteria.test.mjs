import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { criteria as contractsCriteria } from '../runtime/contracts.mjs';
import { filmAudioCriteria } from '../runtime/workflow.mjs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { send } from './helpers.mjs';
import { audition, choice } from './helpers/existing-voice.mjs';

export function parseAvaExampleReview(skillText) {
  const match = skillText.match(/### Output Review Event:\s*```json\s*([\s\S]*?)\s*```/);
  if (!match) throw new Error('Could not find Output Review Event in Ava SKILL.md');
  return JSON.parse(match[1]);
}

test('Ava SKILL.md criteria match runtime', () => {
  const skillPath = process.env.AVA_SKILL_PATH || join(fileURLToPath(new URL('.', import.meta.url)), '../crew/ava/SKILL.md');
  const skillText = readFileSync(skillPath, 'utf8');

  const expectedStages = {
    audition: contractsCriteria.audition,
    narration: contractsCriteria.narration,
    music: contractsCriteria.music,
    effect: contractsCriteria.effect,
    film: filmAudioCriteria
  };

  const regex = /- `([a-z]+)`:\s*(.*)/g;
  let match;
  const parsedStages = {};
  
  while ((match = regex.exec(skillText)) !== null) {
    const stage = match[1];
    if (expectedStages[stage]) {
      const stageCriteria = match[2].split(',').map(s => s.replace(/`/g, '').trim());
      parsedStages[stage] = stageCriteria;
    }
  }

  for (const [stage, expected] of Object.entries(expectedStages)) {
    assert(parsedStages[stage], `SKILL.md must define criteria for stage: ${stage}`);
    assert.deepEqual(parsedStages[stage].sort(), [...expected].sort(), `Criteria for ${stage} in SKILL.md does not match runtime.`);
  }
});

test('Ava SKILL.md example review validates against runtime review rules', () => {
  const skillPath = process.env.AVA_SKILL_PATH || join(fileURLToPath(new URL('.', import.meta.url)), '../crew/ava/SKILL.md');
  const skillText = readFileSync(skillPath, 'utf8');
  const event = parseAvaExampleReview(skillText);
  const p = audition();
  const p2 = structuredClone(p);
  p2.jobs[0].request = { voice: choice.voiceId };
  p2.jobs[0].result = { voiceId: choice.voiceId };
  const a = p2.artifacts.findLast(a => a.valid);
  event.artifactId = a.id;
  event.artifactDigest = a.digest;
  event.workerId = 'audio-reviewer';
  event.review.coverage = {
    artifactSha256: a.content.files[0].sha256,
    audioFiles: a.content.files.map(f => ({ sha256: f.sha256, seconds: f.durationSeconds }))
  };
  event.review.measurements.transcripts = [p2.artifacts.find(a => a.kind === 'script').content.beats[0].narration];
  delete event.taskId;
  assert.doesNotThrow(() => send(p2, 'review', event));
});
