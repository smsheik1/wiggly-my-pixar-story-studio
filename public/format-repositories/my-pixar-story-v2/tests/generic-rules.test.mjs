// Wiggly is a format for any family. Rules and code must not carry one family's details (the test family's names,
// objects, places or habits). Test fixtures may keep them only as input data; this test covers rules and code only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const FAMILY_STRINGS = [
  /\bshaz\b/i, /dadshaz/i, /\bMia\b/, /yu-?gi-?oh/i, /\bhonda\b/i, /\baccord coupe\b/i, /sunglasses/i, /\b50\s?k\b/i,
  /\bmaxims?\b/i, /eight o.clock/i, /\b8\s?pm\b/i, /every tuesday/i, /\bdisney\b/i, /\bchicago\b/i, /\bdallas\b/i, /facetime/i,
];
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const RULE_AND_CODE = [
  ...walk(join(ROOT, 'crew')).filter((f) => /\.(md|mjs)$/.test(f)),
  ...walk(join(ROOT, 'shared')).filter((f) => f.endsWith('.md')),
  ...walk(join(ROOT, 'config')).filter((f) => f.endsWith('.mjs')),
  ...walk(join(ROOT, 'graph')).filter((f) => f.endsWith('.mjs')),
];

test('the scan covers every role file, the shared rubric and the linter', () => {
  const rel = RULE_AND_CODE.map((f) => relative(ROOT, f));
  for (const f of ['crew/story-director/3-script-writer.md', 'crew/character-architect/role.md', 'crew/location-scout/role.md', 'crew/seedance-compiler/role.md',
    'shared/writing-tells.md', 'crew/linter/check-stage-play.mjs', 'crew/linter/check-seedance-prompts.mjs', 'crew/linter/writing-tells.mjs'])
    assert.ok(rel.includes(f), f);
});
test('no family-specific strings in role files, shared rubric, linter, schemas, config or graph', () => {
  const hits = [];
  for (const f of RULE_AND_CODE) readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    for (const re of FAMILY_STRINGS) if (re.test(line)) hits.push(`${relative(ROOT, f)}:${i + 1} ${re} :: ${line.trim().slice(0, 120)}`);
  });
  assert.deepEqual(hits, []);
});
test('the family-string list itself catches what it should', () => {
  for (const s of ['Shaz has no son', "@DadShaz", 'story for Mia', 'Yugioh cards', 'the 2000 Honda Accord Coupe', 'sunglasses pushed up', 'a 50k salary', "four maxims", "eight o'clock", 'every Tuesday at 8pm'])
    assert.ok(FAMILY_STRINGS.some((re) => re.test(s)), s);
  for (const s of ['Maximum ONE sign', 'in accordance with', 'Miami', 'Wren', 'Theo', 'goggles pushed up'])
    assert.ok(!FAMILY_STRINGS.some((re) => re.test(s)), s);
});
test('Seedance gate: any signature accessory from the cast cards (not one named object) is caught in [SHOTS] text', async () => {
  const { accessoryWords } = await import('../crew/linter/check-seedance-prompts.mjs');
  const a = accessoryWords([{ elementTag: '@Theo', signatureAccent: 'red knitted cap pushed back on his head' }, { elementTag: '@Gran', signatureAccent: 'silver hoop earrings' }, { elementTag: '@X' }]);
  assert.deepEqual(a.map((x) => [x.tag, x.word]), [['@Theo', 'cap'], ['@Gran', 'earrings']]);
  assert.ok(a[0].re.test('Medium on Theo, cap askew, grinning')); assert.ok(a[1].re.test('her earring catches the light')); assert.ok(!a[0].re.test('Theo captures the moment'));
});
