// Scratch audio helpers (pure): line list from the SD timeline, cost estimate, overruns, ffmpeg mix args.
import { shotTimeline } from './animatic.mjs';

// Cartesia published Pro overage rate (v1 runtime/providers.mjs, cartesia.ai/pricing): 1 credit per character, $65 per million credits.
export const CARTESIA_USD_PER_CHAR = 65 / 1e6;
export const unbrace = (s) => String(s ?? '').replace(/^\s*\{|\}\s*$/g, '').trim();

/** Every narration / dialogue line with its shot, absolute start on the film timeline and shot duration. */
export function scratchLines(sd) {
  const tl = Object.fromEntries(shotTimeline(sd).map((t) => [t.shotId, t]));
  const out = [];
  for (const seg of sd.segments ?? []) for (const sh of seg.shots ?? []) for (const kind of ['narration', 'dialogue']) {
    const l = sh[kind]; if (!l?.line) continue;
    const id = `${seg.segmentId}.${sh.shotNumber}`; const t = tl[id];
    out.push({ shotId: id, kind, speaker: l.speaker, text: unbrace(l.line), atSec: t.timelineStartSec, shotSec: t.durationSec });
  }
  return out;
}
/** Text sent to the TTS. Letter-by-letter abbreviations, written "A-C" in the script, are sent as "A. C.": Sonic read
 * "AC", "A-C" and "A C" as one word ("ack"); "A. C." is heard as two letters. The line keeps terminal punctuation
 * (Cartesia can cut or distort an unfinished line). No SSML: the break tag was read aloud; tail silence is added in mixArgs. */
export const spokenLetters = (text) => text.replace(/\b[A-Z](?:-[A-Z])+\b/g, (m) => `${m.split('-').join('. ')}.`).replace(/\.([.!?])/g, '$1');
export const ttsTranscript = (text) => { const t = spokenLetters(text.trim()); return /[.!?,;:]["'\u201d\u2019]?$/.test(t) ? t : `${t}.`; };
export const TAIL_PAD_SEC = 0.5;
export const estimateUsd = (lines) => lines.reduce((n, l) => n + Array.from(l.text).length, 0) * CARTESIA_USD_PER_CHAR;

/** Text a TTS engine may read oddly: symbols, all-caps abbreviations, digits. */
export function oddities(text) {
  const o = [];
  for (const m of text.matchAll(/\b[A-Z]{2,}\b|\b[A-Z](?:\/[A-Z])+\b/g)) o.push(`abbreviation "${m[0]}"`);
  for (const m of text.matchAll(/[^\p{L}\p{N}\s,.!?'’"“”\-–—:;]/gu)) o.push(`symbol "${m[0]}"`);
  for (const m of text.matchAll(/\b\d+\b/g)) o.push(`number "${m[0]}"`);
  return o;
}

/** Lines longer than their shot (not stretched; they overlap into the next shot). */
export const overruns = (placed) => placed.filter((l) => l.durSec > l.shotSec + 0.05).map((l) => ({ shotId: l.shotId, overSec: +(l.durSec - l.shotSec).toFixed(2), durSec: +l.durSec.toFixed(2), shotSec: l.shotSec }));

/** ffmpeg args: each clip delayed to its start, mixed without level normalisation, padded/trimmed to totalSec. */
export function mixArgs(placed, totalSec, out, { rate = 44100 } = {}) {
  const args = ['-y', '-loglevel', 'error'];
  for (const l of placed) args.push('-i', l.path);
  const parts = placed.map((l, i) => `[${i}:a]aresample=${rate},aformat=channel_layouts=mono,adelay=${Math.round(l.atSec * 1000)}:all=1,apad=pad_dur=${TAIL_PAD_SEC}[a${i}]`);
  const fc = `${parts.join(';')};${placed.map((_, i) => `[a${i}]`).join('')}amix=inputs=${placed.length}:normalize=0:dropout_transition=0,apad,atrim=0:${totalSec}[m]`;
  args.push('-filter_complex', fc, '-map', '[m]', '-ac', '1', '-ar', String(rate), '-c:a', 'pcm_s16le', out);
  return args;
}
