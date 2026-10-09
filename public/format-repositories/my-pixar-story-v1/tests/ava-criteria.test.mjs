import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { criteria as contractsCriteria, Event, Review } from '../runtime/contracts.mjs';
import { filmAudioCriteria } from '../runtime/workflow.mjs';

import { fileURLToPath } from 'node:url';
import test from 'node:test';

export function parseAvaExampleReview(skillText) {
  const match = skillText.match(/### Output Review Event:\s*```json\s*([\s\S]*?)\s*```/);
  if (!match) throw new Error('Could not find Output Review Event in Ava SKILL.md');
  return JSON.parse(match[1]);
}

export function validateAuditionReviewEvent(event) {
  // 1. Must parse as valid Event contract (rejects invalid actors like 'crew-worker')
  Event.parse(event);

  // 2. Runtime required actor for review deliverables is 'reviewer'
  assert.equal(event.action, 'review', "action must be 'review'");
  assert.equal(event.actor, 'reviewer', "actor must be 'reviewer' for review action");

  // 3. Must parse as valid Review contract
  assert.ok(event.review, "event must contain review object");
  Review.parse(event.review);

  // 4. Measurements schema check: truePeakDb and integratedLufs are not in Review.measurements schema and belong in evidence
  if (event.review.measurements) {
    const allowedMeasurementKeys = new Set(Object.keys(Review.shape.measurements._def.innerType.shape));
    for (const key of Object.keys(event.review.measurements)) {
      assert.ok(allowedMeasurementKeys.has(key), `Measurement key "${key}" is not part of the review schema; move to evidence text`);
    }
  }

  // 5. Must have exactly all required criteria for audition
  const required = contractsCriteria.audition;
  const checks = event.review.checks;
  const checkCriteria = checks.map(c => c.criterion);
  assert.deepEqual(checkCriteria.sort(), [...required].sort(), 'audition checks must match criteria.audition exactly');

  // 6. Direct perception for audition must be 'direct-audio'
  assert.equal(event.review.perception, 'direct-audio', "audition review perception must be 'direct-audio'");

  // 7. For supervised mode / existing clone auditions:
  // Voice match must be inconclusive with identityBasis: "human-recognition" and no invented similarity score (workflow.mjs ~478)
  const identity = checks.find(c => c.criterion === 'voice-match');
  const m = event.review.measurements;
  if (m?.referenceSha256 !== undefined || m?.speakerSimilarity !== undefined || m?.speakerSimilarityMethod !== undefined || (m?.identityBasis !== undefined && m.identityBasis !== 'human-recognition') || identity?.status === 'pass') {
    throw new Error('HUMAN_VOICE_IDENTITY_REQUIRED: no original reference; never invent speaker similarity, source hashes or an automated identity pass.');
  }
  if (['approved', 'provisional'].includes(event.review.decision) && (identity?.status !== 'inconclusive' || m?.identityBasis !== 'human-recognition')) {
    throw new Error('HUMAN_VOICE_IDENTITY_REQUIRED: use supervised human recognition without an original recording.');
  }
  assert.doesNotMatch(identity.evidence, /\b(0\.\d+|\d+%\s*similarity)\b/i, 'voice-match evidence must not include invented similarity scores');

  return true;
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
  assert.doesNotThrow(() => validateAuditionReviewEvent(event));
});
