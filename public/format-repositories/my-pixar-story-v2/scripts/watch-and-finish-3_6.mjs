#!/usr/bin/env node
import { waitForFlowJob } from './flow-queue.mjs';
import { copyFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const repoDir = '/Users/shaz/Projects/wiggly-my-pixar-story-studio/public/format-repositories/my-pixar-story-v2';
const runDir = join(repoDir, 'runs', 'r6-live');
const artifactDir = '/Users/shaz/.gemini/antigravity/brain/8574b48e-ceb5-4f27-bf76-83c6902bfcbe';

console.log('[watch-3.6] Waiting for panel-3_6-v3 in Flow Queue...');
const landed = await waitForFlowJob('panel-3_6-v3', { runId: 'r6-live', isPanel: true, timeoutMs: 1_800_000 });
console.log(`[watch-3.6] Landed Shot 3.6! Resolution: ${landed.width}x${landed.height} at ${landed.outputPath}`);

// 1. Copy to storyboard-panels
const panelsDir = join(runDir, 'storyboard-panels');
await mkdir(panelsDir, { recursive: true });
const targetPanel = join(panelsDir, '3.6.png');
await copyFile(landed.outputPath, targetPanel);
console.log(`[watch-3.6] Saved panel to ${targetPanel}`);

// 2. Copy to artifact dir
const artPanel = join(artifactDir, 'shot-3-6-panel.png');
await copyFile(landed.outputPath, artPanel);
console.log(`[watch-3.6] Saved artifact panel to ${artPanel}`);

// 3. Re-render Storyboard Sheets (Sheet 3)
console.log('[watch-3.6] Re-rendering storyboard sheets...');
execFileSync('node', ['scripts/render-storyboard-sheets.mjs'], { cwd: repoDir, stdio: 'inherit' });
console.log('[watch-3.6] Storyboard Sheet 3 updated successfully.');

// 4. Compile animatic preview
console.log('[watch-3.6] Compiling animatic preview with updated panels...');
execFileSync('node', [
  'scripts/build-animatic.mjs',
  '--run', 'r6-live',
  '--frames', join(runDir, 'storyboard-panels'),
  '--out', join(runDir, 'animatic_preview.mp4'),
], { cwd: repoDir, stdio: 'inherit' });

// 5. Mux with scored mix
console.log('[watch-3.6] Muxing animatic with scored orchestral mix...');
const previewMp4 = join(runDir, 'animatic_preview.mp4');
const scoredWav = join(runDir, 'scratch', 'scratch-mix-scored.wav');
const scoredMp4 = join(runDir, 'animatic_scored.mp4');

execFileSync('ffmpeg', [
  '-y',
  '-i', previewMp4,
  '-i', scoredWav,
  '-map', '0:v',
  '-map', '1:a',
  '-c:v', 'copy',
  '-c:a', 'aac',
  '-b:a', '192k',
  '-shortest',
  scoredMp4
], { cwd: repoDir, stdio: 'inherit' });

// 6. Copy to artifacts
const artAnimatic = join(artifactDir, 'shaz-for-mia-animatic.mp4');
const artAnimaticVo = join(artifactDir, 'shaz-for-mia-animatic-vo-only.mp4');
await copyFile(scoredMp4, artAnimatic);
await copyFile(previewMp4, artAnimaticVo);

console.log(`[watch-3.6] All artifacts successfully generated and updated in ${artifactDir}!`);
