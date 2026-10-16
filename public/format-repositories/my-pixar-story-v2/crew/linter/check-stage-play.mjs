#!/usr/bin/env node
// v2 deterministic validation gate for Story Director output.
// BASE: Gemini's validateStoryDirectorOutput (same return shape, codes and message text).
// Wiggly codes added: SPEAKER_NOT_IN_CAST, UNDERAGE_DEPICTION, MULTILINE_STORYBOARD_PROMPT,
// DIALOGUE_TIMING_BUDGET, WRONG_IMAGE_ENGINE, RUNTIME_EXCEEDS_CAP; banned jargon is the union of both lists.
// Usage: node check-stage-play.mjs <output.json>   (exit 0 valid, 1 invalid, 2 usage)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_TOTAL_SECONDS, IMAGE_ENGINE } from '../story-director/schema.mjs';

export const SKIN_WORDS = ['skin', 'complexion', 'tan', 'pale', 'brown', 'dark', 'warm', 'fair', 'olive', 'ebony'];
// [label, regex, plain-language suggestion]
export const BANNED_JARGON = [
  ['OTS', /\bOTS\b/, 'over his shoulder'],
  ['MOS', /\bMOS\b/, 'no dialogue in this shot'],
  ['rack focus', /\brack focus\b/i, 'the focus shifts from her to him'],
  ['20% ND', /\b20% ND\b/i, 'dim afternoon light'],
  // Wiggly (live-action / render-engine tokens that pull the look away from 3D animation)
  ['photorealistic', /\bphotorealistic\b/i, 'feature-quality 3D animated film'],
  ['hyperrealistic', /\bhyperrealistic\b/i, 'feature-quality 3D animated film'],
  ['live-action', /\blive[- ]action\b/i, '3D animated'],
  ['35mm', /\b35\s?mm\b/i, 'describe the framing in plain words'],
  ['film grain', /\bfilm grain\b/i, 'clean matte animated image'],
  ['8k', /\b8k\b/i, 'leave resolution out'],
  ['4k', /\b4k\b/i, 'leave resolution out'],
  ['octane', /\boctane\b/i, 'leave render engines out'],
  ['unreal engine', /\bunreal engine\b/i, 'leave render engines out'],
];
/** Whole-second budget for a spoken line (Gemini: 3–5 words = 2 s). null = too long for one shot. */
export function lineBudget(words) { return words <= 5 ? 2 : words <= 12 ? 3 : words <= 18 ? 4 : null; }
const HAIR_VISIBLE = /\b(visible hair|hairline (?:shows|showing|visible)|bangs|fringe|loose hair|dark band)\b/i;

