import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { criteria as contractsCriteria } from '../runtime/contracts.mjs';
import { filmAudioCriteria } from '../runtime/workflow.mjs';

import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Ava SKILL.md criteria match runtime', () => {
  const skillPath = join(fileURLToPath(new URL('.', import.meta.url)), '../crew/ava/SKILL.md');
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
