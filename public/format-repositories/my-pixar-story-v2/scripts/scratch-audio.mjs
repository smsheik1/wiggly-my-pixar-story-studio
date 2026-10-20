#!/usr/bin/env node
// Scratch audio for the animatic: Cartesia TTS for every narration / dialogue line in an SD output, each placed at its
// shot's start on the film timeline, mixed to one WAV of the full film length. Lines are never time-stretched; a line
// longer than its shot overlaps the next and is listed as an overrun (pacing info).
// Usage: node scripts/scratch-audio.mjs --sd <story-director.json> --voices <voices.json> --out <dir> [--max-usd 0.5] [--secrets <file>]
//   voices.json: { "<@Tag>": "<cartesia voice id>", ... } (speaker tags from the SD). Audio stays out of git.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadSecrets, defaultSecretsPath } from './lib/secrets.mjs';
import { scratchLines, estimateUsd, oddities, overruns, mixArgs } from './lib/scratch-audio.mjs';
import { shotTimeline } from './lib/animatic.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const MODEL = 'sonic-3.6-2026-08-27', VERSION = '2026-08-14'; // v1 studio.json generation.voice
const raw = JSON.parse(await readFile(arg('--sd'), 'utf8')); const sd = raw.segments ? raw : raw.output;
const voices = JSON.parse(await readFile(arg('--voices'), 'utf8'));
const out = arg('--out'); const maxUsd = +arg('--max-usd', '0.5'); await mkdir(join(out, 'lines'), { recursive: true });
const lines = scratchLines(sd);
const missing = [...new Set(lines.map((l) => l.speaker))].filter((s) => !voices[s]);
if (missing.length) throw new Error(`no voice for ${missing.join(', ')} in --voices`);
const est = estimateUsd(lines);
console.log(`${lines.length} lines, ${lines.reduce((n, l) => n + l.text.length, 0)} chars, estimate $${est.toFixed(4)} (cap $${maxUsd})`);
if (est > maxUsd) { console.error('STOP: estimate exceeds the cap; nothing generated'); process.exit(3); }
const key = loadSecrets(arg('--secrets') ?? defaultSecretsPath(), (n) => n === 'CARTESIA_API_KEY').CARTESIA_API_KEY;
if (!key) throw new Error('CARTESIA_API_KEY missing');
const probe = (p) => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).toString();
const placed = [];
for (const [i, l] of lines.entries()) {
  const path = join(out, 'lines', `${String(i + 1).padStart(2, '0')}-${l.shotId}-${l.kind}.wav`);
  if (!existsSync(path) || (await stat(path)).size < 1000) {
    const r = await fetch('https://api.cartesia.ai/tts/bytes', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: MODEL, transcript: l.text, voice: { mode: 'id', id: voices[l.speaker] }, language: 'en', output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 } }) });
    if (!r.ok) { console.error(`STOP: Cartesia ${r.status} on line ${i + 1} (${l.shotId}): ${(await r.text()).slice(0, 200)}`); process.exit(4); }
    await writeFile(path, Buffer.from(await r.arrayBuffer()));
  }
  placed.push({ ...l, path, durSec: probe(path) });
}
const total = shotTimeline(sd).reduce((a, t) => a + t.durationSec, 0);
execFileSync('ffmpeg', mixArgs(placed, total, join(out, 'scratch-mix.wav')));
const rep = { lines: placed.length, chars: lines.reduce((n, l) => n + l.text.length, 0), estimateUsd: +est.toFixed(5), speechSec: +placed.reduce((a, l) => a + l.durSec, 0).toFixed(2), filmSec: total,
  mixSec: probe(join(out, 'scratch-mix.wav')), overruns: overruns(placed), oddities: placed.map((l) => ({ shotId: l.shotId, odd: oddities(l.text) })).filter((x) => x.odd.length),
  placed: placed.map(({ path, ...l }) => ({ ...l, file: path.split('/').pop(), durSec: +l.durSec.toFixed(2) })) };
await writeFile(join(out, 'scratch-report.json'), JSON.stringify(rep, null, 2));
console.log(JSON.stringify({ ...rep, placed: undefined }, null, 1));
