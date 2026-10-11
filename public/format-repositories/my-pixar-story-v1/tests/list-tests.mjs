// One source of truth for the fast/slow test split (used by package.json and ci.yml).
// Usage: node tests/list-tests.mjs <fast|slow|all> [--shard i/N] [--estimate N]
// Prints one tests/*.test.mjs path per line (relative to the kit root).
// --shard i/N prints only shard i (1-based) of the set, assigned by greedy
// longest-first bin packing from tests/test-timings.json (missing entries weigh 1s,
// so new files are still assigned to exactly one shard). --estimate N prints the
// estimated seconds per shard instead of file lists.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_WEIGHT = 1; // seconds, for files missing from the timing table

export function allTestFiles() {
  return readdirSync(join(kitRoot, 'tests'))
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => `tests/${f}`)
    .sort();
}

export function slowFiles() {
  const manifest = JSON.parse(readFileSync(join(kitRoot, 'tests', 'slow-tests.json'), 'utf8'));
  return [...manifest.files].sort();
}

export function fastFiles() {
  const slow = new Set(slowFiles());
  return allTestFiles().filter((f) => !slow.has(f));
}

export function weights() {
  const path = join(kitRoot, 'tests', 'test-timings.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Greedy longest-first bin packing: heaviest file goes to the lightest shard.
// Deterministic: files sorted by (-weight, name), ties broken by lowest shard index.
export function assignShards(files, n, timingTable) {
  const totals = Array(n).fill(0);
  const shards = Array.from({ length: n }, () => []);
  const byWeight = [...files].sort((a, b) => {
    const d = (timingTable[b] ?? DEFAULT_WEIGHT) - (timingTable[a] ?? DEFAULT_WEIGHT);
    return d !== 0 ? d : a < b ? -1 : 1;
  });
  for (const f of byWeight) {
    let lightest = 0;
    for (let i = 1; i < n; i++) if (totals[i] < totals[lightest]) lightest = i;
    shards[lightest].push(f);
    totals[lightest] += timingTable[f] ?? DEFAULT_WEIGHT;
  }
  return { shards: shards.map((s) => s.sort()), totals };
}

function parseShard(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(spec);
  if (!m) throw new Error(`bad --shard ${spec}, want i/N`);
  const i = Number(m[1]);
  const n = Number(m[2]);
  if (i < 1 || i > n || n < 1) throw new Error(`shard ${i} out of range 1..${n}`);
  return { i, n };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
const [set = '', ...rest] = process.argv.slice(2);
if (!['fast', 'slow', 'all'].includes(set)) {
  console.error('usage: node tests/list-tests.mjs <fast|slow|all> [--shard i/N] [--estimate N]');
  process.exit(2);
}
const files = set === 'fast' ? fastFiles() : set === 'slow' ? slowFiles() : allTestFiles();
let shardArg;
let estimateArg;
for (let k = 0; k < rest.length; k++) {
  if (rest[k] === '--shard') shardArg = rest[++k];
  else if (rest[k] === '--estimate') estimateArg = rest[++k];
  else throw new Error(`unknown arg ${rest[k]}`);
}
if (shardArg && estimateArg) throw new Error('use only one of --shard, --estimate');
if (estimateArg) {
  const n = Number(estimateArg);
  if (!Number.isInteger(n) || n < 1) throw new Error(`bad --estimate ${estimateArg}`);
  const { shards, totals } = assignShards(files, n, weights());
  shards.forEach((s, idx) => console.log(`shard ${idx + 1}/${n}: ${totals[idx].toFixed(1)}s ${s.length} files`));
} else if (shardArg) {
  const { i, n } = parseShard(shardArg);
  const { shards } = assignShards(files, n, weights());
  for (const f of shards[i - 1]) console.log(f);
} else {
  for (const f of files) console.log(f);
}
}
