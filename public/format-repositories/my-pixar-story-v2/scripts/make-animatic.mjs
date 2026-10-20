#!/usr/bin/env node
// Animatic Editor (deterministic). Usage:
//   node scripts/make-animatic.mjs --sd <story-director.json> --frames <dir of <shotId>.png> [--audio scratch.wav] [--out animatic_preview.mp4] [--allow-missing]
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { shotTimeline, animaticArgs } from './lib/animatic.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const raw = JSON.parse(await readFile(arg('--sd'), 'utf8')); const sd = raw.segments ? raw : raw.output ?? raw;
const dir = arg('--frames'); const files = await readdir(dir);
const tl = shotTimeline(sd); const missing = [];
const frames = tl.map((s) => { const f = files.find((x) => new RegExp(`^${s.shotId.replace('.', '\\.')}\\.(png|jpe?g|webp)$`, 'i').test(x)); if (!f) missing.push(s.shotId); return { ...s, path: f ? join(dir, f) : null }; });
if (missing.length && !process.argv.includes('--allow-missing')) { console.error(`missing frames: ${missing.join(', ')}`); process.exit(1); }
const { args, totalSec } = animaticArgs(frames, { audio: arg('--audio') ?? null, out: arg('--out', 'animatic_preview.mp4') });
execFileSync('ffmpeg', args, { stdio: 'inherit' });
console.log(`animatic: ${tl.length} shots, ${totalSec}s, ${missing.length} placeholders -> ${arg('--out', 'animatic_preview.mp4')}`);
