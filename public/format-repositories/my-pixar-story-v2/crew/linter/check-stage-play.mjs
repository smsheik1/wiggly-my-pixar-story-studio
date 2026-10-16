#!/usr/bin/env node
// v2 deterministic validation gate for Story Director output.
// BASE: Gemini's validateStoryDirectorOutput (same return shape, codes and message text).
// Wiggly codes added: SPEAKER_NOT_IN_CAST, UNDERAGE_DEPICTION, MULTILINE_STORYBOARD_PROMPT,
// DIALOGUE_TIMING_BUDGET, WRONG_IMAGE_ENGINE, RUNTIME_EXCEEDS_CAP; banned jargon is the union of both lists.
// Usage: node check-stage-play.mjs <output.json>   (exit 0 valid, 1 invalid, 2 usage)
import { readFileSync } from 'node:fs';
import { countWords, secondsNeeded, budgetMessage, MAX_LINE_WORDS } from './speech.mjs';
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
// Shared 3 words/sec rate (crew/linter/speech.mjs); same rule as the Seedance Compiler gate.
export function lineBudget(words) { return words > MAX_LINE_WORDS ? null : secondsNeeded(words); }
// WIGGLY shot hygiene -------------------------------------------------------------
const STOP = new Set('a an the and or of with in on at to his her their its is are wearing wears who that for from by as into over under no'.split(' '));
const norm = (t) => String(t ?? '').toLowerCase().replace(/@[\w_]+/g, ' ').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
/** Distinctive look phrases for a cast card: its skinTone and every 3-word run of its physicalDescription with ≥2 non-stopwords. */
export function lookPhrases(c) {
  const out = new Set();
  const tone = norm(c?.skinTone); if (tone.split(' ').length >= 2) out.add(tone);
  for (const clause of String(c?.physicalDescription ?? '').split(/[.;,]/)) {
    const w = norm(clause).split(' ').filter(Boolean);
    for (let i = 0; i + 3 <= w.length; i++) {
      const g = w.slice(i, i + 3);
      if (g.filter((x) => !STOP.has(x)).length >= 2) out.add(g.join(' '));
    }
  }
  return [...out];
}
/** Sunglasses must sit pushed up on the forehead, never over the eyes. */
export const SUNGLASSES_OVER_EYES = /sunglasses[^.;]{0,40}\b(over|covering|covers|cover|hid(?:e|es|ing)|shield(?:s|ing)?|block(?:s|ing)?|on)\s+(?:his |her |the |both )?(eyes|face|nose)\b|(?:behind|through)\s+(?:his |her |the |dark |black )*sunglasses|\b(?:eyes|face)\b[^.;]{0,20}\b(?:hidden|covered)\b[^.;]{0,20}sunglasses|sunglasses (?:on|down)\b(?![^.;]{0,20}forehead)|(?:puts?|slides?|sliding|putting|pulls?|pulling|lowers?|lowering|drops?|dropping) (?:on )?(?:his |her |the )?sunglasses(?: on| down)?\b(?![^.;]{0,30}(?:forehead|up))|wearing (?:dark |black |matte black |his |her )*sunglasses(?![^.;]{0,30}(?:forehead|pushed up))/i;
export const MAX_CARDS_PER_PERSON = 2;
const AGE_WORDS = /\b(teen|teenage|young|younger|adult|grown|grown-up|older|old|dad|father|kid|child|little|baby|boy|man)\b/gi;
const personKey = (c) => norm(c.realPerson ?? String(c.name ?? '').replace(AGE_WORDS, ' ')) || norm(c.name);
const HAIR_VISIBLE = /\b(visible hair|hairline (?:shows|showing|visible)|bangs|fringe|loose hair|dark band)\b/i;

