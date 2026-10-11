// Regenerate tests/test-timings.json: run each tests/*.test.mjs file serially,
// record wall seconds (and test count from the TAP summary), write {file: seconds}.
// Usage: node tests/measure-timings.mjs [fast|slow|all]  (default all)
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allTestFiles, fastFiles, slowFiles } from './list-tests.mjs';

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const set = process.argv[2] ?? 'all';
const files = set === 'fast' ? fastFiles() : set === 'slow' ? slowFiles() : allTestFiles();
const timings = {};
let totalTests = 0;
for (const f of files) {
  const start = Date.now();
  const out = execFileSync('node', ['--test', '--test-reporter=tap', f], { cwd: kitRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const seconds = (Date.now() - start) / 1000;
  const pass = Number(/# pass (\d+)/.exec(out)?.[1] ?? NaN);
  const fail = Number(/# fail (\d+)/.exec(out)?.[1] ?? NaN);
  if (!Number.isFinite(pass) || fail !== 0) throw new Error(`${f}: unexpected TAP summary (pass=${pass} fail=${fail})`);
  timings[f] = Math.round(seconds * 10) / 10;
  totalTests += pass;
  console.log(`${seconds.toFixed(1).padStart(7)}s ${String(pass).padStart(3)} tests ${f}`);
}
const path = join(kitRoot, 'tests', 'test-timings.json');
if (set === 'all') {
  writeFileSync(path, `${JSON.stringify(Object.fromEntries(Object.entries(timings).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2)}\n`);
  console.log(`wrote ${path}`);
}
const serial = Object.values(timings).reduce((a, b) => a + b, 0);
console.log(`serial ${serial.toFixed(1)}s, ${totalTests} tests in ${files.length} files`);
