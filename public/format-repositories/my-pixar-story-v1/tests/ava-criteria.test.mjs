import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { criteria as contractsCriteria } from '../runtime/contracts.mjs';
import { filmAudioCriteria } from '../runtime/workflow.mjs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { send, file, produce } from './helpers.mjs';
import { ready, choice, draft, reviewEvent, humanApprove } from './helpers/existing-voice.mjs';

export function parseAvaExampleReview(skillText) {
  const section = skillText.split('## Example')[1] ?? '';
  const match = section.match(/```json\s*([\s\S]*?)\s*```/);
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

  const regex = /- `([a-z-]+)`[^:\n]*:.*?Criteria: ([^.]*)/g;
  let match;
  const parsedStages = {};
  
  while ((match = regex.exec(skillText)) !== null) {
    const stage = match[1];
    if (expectedStages[stage]) {
      const stageCriteria = match[2].split(',').map(s => s.replace(/`/g, '').replace(/\.$/, '').trim()).filter(Boolean);
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
  // The worked example is a narration review (provisional, voice-match
  // inconclusive), so bind it to a supervised narration review gate.
  let p = ready();
  p = send(p, 'set-budget', { actor: 'human', message: 'ISOLATED ceiling', budgetLimitUsd: 1 });
  p = produce(p, { files: [file(1)], voiceId: choice.voiceId, transcript: draft.beats[0].narration });
  p = send(p, 'review', { ...reviewEvent(p) });
  p = humanApprove(p);
  const beats = draft.beats.map(b => b.narration);
  const sourceFiles = [1, 2, 3, 4].map(n => file(n));
  p = produce(p, {
    sourceFiles,
    files: sourceFiles.map((f, i) => ({ ...f, sha256: String(900 + i).padStart(64, '0'), path: `/isolated-test/window-${i}.wav`, durationSeconds: 15 })),
    tailSilenceSeconds: sourceFiles.map(f => Math.max(0, 15 - f.durationSeconds)),
    voiceId: choice.voiceId, transcripts: beats, model: 'test-only'
  });
  const a = p.artifacts.findLast(a => a.valid);
  event.artifactId = a.id;
  event.artifactDigest = a.digest;
  event.workerId = 'audio-reviewer';
  event.review.coverage = {
    artifactSha256: a.content.files[0].sha256,
    audioFiles: a.content.files.map(f => ({ sha256: f.sha256, seconds: f.durationSeconds }))
  };
  // The skill's runtime fills tool-call measurements; bind them like a real turn would.
  event.review.measurements = {
    ...event.review.measurements,
    identityBasis: 'human-recognition',
    transcripts: beats,
    speechToTextMethod: 'ISOLATED mock STT',
    speakingRateWpm: [80, 80, 80, 80],
    silenceSeconds: [1, 1, 1, 1]
  };
  delete event.taskId;
  assert.doesNotThrow(() => send(p, 'review', event));
});