export function validateStoryDirectorOutput(data, input = {}) {
  const issues = [];
  const err = (code, message, path) => issues.push({ severity: 'error', code, message, ...(path ? { path } : {}) });
  const warn = (code, message, path) => issues.push({ severity: 'warning', code, message, ...(path ? { path } : {}) });
  const segments = data?.segments ?? [];
  const cast = data?.cast ?? [];
  const tags = new Set(cast.map((c) => c.elementTag));

  const locNames = new Set((data?.locations ?? []).map((l) => l.name));
  if (!locNames.size) err('NO_LOCATIONS', 'Output has no locations list. Define every background once in locations[] and name one on every shot.', 'locations');
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
        const words = countWords(line);
        const need = lineBudget(words);
        if (need === null) err('DIALOGUE_TIMING_BUDGET', `Shot ${n}: ${words}-word line is too long for one shot (max ${MAX_LINE_WORDS} words); split it across two shots.`, `${p}.${k}`);
        else if (dur < need) err('DIALOGUE_TIMING_BUDGET', budgetMessage(`Segment ${seg.segmentId ?? si + 1}, shot ${n} (${shot.startSec}s-${shot.endSec}s)`, words, dur), `${p}.${k}`);
      }
      // WIGGLY: camera direction + defined location on every shot.
      for (const k of ['framing', 'cameraAngle', 'cameraMove']) if (!String(shot[k] ?? '').trim())
        err('MISSING_CAMERA_DIRECTION', `Shot ${n} in segment ${seg.segmentId} has no ${k}. Every shot needs framing, cameraAngle and cameraMove ('static' if it does not move).`, `${p}.${k}`);
      if (!String(shot.location ?? '').trim())
        err('MISSING_LOCATION', `Shot ${n} in segment ${seg.segmentId} has no location. Name one of the locations list on every shot.`, `${p}.location`);
      else if (locNames.size && !locNames.has(shot.location))
        err('UNKNOWN_LOCATION', `Shot ${n} in segment ${seg.segmentId}: location '${shot.location}' is not in the locations list (${[...locNames].join(', ')}).`, `${p}.location`);
      // WIGGLY: refer to people by @tag only; looks live in the cast cards.
      const seeN = ` ${norm(shot.whatWeSee)} `;
      for (const c of cast) {
        const hit = lookPhrases(c).find((ph) => seeN.includes(` ${ph} `));
        if (hit) err('REDESCRIBED_CHARACTER', `Shot ${n} in segment ${seg.segmentId} re-describes ${c.elementTag} ('${hit}'). Write just ${c.elementTag}; the look lives in the cast card.`, `${p}.whatWeSee`);
        const bare = String(c.elementTag ?? '').slice(1).replace(/_/g, ' ');
        if (bare && new RegExp(`(?<![@\\w])${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(shot.whatWeSee ?? '').replace(/@[\w_]+/g, '')))
          err('UNTAGGED_CHARACTER', `Shot ${n} in segment ${seg.segmentId} names '${bare}' without the tag. Write ${c.elementTag}.`, `${p}.whatWeSee`);
      }
      const text = [shot.whatWeSee, shot.whatWeHear, shot.directorsNote, shot.tag].filter(Boolean).join(' ');
      if (SUNGLASSES_OVER_EYES.test(text))
        err('SUNGLASSES_OVER_EYES', `Shot ${n} in segment ${seg.segmentId}: sunglasses cover the eyes. @Shaz's sunglasses sit pushed up on his forehead, never over his eyes.`, p);
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
    if ([c.physicalDescription, c.signatureAccent].some((look) => /sunglasses/i.test(look ?? '') && (SUNGLASSES_OVER_EYES.test(look) || !/forehead/i.test(look))))
      err('SUNGLASSES_OVER_EYES', `Cast ${c.elementTag ?? c.name}: sunglasses must be described as pushed up on the forehead, never over the eyes.`, p);
    const ph = (input?.photoCharacters ?? []).find((x) => x.id === c.photoRef);
    if (c.photoRef && !ph && (input?.photoCharacters ?? []).length)
      err('UNKNOWN_PHOTO_REF', `Cast ${c.elementTag}: photoRef '${c.photoRef}' is not one of the photoCharacters ids.`, p);
    if (ph && !norm(c.skinTone).includes(norm(ph.skinTone)))
      err('SKIN_TONE_NOT_FROM_PHOTO', `Cast ${c.elementTag}: skinTone must be the photo's '${ph.skinTone}', not '${c.skinTone}'.`, p);
  });
  // WIGGLY: at most 2 cards (age variants) per real person.
  const people = new Map();
  for (const c of cast) { const k = personKey(c); people.set(k, [...(people.get(k) ?? []), c.elementTag]); }
  for (const [k, tagsOf] of people) if (tagsOf.length > MAX_CARDS_PER_PERSON)
    err('TOO_MANY_AGE_VARIANTS', `${tagsOf.length} cast cards depict the same person '${k}' (${tagsOf.join(', ')}); max ${MAX_CARDS_PER_PERSON} (main age + one other).`, 'cast');
  // WIGGLY: photo characters are never guessed.
  if ((input?.photoCharacters ?? []).length) for (const [i, a] of (data?.assumptions ?? []).entries())
    if (/skin ?tone|complexion/i.test(a) && /assum|guess|no photo|without photo|not provided/i.test(a))
      err('GUESSED_SKIN_TONE', `Assumption ${i + 1} guesses skin tone ('${a.slice(0, 80)}'). Photo characters use their photo's skin tone; family resemblance follows them. Do not list it as an assumption.`, `assumptions.${i}`);
  (data?.storyboardPrompt?.panels ?? []).forEach((pn, i) => {
    if (SUNGLASSES_OVER_EYES.test(pn.whatIsInFrame ?? ''))
      err('SUNGLASSES_OVER_EYES', `Storyboard panel ${pn.panelNumber ?? i + 1}: sunglasses must sit pushed up on the forehead.`, `storyboardPrompt.panels.${i}`);
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
