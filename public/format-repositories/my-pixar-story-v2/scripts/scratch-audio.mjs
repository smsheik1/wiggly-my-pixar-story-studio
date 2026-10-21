#!/usr/bin/env node
// Scratch audio for the animatic: Cartesia TTS for every narration / dialogue line in an SD output, each placed at its
// shot's start on the film timeline, mixed to one WAV. Timing follows the scratch track: each spoken shot lasts its speech
// plus a beat, silent shots keep their planned length (capped unless a hold). The paced timeline is written to
// scratch-report.json (timeline[]) and make-animatic --timing uses it. Cached lines cost nothing and need no key.
// Usage: node scripts/scratch-audio.mjs --sd <story-director.json> --voices <voices.json> --out <dir> [--max-usd 0.5] [--secrets <file>]
//   voices.json: { "<@Tag>": "<cartesia voice id>", ... } (speaker tags from the SD). Audio stays out of git.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadSecrets, defaultSecretsPath } from './lib/secrets.mjs';
import { scratchLines, ttsTranscript, estimateUsd, oddities, mixArgs, speechSpan, placeLines } from './lib/scratch-audio.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const MODEL = 'sonic-3.6-2026-08-27', VERSION = '2026-08-14'; // v1 studio.json generation.voice
const raw = JSON.parse(await readFile(arg('--sd'), 'utf8')); const sd = raw.segments ? raw : raw.output;
const voices = JSON.parse(await readFile(arg('--voices'), 'utf8'));
const out = arg('--out'); const maxUsd = +arg('--max-usd', '0.5'); await mkdir(join(out, 'lines'), { recursive: true });
const lines = scratchLines(sd);
const missing = [...new Set(lines.map((l) => l.speaker))].filter((s) => !voices[s]);
if (missing.length) throw new Error(`no voice for ${missing.join(', ')} in --voices`);
const linePath = (l, i) => join(out, 'lines', `${String(i + 1).padStart(2, '0')}-${l.shotId}-${l.kind}.wav`);
const cached = (l, i) => existsSync(linePath(l, i)) && statSync(linePath(l, i)).size >= 1000;
const todo = lines.filter((l, i) => !cached(l, i)); // only uncached lines are billed
const est = estimateUsd(todo);
console.log(`${lines.length} lines (${todo.length} to generate, ${todo.reduce((n, l) => n + l.text.length, 0)} chars), estimate $${est.toFixed(4)} (cap $${maxUsd})`);
if (est > maxUsd) { console.error('STOP: estimate exceeds the cap; nothing generated'); process.exit(3); }
const key = todo.length ? loadSecrets(arg('--secrets') ?? defaultSecretsPath(), (n) => n === 'CARTESIA_API_KEY').CARTESIA_API_KEY : null;
if (todo.length && !key) throw new Error('CARTESIA_API_KEY missing');
const probe = (p) => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).toString();
const spawnErr = (p) => spawnSync('ffmpeg', ['-hide_banner', '-i', p, '-af', 'silencedetect=n=-40dB:d=0.15', '-f', 'null', '-']).stderr.toString();
const measured = [];
for (const [i, l] of lines.entries()) {
  const path = join(out, 'lines', `${String(i + 1).padStart(2, '0')}-${l.shotId}-${l.kind}.wav`);
  if (!existsSync(path) || (await stat(path)).size < 1000) {
    const r = await fetch('https://api.cartesia.ai/tts/bytes', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: MODEL, transcript: ttsTranscript(l.text), voice: { mode: 'id', id: voices[l.speaker] }, language: 'en', output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 } }) });
    if (!r.ok) { console.error(`STOP: Cartesia ${r.status} on line ${i + 1} (${l.shotId}): ${(await r.text()).slice(0, 200)}`); process.exit(4); }
    await writeFile(path, Buffer.from(await r.arrayBuffer()));
  }
  const durSec = probe(path); measured.push({ ...l, path, durSec, ...speechSpan(spawnErr(path), durSec) });
}
const { timeline, placed, totalSec: total } = placeLines(sd, measured);
execFileSync('ffmpeg', mixArgs(placed, total, join(out, 'scratch-mix.wav')));
const planned = timeline.reduce((a, t) => a + t.plannedSec, 0);
const rep = { lines: placed.length, chars: lines.reduce((n, l) => n + l.text.length, 0), estimateUsd: +est.toFixed(5), speechSec: +placed.reduce((a, l) => a + l.speechSec, 0).toFixed(2), plannedSec: planned, filmSec: total,
  mixSec: probe(join(out, 'scratch-mix.wav')), timeline: timeline.map(({ shotId, plannedSec, durationSec, timelineStartSec }) => ({ shotId, plannedSec, durationSec, timelineStartSec })), oddities: placed.map((l) => ({ shotId: l.shotId, odd: oddities(l.text) })).filter((x) => x.odd.length),
  placed: placed.map(({ path, ...l }) => ({ ...l, file: path.split('/').pop(), durSec: +l.durSec.toFixed(2) })) };
await writeFile(join(out, 'scratch-report.json'), JSON.stringify(rep, null, 2));
console.log(JSON.stringify({ ...rep, placed: undefined, timeline: undefined }, null, 1));
