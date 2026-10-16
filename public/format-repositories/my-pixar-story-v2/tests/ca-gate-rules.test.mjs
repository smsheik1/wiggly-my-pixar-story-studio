import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHILD_TOKENS } from '../crew/linter/check-character-sheets.mjs';

const role = readFileSync(new URL('../crew/character-architect/role.md', import.meta.url), 'utf8');

test('CA role.md lists every gate child-proportion token as banned for adults', () => {
  const line = role.split('\n').find((l) => l.includes('BOBBLEHEAD_ADULT_VIOLATION'));
  assert.ok(line, 'role.md is missing the BOBBLEHEAD_ADULT_VIOLATION rule');
  assert.match(line, /never write/i);
  assert.ok(CHILD_TOKENS.length > 0);
  for (const t of CHILD_TOKENS) assert.ok(line.toLowerCase().includes(`"${t}"`), `role.md rule is missing gate token "${t}"`);
  assert.match(line, /CHILD_TOKENS/);
});

test('CA role.md has the empty-hands gate rule', () => {
  const line = role.split('\n').find((l) => l.includes('HELD_OBJECT_VIOLATION'));
  assert.ok(line, 'role.md is missing the HELD_OBJECT_VIOLATION rule');
  assert.match(line, /hands are always empty/i);
  assert.match(line, /nothing is held, carried/i);
});
