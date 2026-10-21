#!/usr/bin/env node
// Unified Animatic Builder: generates Cartesia scratch audio stems, places them on the paced timeline,
// gathers or slices storyboard panels, and compiles animatic_preview.mp4 with exact shot cut timings.
//
// Usage:
//   node scripts/build-animatic.mjs --run <runId> [--out animatic.mp4] [--secrets <file>]
//   node scripts/build-animatic.mjs --sd <story-director.json> --out <animatic.mp4> [--frames <dir>] [--voices <voices.json>]

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { loadSecrets, defaultSecretsPath } from './lib/secrets.mjs';
import { shotTimeline, pacedTimeline, animaticArgs } from './lib/animatic.mjs';
import { scratchLines, ttsTranscript, estimateUsd, oddities, mixArgs, speechSpan, placeLines } from './lib/scratch-audio.mjs';

const MODEL = 'sonic-3.6-2026-08-27';
const VERSION = '2026-08-14';
const DEFAULT_CAP_USD = 0.50;

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };

export async function buildAnimatic({
  sd,
  runDir,
  outPath,
  voices = {},
  framesDir,
  secretsPath = defaultSecretsPath(),
  maxUsd = DEFAULT_CAP_USD,
  allowMissingFrames = true,
} = {}) {
  const stagePlay = sd.segments ? sd : sd.output ?? sd;
  if (!stagePlay?.segments?.length) throw new Error('buildAnimatic: storyDirector stage play has no segments');

  const timeline = shotTimeline(stagePlay);
  console.log(`[animatic] Script loaded: ${stagePlay.segments.length} segment(s), ${timeline.length} shot(s), planned ${timeline.reduce((a, s) => a + s.durationSec, 0)}s`);

  // 1. Audio track preparation
  let finalAudioPath = null;
  let finalTimeline = timeline;
  const lines = scratchLines(stagePlay);

  if (lines.length && Object.keys(voices).length) {
    const scratchDir = join(runDir, 'scratch');
    const linesDir = join(scratchDir, 'lines');
    await mkdir(linesDir, { recursive: true });

    const linePath = (l, i) => join(linesDir, `${String(i + 1).padStart(2, '0')}-${l.shotId}-${l.kind}.wav`);
    const isCached = (l, i) => existsSync(linePath(l, i)) && statSync(linePath(l, i)).size >= 1000;
    const todo = lines.filter((l, i) => !isCached(l, i));
    const est = estimateUsd(todo);

    console.log(`[animatic] Scratch audio: ${lines.length} lines total (${todo.length} to synthesize, est $${est.toFixed(4)})`);
    if (est > maxUsd) throw new Error(`[animatic] STOP: estimated TTS cost $${est.toFixed(4)} exceeds cap $${maxUsd}`);

    let key = null;
    if (todo.length) {
      try {
        key = loadSecrets(secretsPath, (n) => n === 'CARTESIA_API_KEY').CARTESIA_API_KEY;
      } catch (err) {
        console.warn(`[animatic] Warning: could not load CARTESIA_API_KEY (${err.message}). Existing cached audio will be used if available.`);
      }
    }

    const probe = (p) => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).toString();
    const spawnErr = (p) => spawnSync('ffmpeg', ['-hide_banner', '-i', p, '-af', 'silencedetect=n=-40dB:d=0.15', '-f', 'null', '-']).stderr.toString();

    const measured = [];
    for (const [i, l] of lines.entries()) {
      const p = linePath(l, i);
      const voiceId = voices[l.speaker];

      if (!existsSync(p) || (await stat(p)).size < 1000) {
        if (!voiceId) {
          console.warn(`[animatic] Missing voice ID for speaker '${l.speaker}' on line ${i + 1}; skipping synthesis`);
          continue;
        }
        if (!key) {
          console.warn(`[animatic] CARTESIA_API_KEY missing; line ${i + 1} uncached`);
          continue;
        }
        const r = await fetch('https://api.cartesia.ai/tts/bytes', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': VERSION, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model_id: MODEL,
            transcript: ttsTranscript(l.text),
            voice: { mode: 'id', id: voiceId },
            language: 'en',
            output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 },
          }),
        });
        if (!r.ok) {
          throw new Error(`[animatic] Cartesia TTS error ${r.status} on line ${i + 1} (${l.shotId}): ${(await r.text()).slice(0, 200)}`);
        }
        await writeFile(p, Buffer.from(await r.arrayBuffer()));
      }

      if (existsSync(p)) {
        const durSec = probe(p);
        measured.push({ ...l, path: p, durSec, ...speechSpan(spawnErr(p), durSec) });
      }
    }

    if (measured.length) {
      const placedRes = placeLines(stagePlay, measured);
      finalTimeline = placedRes.timeline;
      finalAudioPath = join(scratchDir, 'scratch-mix.wav');
      execFileSync('ffmpeg', mixArgs(placedRes.placed, placedRes.totalSec, finalAudioPath));

      const report = {
        lines: placedRes.placed.length,
        speechSec: +placedRes.placed.reduce((a, l) => a + l.speechSec, 0).toFixed(2),
        filmSec: placedRes.totalSec,
        timeline: finalTimeline.map(({ shotId, plannedSec, durationSec, timelineStartSec }) => ({ shotId, plannedSec, durationSec, timelineStartSec })),
      };
      await writeFile(join(scratchDir, 'scratch-report.json'), JSON.stringify(report, null, 2));
      console.log(`[animatic] Scratch mix assembled: ${finalAudioPath} (${placedRes.totalSec}s)`);
    }
  }

  // 2. Gather visual frames
  const availableFiles = framesDir && existsSync(framesDir) ? readdirSync(framesDir) : [];
  const missingShots = [];
  const frames = finalTimeline.map((s) => {
    const f = availableFiles.find((x) => new RegExp(`^${s.shotId.replace('.', '\\.')}\\.(png|jpe?g|webp)$`, 'i').test(x));
    if (!f) missingShots.push(s.shotId);
    return { ...s, path: f ? join(framesDir, f) : null };
  });

  if (missingShots.length) {
    if (!allowMissingFrames) throw new Error(`[animatic] Missing frames for shots: ${missingShots.join(', ')}`);
    console.log(`[animatic] Notice: ${missingShots.length} shot(s) missing panel frames; rendering clean placeholders for: ${missingShots.join(', ')}`);
  }

  // 3. Compile the animatic video via FFmpeg
  const targetOut = outPath ?? join(runDir, 'animatic_preview.mp4');
  const { args, totalSec } = animaticArgs(frames, { audio: finalAudioPath, out: targetOut });
  execFileSync('ffmpeg', args, { stdio: 'inherit' });

  // 4. Record approved shot timings
  const approvedShotTimings = finalTimeline.map((s) => ({
    shotId: s.shotId,
    startSec: s.timelineStartSec,
    endSec: +(s.timelineStartSec + s.durationSec).toFixed(3),
    durationSec: s.durationSec,
  }));
  await writeFile(join(runDir, 'approvedShotTimings.json'), JSON.stringify(approvedShotTimings, null, 2));

  console.log(`[animatic] COMPLETE: ${targetOut} (${totalSec}s, ${frames.length} shots)`);
  return { outPath: targetOut, totalSec, approvedShotTimings, missingShots };
}

