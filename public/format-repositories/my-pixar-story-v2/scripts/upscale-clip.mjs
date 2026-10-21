#!/usr/bin/env node
// On-demand 1080p upscaler for chosen winning clips via Modal SeedVR2.
// Per product guardrail: do NOT run automatically on every generation.
// Run ONLY upon user discretion when they pick their favorite clip.
//
// Usage:
//   node scripts/upscale-clip.mjs --input ~/Movies/clip.mp4 [--out ~/Movies/clip-1080p.mp4]
import { existsSync } from 'node:fs';
import { resolve, parse } from 'node:path';
import { spawn } from 'node:child_process';

const arg = (flag, fallback = null) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};

const inputPath = arg('--input');
if (!inputPath) {
  console.error('Usage: node scripts/upscale-clip.mjs --input <path-to-clip.mp4> [--out <output-1080p.mp4>]');
  process.exit(1);
}

const absInput = resolve(inputPath.replace(/^~(?=$|\/)/, process.env.HOME || ''));
if (!existsSync(absInput)) {
  console.error(`Error: input video does not exist at ${absInput}`);
  process.exit(1);
}

const parsed = parse(absInput);
const defaultOut = resolve(parsed.dir, `${parsed.name}-1080p${parsed.ext || '.mp4'}`);
const outArg = arg('--out');
const absOut = outArg ? resolve(outArg.replace(/^~(?=$|\/)/, process.env.HOME || '')) : defaultOut;

const modalAppPath = resolve(arg('--modal-app', '/Users/shaz/Documents/wiggly/seedvr/app2.py'));
if (!existsSync(modalAppPath)) {
  console.error(`Error: Modal app2.py not found at ${modalAppPath}`);
  process.exit(1);
}

console.log(`[upscale] Starting on-demand 1080p upscale via Modal SeedVR2:`);
console.log(`  Input:     ${absInput}`);
console.log(`  Output:    ${absOut}`);
console.log(`  Modal App: ${modalAppPath}`);

const modalBin = 'modal';
const child = spawn(modalBin, ['run', modalAppPath, '--input', absInput, '--out', absOut], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PATH: `${process.env.PATH || ''}:/Users/shaz/.local/bin:/Users/shaz/Library/Python/3.14/bin`,
  },
});

child.on('error', (err) => {
  console.error('[upscale] Failed to spawn modal process:', err.message);
  process.exit(1);
});

child.on('close', (code) => {
  if (code === 0) {
    console.log(`[upscale] Successfully upscaled clip to 1080p with audio remuxed: ${absOut}`);
    process.exit(0);
  } else {
    console.error(`[upscale] Modal upscale exited with code ${code}`);
    process.exit(code ?? 1);
  }
});
