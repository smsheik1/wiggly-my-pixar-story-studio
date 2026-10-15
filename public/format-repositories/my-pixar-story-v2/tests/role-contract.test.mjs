import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StagePlay } from '../crew/story-director/schema.mjs';

const role = readFileSync(new URL('../crew/story-director/role.md', import.meta.url), 'utf8');
test('role.md documents every top-level contract key', () => {
  for (const k of Object.keys(StagePlay.shape)) assert.ok(role.includes(`"${k}"`), `role.md missing ${k}`);
});
test('role.md keeps family rules and Nano Banana storyboard', () => {
  for (const s of ['hijab', 'depicted and described as 18', 'Shaz has no son', 'Nano Banana 2.1', '30 s', 'One shot = one cut'])
    assert.ok(role.includes(s), s);
  assert.ok(!/GPT Image/i.test(role));
});
