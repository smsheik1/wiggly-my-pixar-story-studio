#!/usr/bin/env node
// CLI utility for time-travel rewind and run branching.
// Replays events.jsonl from a previous run, projects state up to the target agent,
// and copies only upstream approved assets and outputs into a clean branched run.
//
// Usage:
//   node scripts/rewind-run.mjs --from runs/r6-live --to storyboard-artist --as runs/r6-sb-retry
//   node scripts/rewind-run.mjs --from runs/r6-live --to seedance-compiler --as runs/r6-sc-retry
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { rewindRun, readEvents } from '../graph/event-log.mjs';

function parseArgs(args = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (k.startsWith('--')) {
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      out[k.slice(2)] = val;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const from = args.from;
  const to = args.to || args.target;
  const as = args.as || args['new-run'] || args.dest;

  if (!from || !to || !as) {
    console.error('Usage: node scripts/rewind-run.mjs --from <sourceRunDir> --to <targetAgent> --as <newRunDir>');
    process.exit(1);
  }

  const srcDir = resolve(from);
  const newDir = resolve(as);

  if (!existsSync(srcDir)) {
    console.error(`Source run directory not found: ${srcDir}`);
    process.exit(1);
  }

  if (existsSync(newDir)) {
    console.error(`Destination run directory already exists: ${newDir}`);
    process.exit(1);
  }

  console.log(`Rewinding run ${from} to before "${to}"...`);
  const res = rewindRun({
    sourceRunDir: srcDir,
    targetAgent: to,
    newRunDir: newDir,
    log: console.log,
  });

  console.log(`\nSuccess! Branched run ready at: ${res.newRunDir}`);
  console.log(`Upstream completed agents preserved: ${res.projected.completedAgents.join(', ') || 'none'}`);
  console.log(`State status: ${res.newState.status}`);
}

main().catch((err) => {
  console.error(`Rewind failed: ${err.message}`);
  process.exit(1);
});