export function validateStoryDirectorOutput(data) {
  const issues = [];
  const err = (code, message, path) => issues.push({ severity: 'error', code, message, ...(path ? { path } : {}) });
  const warn = (code, message, path) => issues.push({ severity: 'warning', code, message, ...(path ? { path } : {}) });
  const segments = data?.segments ?? [];
  const cast = data?.cast ?? [];
  const tags = new Set(cast.map((c) => c.elementTag));

  if (!segments.length) err('NO_SEGMENTS', 'Output contains no segments.', 'segments');
  let filmTotal = 0;
  segments.forEach((seg, si) => {
    let expectedCurrentTime = 0, segTotal = 0;
    (seg.shots ?? []).forEach((shot, hi) => {
      const n = shot.shotNumber ?? hi + 1, p = `segments.${si}.shots.${hi}`;
      if (!Number.isInteger(shot.startSec) || !Number.isInteger(shot.endSec))
        err('FRACTIONAL_TIMECODE', `Shot ${n} in segment ${seg.segmentId} has a fractional timecode (${shot.startSec}–${shot.endSec}s). Use whole seconds only.`, p);
      if (shot.startSec !== expectedCurrentTime)
        err('TIMECODE_DISCONTINUITY', `Shot ${n} in segment ${seg.segmentId} starts at ${shot.startSec}s but the previous shot ended at ${expectedCurrentTime}s. Timecodes must be strictly consecutive.`, p);
      const dur = shot.endSec - shot.startSec;
      if (!(dur > 0)) err('INVALID_SHOT_DURATION', `Shot ${n} in segment ${seg.segmentId} has a non-positive duration (${dur}s).`, p);
      segTotal += dur; expectedCurrentTime = shot.endSec;

      for (const k of ['dialogue', 'narration']) {
        const d = shot[k]; if (!d) continue;
        if (!String(d.speaker ?? '').startsWith('@'))
          err('UNTAGGED_SPEAKER', `Shot ${n}: speaker '${d.speaker}' must be an @tag.`, `${p}.${k}`);
        else if (!tags.has(d.speaker))
          err('SPEAKER_NOT_IN_CAST', `Shot ${n}: speaker ${d.speaker} does not match any cast elementTag.`, `${p}.${k}`);
        const line = String(d.line ?? '').trim();
        if (!/^\{.+\}$/.test(line))
          err('UNBRACKETED_DIALOGUE', `Shot ${n}: dialogue line must be enclosed in curly braces {}.`, `${p}.${k}`);
        const words = (line.replace(/[{}]/g, '').match(/\S+/g) ?? []).length;
        const need = lineBudget(words);
        if (need === null) err('DIALOGUE_TIMING_BUDGET', `Shot ${n}: ${words}-word line is too long for one shot (max 18 words).`, `${p}.${k}`);
        else if (dur < need) err('DIALOGUE_TIMING_BUDGET', `Shot ${n}: ${words}-word line needs ${need}s but the shot is ${dur}s.`, `${p}.${k}`);
      }
      const text = [shot.whatWeSee, shot.whatWeHear, shot.directorsNote, shot.tag].filter(Boolean).join(' ');
      for (const [label, re, plain] of BANNED_JARGON) if (re.test(text))
        err('BANNED_JARGON', `Forbidden jargon '${label}' found in shot ${n}. Use plain language instead (e.g. '${plain}')`, p);
    });
    if (segTotal > 30) err('EXCEEDS_30S_CEILING', `Segment ${seg.segmentId} runs ${segTotal}s. HARD CEILING IS 30 SECONDS per segment.`, `segments.${si}`);
    filmTotal += segTotal;
  });
  if (filmTotal > MAX_TOTAL_SECONDS) err('RUNTIME_EXCEEDS_CAP', `Film runs ${filmTotal}s; the total cap is ${MAX_TOTAL_SECONDS}s.`, 'segments');

  const sb = data?.storyboardPrompt ?? {};
  const panels = sb.panels ?? [];
  if (panels.length !== 8) err('STORYBOARD_PANEL_COUNT', `Storyboard has ${panels.length} panels; it must have exactly 8.`, 'storyboardPrompt.panels');
  panels.forEach((pn, i) => {
    const t = String(pn.whatIsInFrame ?? '').toLowerCase();
    if (!SKIN_WORDS.some((w) => t.includes(w)))
      err('MISSING_SKIN_TONE_IN_PANEL', `Storyboard panel ${pn.panelNumber ?? i + 1} does not name skin tone.`, `storyboardPrompt.panels.${i}`);
  });
  if ((sb.targetEngine ?? IMAGE_ENGINE) !== IMAGE_ENGINE || /gpt[- ]?image/i.test(sb.fullPrompt ?? ''))
    err('WRONG_IMAGE_ENGINE', `Storyboard must target ${IMAGE_ENGINE} (Google Flow), not '${sb.targetEngine}'.`, 'storyboardPrompt.targetEngine');
  if (/[\r\n]/.test(sb.fullPrompt ?? ''))
    err('MULTILINE_STORYBOARD_PROMPT', 'Storyboard fullPrompt must be a single line for Google Flow.', 'storyboardPrompt.fullPrompt');

  if (!cast.length) err('NO_CAST', 'Output contains no cast.', 'cast');
  cast.forEach((c, i) => {
    const p = `cast.${i}`;
    if (!c.signatureAccent || String(c.signatureAccent).length < 5)
      warn('WEAK_SIGNATURE_ACCENT', `Cast ${c.elementTag ?? c.name}: signature accent is missing or too vague.`, p);
    if (c.age >= 13 && c.age <= 17)
      err('UNDERAGE_DEPICTION', `Cast ${c.elementTag ?? c.name} is age ${c.age}; teens are depicted as 18.`, p);
  });

  const errors = issues.filter((i) => i.severity === 'error').map((i) => i.message);
  const warnings = issues.filter((i) => i.severity === 'warning').map((i) => i.message);
  return { isValid: errors.length === 0, errors, warnings, issues };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('usage: check-stage-play.mjs <output.json>'); process.exit(2); }
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error('cannot read JSON: ' + e.message); process.exit(2); }
  const r = validateStoryDirectorOutput(doc);
  for (const i of r.issues) console.log(`${i.severity.toUpperCase()} ${i.code}: ${i.message}`);
  if (!r.isValid) { console.log(`FAIL (${r.errors.length} errors, ${r.warnings.length} warnings)`); process.exit(1); }
  const shots = doc.segments.reduce((n, s) => n + s.shots.length, 0);
  const secs = doc.segments.reduce((n, s) => n + s.shots.reduce((m, h) => m + h.endSec - h.startSec, 0), 0);
  console.log(`PASS: ${doc.segments.length} segments, ${shots} shots, ${secs}s total, ${r.warnings.length} warnings`);
}
