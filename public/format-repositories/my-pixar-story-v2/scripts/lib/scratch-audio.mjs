// Scratch audio helpers (pure): line list from the SD timeline, cost estimate, overruns, ffmpeg mix args.
import { shotTimeline, pacedTimeline } from './animatic.mjs';

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
 * (Cartesia can cut or distort an unfinished line). No SSML: the break tag was read aloud. Pauses come from the timeline. */
export const spokenLetters = (text) => text.replace(/\b[A-Z](?:-[A-Z])+\b/g, (m) => `${m.split('-').join('. ')}.`).replace(/\.([.!?])/g, '$1');
export const ttsTranscript = (text) => { const t = spokenLetters(text.trim()); return /[.!?,;:]["'\u201d\u2019]?$/.test(t) ? t : `${t}.`; };
export const LINE_GAP_SEC = 0.25; // between two lines in the same shot
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

/** Speech span of a clip from ffmpeg silencedetect stderr: lead silence and spoken length (the TTS's own head and tail
 * silence are dropped; the timeline adds the beat). */
export function speechSpan(stderr, durSec) {
  const st = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]), en = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  const lead = st.length && st[0] < 0.01 && en.length ? en[0] : 0;
  const lastStart = st.length > en.length ? st[st.length - 1] : durSec; // open silence = runs to the end of the file
  const end = lastStart > lead ? lastStart : durSec;
  return { leadSec: +lead.toFixed(3), speechSec: +(end - lead).toFixed(3) };
}
/** Scratch-led placement: speech per shot -> paced timeline -> each clip's start (lines in one shot play back to back). */
export function placeLines(sd, lines, { gap = LINE_GAP_SEC, ...opt } = {}) {
  const byShot = {}; for (const l of lines) (byShot[l.shotId] ??= []).push(l);
  const speech = Object.fromEntries(Object.entries(byShot).map(([id, ls]) => [id, ls.reduce((a, l) => a + l.speechSec, 0) + gap * (ls.length - 1)]));
  const timeline = pacedTimeline(sd, speech, opt); const at = Object.fromEntries(timeline.map((t) => [t.shotId, t]));
  const placed = []; for (const [id, ls] of Object.entries(byShot)) { let t = at[id].timelineStartSec; for (const l of ls) { placed.push({ ...l, atSec: +t.toFixed(3), shotSec: at[id].durationSec }); t += l.speechSec + gap; } }
  return { timeline, placed, totalSec: +timeline.reduce((a, t) => a + t.durationSec, 0).toFixed(3) };
}

/** ffmpeg args: each clip delayed to its start, mixed without level normalisation, padded/trimmed to totalSec. */
export function mixArgs(placed, totalSec, out, { rate = 44100 } = {}) {
  const args = ['-y', '-loglevel', 'error'];
  for (const l of placed) args.push('-i', l.path);
  const parts = placed.map((l, i) => `[${i}:a]aresample=${rate},aformat=channel_layouts=mono,${l.speechSec ? `atrim=${l.leadSec ?? 0}:${+((l.leadSec ?? 0) + l.speechSec + 0.05).toFixed(3)},asetpts=PTS-STARTPTS,` : ''}adelay=${Math.round(l.atSec * 1000)}:all=1[a${i}]`);
  const fc = `${parts.join(';')};${placed.map((_, i) => `[a${i}]`).join('')}amix=inputs=${placed.length}:normalize=0:dropout_transition=0,apad,atrim=0:${totalSec}[m]`;
  args.push('-filter_complex', fc, '-map', '[m]', '-ac', '1', '-ar', String(rate), '-c:a', 'pcm_s16le', out);
  return args;
}