// CLI execution
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename ?? '')) {
  const runId = arg('--run');
  const runsRoot = arg('--runs-root', '/Users/shaz/wt-v2/public/format-repositories/my-pixar-story-v2/runs');
  const runDir = runId ? join(runsRoot, runId) : process.cwd();

  const sdPath = arg('--sd', join(runDir, 'outputs', 'story-director.json'));
  if (!existsSync(sdPath)) {
    console.error(`Error: Story Director output not found at ${sdPath}`);
    process.exit(1);
  }
  const sd = JSON.parse(await readFile(sdPath, 'utf8'));

  // Voices
  let voices = {};
  const voicesPath = arg('--voices', join(runDir, 'scratch', 'voices.json'));
  if (existsSync(voicesPath)) {
    voices = JSON.parse(await readFile(voicesPath, 'utf8'));
  }

  // Frames dir
  const framesDir = arg('--frames', join(runDir, 'panels'));
  const outPath = arg('--out', join(runDir, 'animatic_preview.mp4'));

  await buildAnimatic({
    sd,
    runDir,
    outPath,
    voices,
    framesDir,
    secretsPath: arg('--secrets') ?? defaultSecretsPath(),
    maxUsd: +arg('--max-usd', String(DEFAULT_CAP_USD)),
    allowMissingFrames: true,
  });
}
