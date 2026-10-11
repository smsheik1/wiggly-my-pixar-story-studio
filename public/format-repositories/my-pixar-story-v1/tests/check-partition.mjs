// Partition guard: every tests/*.test.mjs file must belong to exactly one of the
// fast/slow sets (fast = glob minus the slow manifest), every manifest entry must
// exist, and every *.slow.test.mjs file must be listed in the manifest (otherwise it
// would silently land in the fast set). Also checks expected-counts.json adds up.
// Usage: node tests/check-partition.mjs. Runs in CI on every PR (pure node, no deps).
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allTestFiles, slowFiles } from './list-tests.mjs';

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const all = allTestFiles();
const manifest = slowFiles();
const slowSet = new Set(manifest);

if (manifest.length !== slowSet.size) failures.push('slow-tests.json lists a file twice (it would run twice)');
for (const f of manifest) {
  if (!existsSync(join(kitRoot, f))) failures.push(`manifest entry missing on disk: ${f}`);
  if (!f.startsWith('tests/') || !f.endsWith('.test.mjs')) failures.push(`manifest entry is not a tests/*.test.mjs file: ${f}`);
}
for (const f of all) {
  if (f.endsWith('.slow.test.mjs') && !slowSet.has(f)) {
    failures.push(`${f} ends with .slow.test.mjs but is not in slow-tests.json (it would run in the fast suite)`);
  }
}
const fast = all.filter((f) => !slowSet.has(f));
if (slowSet.size + fast.length !== all.length) failures.push('a file is in neither or both sets');
for (const f of manifest) {
  if (!all.includes(f)) failures.push(`manifest entry is not matched by tests/*.test.mjs: ${f}`);
}

const counts = JSON.parse(readFileSync(join(kitRoot, 'tests', 'expected-counts.json'), 'utf8'));
if (counts.fast + counts.slow !== counts.total) {
  failures.push(`expected-counts.json does not add up: ${counts.fast}+${counts.slow}!=${counts.total}`);
}

if (failures.length > 0) {
  for (const f of failures) console.error(`partition error: ${f}`);
  process.exit(1);
}
console.log(`partition OK: ${fast.length} fast + ${manifest.length} slow = ${all.length} files, expected ${counts.fast}+${counts.slow}=${counts.total} tests`);
