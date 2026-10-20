#!/usr/bin/env node
import { accentOf } from '../story-director/schema.mjs';
import { validateWritingTells } from './writing-tells.mjs';
import { checkStageShotLocks, onScreenOf } from './shot-locks.mjs';
import { words, lcs, answerSentences, NEAR_VERBATIM, checkAnswerSources, checkExtraCast } from './answer-sources.mjs';
import { checkPropsTraceable } from './craft-checks.mjs';
export { answerSentences, NEAR_VERBATIM };
// v2 deterministic validation gate for Story Director output.
// BASE: Gemini's validateStoryDirectorOutput (same return shape, codes and message text).
// Wiggly codes added: SPEAKER_NOT_IN_CAST, UNDERAGE_DEPICTION, MULTILINE_STORYBOARD_PROMPT,
// DIALOGUE_TIMING_BUDGET, WRONG_IMAGE_ENGINE, RUNTIME_EXCEEDS_CAP; banned jargon is the union of both lists.
// Usage: node check-stage-play.mjs <output.json>   (exit 0 valid, 1 invalid, 2 usage)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { countWords, secondsNeeded, budgetMessage, MAX_LINE_WORDS } from './speech.mjs';
import { fileURLToPath } from 'node:url';
import { skillFileName } from '../files.mjs';
import { MAX_TOTAL_SECONDS, IMAGE_ENGINE, MAX_PANELS_PER_SHEET, storyboardSheetsOf } from '../story-director/schema.mjs';

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
// Shared speech rate (3 words/sec + 1s lead/tail pad, crew/linter/speech.mjs); same rule as the Seedance Compiler gate.
export function lineBudget(words) { return words > MAX_LINE_WORDS ? null : secondsNeeded(words); }
// WIGGLY storyboard sheets -------------------------------------------------------
// Sheets are built in code (scripts/lib/sd-render.mjs); these checks guard that builder and old model-written outputs.
export { SHEET_OPENING, SHEET_LAYOUT, panelLabel, emptyPanelLine } from '../../scripts/lib/sd-render.mjs';
import { SHEET_OPENING, SHEET_LAYOUT, panelLabel, emptyPanelLine } from '../../scripts/lib/sd-render.mjs';
/** Every shot in exactly one panel, in story order; max 8 per sheet; labels use the real part + shot numbers. */
export function checkStoryboardSheets(data, err) {
  const sheets = storyboardSheetsOf(data);
  const segs = data?.segments ?? [];
  const want = segs.flatMap((sg) => (sg.shots ?? []).map((h, hi) => `${sg.segmentId}.${h.shotNumber ?? hi + 1}`));
  const known = new Set(want);
  if (!sheets.length) err('NO_STORYBOARD', 'Output has no storyboardSheets.', 'storyboardSheets');
  const seen = new Map(); const order = [];
  sheets.forEach((sh, si) => {
    const p = `storyboardSheets.${si}`, panels = sh.panels ?? [], fp = String(sh.fullPrompt ?? '');
    if (panels.length > MAX_PANELS_PER_SHEET || panels.length < 1)
      err('STORYBOARD_PANEL_COUNT', `Storyboard sheet ${si + 1} has ${panels.length} panels; a sheet has 1 to ${MAX_PANELS_PER_SHEET}.`, `${p}.panels`);
    panels.forEach((pn, i) => {
      const key = `${sh.segmentId}.${pn.shotNumberRef}`;
      if (pn.panelNumber !== i + 1)
        err('STORYBOARD_PANEL_NUMBERING', `Storyboard sheet ${si + 1}: panel ${i + 1} is numbered ${pn.panelNumber}; number panels 1 to ${panels.length} in order.`, `${p}.panels.${i}.panelNumber`);
      if (!known.has(key)) err('STORYBOARD_UNKNOWN_SHOT', `Storyboard sheet ${si + 1} panel ${i + 1} points at Part ${sh.segmentId} shot ${pn.shotNumberRef}, which does not exist.`, `${p}.panels.${i}.shotNumberRef`);
      else if (seen.has(key)) err('STORYBOARD_DUPLICATE_SHOT', `Part ${sh.segmentId} shot ${pn.shotNumberRef} is drawn twice (sheet ${seen.get(key) + 1} and sheet ${si + 1}); every shot gets exactly one panel.`, `${p}.panels.${i}`);
      else { seen.set(key, si); order.push(key); }
      const t = String(pn.whatIsInFrame ?? '').toLowerCase();
      const shot = segs.find((sg) => sg.segmentId === sh.segmentId)?.shots?.find((h) => h.shotNumber === pn.shotNumberRef);
      const nobody = Array.isArray(shot?.onScreen) && shot.onScreen.length === 0; // an empty frame has no skin to name
      if (!nobody && !SKIN_WORDS.some((w) => t.includes(w)))
        err('MISSING_SKIN_TONE_IN_PANEL', `Storyboard sheet ${si + 1} panel ${pn.panelNumber ?? i + 1} does not name skin tone.`, `${p}.panels.${i}`);
      if (!fp.includes(panelLabel(i + 1, sh.segmentId, pn.shotNumberRef)))
        err('STORYBOARD_PANEL_LABEL', `Storyboard sheet ${si + 1}: fullPrompt must label panel ${i + 1} as '${panelLabel(i + 1, sh.segmentId, pn.shotNumberRef)}' (the real part.shot).`, `${p}.fullPrompt`);
    });
    for (let k = panels.length + 1; k <= MAX_PANELS_PER_SHEET; k++)
      if (!fp.includes(emptyPanelLine(k)))
        err('STORYBOARD_EMPTY_SLOT', `Storyboard sheet ${si + 1} has ${panels.length} shots, so slot ${k} must be written exactly as '${emptyPanelLine(k)}'.`, `${p}.fullPrompt`);
    const lines = [...fp.matchAll(/Panel (\d+)(, labelled "\d+\.\d+":| \[empty\]:)/g)].map((m) => +m[1]);
    if (lines.join() !== Array.from({ length: MAX_PANELS_PER_SHEET }, (_, i) => i + 1).join())
      err('STORYBOARD_PANEL_LABEL', `Storyboard sheet ${si + 1}: fullPrompt must have exactly ${MAX_PANELS_PER_SHEET} panel lines, Panel 1 to Panel ${MAX_PANELS_PER_SHEET} in order (real shots labelled like 'Panel 1, labelled "1.1":', then empty slots).`, `${p}.fullPrompt`);
    if (/Panel \d+ \[(Part|shot)|\bP\d+S\d+\b/.test(fp))
      err('STORYBOARD_PANEL_LABEL', `Storyboard sheet ${si + 1}: fullPrompt uses an old bracket label or a code like P1S4; use 'Panel K, labelled "P.S":'.`, `${p}.fullPrompt`);
    if (panels.length && !(fp.includes(SHEET_OPENING) && fp.includes(SHEET_LAYOUT)))
      err('STORYBOARD_SHEET_SIZE_TEXT', `Storyboard sheet ${si + 1}: every sheet is eight panels, so its fullPrompt must say '${SHEET_OPENING}' and '${SHEET_LAYOUT}'.`, `${p}.fullPrompt`);
    if ((sh.targetEngine ?? IMAGE_ENGINE) !== IMAGE_ENGINE || /gpt[- ]?image/i.test(fp))
      err('WRONG_IMAGE_ENGINE', `Storyboard must target ${IMAGE_ENGINE} (Google Flow), not '${sh.targetEngine}'.`, `${p}.targetEngine`);
    if (/[\r\n]/.test(fp))
      err('MULTILINE_STORYBOARD_PROMPT', 'Storyboard fullPrompt must be a single line for Google Flow.', `${p}.fullPrompt`);
  });
  const missing = want.filter((k) => !seen.has(k));
  if (sheets.length && missing.length)
    err('STORYBOARD_SHOT_MISSING', `${missing.length} shot(s) have no storyboard panel: ${missing.map((k) => `Part ${k.replace('.', ' shot ')}`).join(', ')}. Every shot gets exactly one panel, one sheet (max ${MAX_PANELS_PER_SHEET}) per part.`, 'storyboardSheets');
  else if (order.join() !== want.filter((k) => seen.has(k)).join())
    err('STORYBOARD_SHOT_ORDER', 'Storyboard panels must follow story order: part by part, shot by shot.', 'storyboardSheets');
}

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
/** Any eyewear, and eyewear that hides the eyes (dark/tinted glasses, goggles, visors). Generic: no character's accessory is named here. */
export const EYEWEAR = String.raw`(?:\w*-?glasses|goggles|visors?|shades)`;
export const DARK_EYEWEAR = String.raw`(?:(?:sun-?)glasses|shades|goggles|visors?|(?:dark|black|tinted|mirrored)(?: \w+)? glasses)`;
/** Faces must act: eyes are never hidden. Eyewear that would hide them sits pushed up on the forehead. */
export const EYES_HIDDEN = new RegExp([
  String.raw`\b${DARK_EYEWEAR}[^.;]{0,40}\b(?:over|covering|covers|cover|hid(?:e|es|ing)|shield(?:s|ing)?|block(?:s|ing)?|on)\s+(?:his |her |their |the |both )?(?:eyes|face|nose)\b`,
  String.raw`\b${EYEWEAR}[^.;]{0,40}\b(?:over|covering|covers|cover|hid(?:e|es|ing)|shield(?:s|ing)?|block(?:s|ing)?)\s+(?:his |her |their |the |both )?eyes\b`,
  String.raw`(?:behind|through)\s+(?:his |her |their |the |dark |black )*${DARK_EYEWEAR}`,
  String.raw`\b(?:eyes|face)\b[^.;]{0,20}\b(?:hidden|covered)\b[^.;]{0,20}${EYEWEAR}`,
  String.raw`\b${DARK_EYEWEAR} (?:on|down)\b(?![^.;]{0,20}forehead)`,
  String.raw`(?:puts?|slides?|sliding|putting|pulls?|pulling|lowers?|lowering|drops?|dropping) (?:on )?(?:his |her |their |the )?(?:\w+ ){0,2}?${DARK_EYEWEAR}(?: on| down)?\b(?![^.;]{0,30}(?:forehead|up))`,
  String.raw`wearing (?:dark |black |matte black |tinted |his |her |their )*${DARK_EYEWEAR}(?![^.;]{0,30}(?:forehead|pushed up))`,
].join('|'), 'i');
export const MAX_CARDS_PER_PERSON = 3; // one card per life stage: child (<13), young adult (13-19, shown as 18), adult
export const MAX_ON_SCREEN = 2;
/** Resume facts in spoken in-scene dialogue (they belong in narration). */
export const RESUME_LINE = /\b(salary|salaries|\d+\s?k\b|\$\s?\d|benefits|certifications?|bootcamp|graduated|semester|years? old|full[- ]time|promotion|job offer)\b/i;
const AGE_WORDS = /\b(teen|teenage|young|younger|adult|grown|grown-up|older|old|dad|father|kid|child|little|baby|boy|man)\b/gi;
const personKey = (c) => norm(c.realPerson ?? String(c.name ?? '').replace(AGE_WORDS, ' ')) || norm(c.name);
const HAIR_VISIBLE = /\b(visible hair|hairline (?:shows|showing|visible)|bangs|fringe|loose hair|dark band)\b/i;

/** Sweeping generalisations banned from every finale line. */
export const FINALE_PLATITUDE = /\b(men and women|women and men|boys and girls|life is|love is|family is|always remember|never forget|follow your (?:dreams|heart)|be yourself|everything happens|(?:do not|don't) let the world)\b/i;
/** Brace-quoted example lines (3+ words) from every crew role file; a last line may not repeat one. */
export function roleExampleLines(dir = new URL('../', import.meta.url)) {
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = new URL(`${d.name}/${skillFileName(d.name)}`, dir);
    if (!existsSync(f)) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(/\{([^{}"\n:]{3,200})\}/g)) if ((m[1].match(/\S+/g) ?? []).length >= 3) out.push(m[1]);
  }
  return out;
}
let EXAMPLES = null;
// The family's own words: a finale line that quotes an answer sentence word for word (or nearly) is theirs, not a platitude we added.
/** True when the line (braces ignored) reproduces >= 80% of its words, in order, from one answer sentence that itself says the same platitude. */
export function quotesAnswer(line, answers, re = FINALE_PLATITUDE) {
  const lw = words(String(line ?? '').replace(/[{}]/g, ''));
  if (lw.length < 3) return false;
  return answerSentences(answers).some((s) => re.test(s) && lcs(lw, words(s)) >= Math.ceil(lw.length * NEAR_VERBATIM));
}
export const recipientOf = (subject) => /story for ([A-Z][\w-]*)/i.exec(String(subject ?? ''))?.[1] ?? null;

/** Seconds a film may run past its target (whole-second shots rarely land exactly). */
export const RUNTIME_TOLERANCE_SEC = 5;
/** Target runtime: input.targetTotalRuntimeSec, else input.format.targetTotalSeconds, else 90. */
export const runtimeTargetOf = (input) => (Number.isFinite(input?.targetTotalRuntimeSec) ? input.targetTotalRuntimeSec
  : Number.isFinite(input?.format?.targetTotalSeconds) ? input.format.targetTotalSeconds : 90);
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
        // speech length per shot (dialogue + narration + lead/tail pad): checkStageShotLocks
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
      const onScreen = new Set([...(String(shot.whatWeSee ?? '').match(/@[\w_]+/g) ?? []), ...onScreenOf(shot, tags)].filter((t) => tags.has(t)));
      if (onScreen.size > MAX_ON_SCREEN)
        err('TOO_MANY_ON_SCREEN', `Shot ${n} in segment ${seg.segmentId} shows ${onScreen.size} characters (${[...onScreen].join(', ')}); max ${MAX_ON_SCREEN} on screen. Others are heard off-camera (whatWeHear / isOffCamera dialogue) or get their own shot.`, `${p}.whatWeSee`);
      if (shot.dialogue && RESUME_LINE.test(shot.dialogue.line ?? ''))
        err('RESUME_DIALOGUE', `Shot ${n} in segment ${seg.segmentId}: in-scene dialogue states resume facts ('${shot.dialogue.line}'). Use subtext in the scene; put facts in the narration.`, `${p}.dialogue`);
      const text = [shot.whatWeSee, shot.whatWeHear, shot.directorsNote, shot.tag].filter(Boolean).join(' ');
      if (EYES_HIDDEN.test(text))
        err('EYES_HIDDEN', `Shot ${n} in segment ${seg.segmentId}: eyewear hides a character's eyes. Eyes stay visible; eyewear that would hide them sits pushed up on the forehead, and shot text uses the @tag only.`, p);
      for (const [label, re, plain] of BANNED_JARGON) if (re.test(text))
        err('BANNED_JARGON', `Forbidden jargon '${label}' found in shot ${n}. Use plain language instead (e.g. '${plain}')`, p);
    });
    if (segTotal > 30) err('EXCEEDS_30S_CEILING', `Segment ${seg.segmentId} runs ${segTotal}s. HARD CEILING IS 30 SECONDS per segment.`, `segments.${si}`);
    filmTotal += segTotal;
  });
  // WIGGLY: the finale is built around one idea, named in finaleThesis.
  if (!String(data?.finaleThesis ?? '').trim())
    err('MISSING_FINALE_THESIS', 'Output has no finaleThesis. Name the one idea the finale is built around, in one plain sentence taken from the family\'s answers; every final-part line serves it.', 'finaleThesis');
  // The ending grows out of the chosen story (any answers, any amount of narration): no part-source or narration-length rule.
  const last = segments.at(-1);
  // The recipient on screen in the finale is a choice, not a rule: a warning only. The last line is never copied from a role-file example.
  const recipient = recipientOf(input?.subject);
  if (recipient && segments.length > 1 && last) {
    const card = cast.find((c) => norm(c.realPerson ?? c.name) === norm(recipient) || norm(c.elementTag).replace(/^@/, '') === norm(recipient));
    const seen = card && (last.shots ?? []).some((h) => String(h.whatWeSee ?? '').includes(card.elementTag));
    if (!seen) warn('RECIPIENT_NOT_IN_FINALE', `${recipient} (the recipient) is ${card ? `not on screen in the final part; put ${card.elementTag}` : `not in the cast; add a cast card for ${recipient} and put her`} on screen listening in at least one final-part shot (max 2 on screen: the narrator and ${recipient}).`, `segments.${segments.length - 1}`);
  }
  const lastLine = [...(last?.shots ?? [])].reverse().map((h) => h.narration?.line ?? h.dialogue?.line).find(Boolean);
  // No concrete-detail requirement: a plain full sentence from the family is a good last line (a forced detail broke r4's ending).
  if (lastLine) {
    EXAMPLES ??= roleExampleLines().map(norm).filter((x) => x.split(' ').length >= 3);
    const ln = norm(lastLine.replace(/[{}]/g, ''));
    const copied = EXAMPLES.find((x) => ln === x || (x.split(' ').length >= 5 && ln.includes(x)));
    if (copied) err('GENERIC_FINAL_LINE', `The film's last line '${lastLine}' copies an example from the role files ('${copied}'). End on a clear line, built from the answers, that says or shows the finaleThesis.`, `segments.${segments.length - 1}`);
  }
  if (segments.length > 1 && last) (last.shots ?? []).forEach((h, hi) => {
    for (const k of ['dialogue', 'narration']) if (h[k]?.line && FINALE_PLATITUDE.test(h[k].line) && !quotesAnswer(h[k].line, input?.answers))
      err('FINALE_PLATITUDE', `Final part, shot ${h.shotNumber ?? hi + 1}: '${h[k].line}' is a sweeping generalisation that is not the family's own sentence. Cut it; keep only wisdom tied to this family's life in the answers.`, `segments.${segments.length - 1}.shots.${hi}.${k}`);
  });
  if (filmTotal > MAX_TOTAL_SECONDS) err('RUNTIME_EXCEEDS_CAP', `Film runs ${filmTotal}s; the total cap is ${MAX_TOTAL_SECONDS}s.`, 'segments');
  // The target runtime is the maximum (small tolerance for whole-second shots): target from the input, default 90s.
  const target = runtimeTargetOf(input);
  if (filmTotal > target + RUNTIME_TOLERANCE_SEC) err('RUNTIME_OVER_TARGET', `Film runs ${filmTotal}s; the target ${target}s is the maximum (at most ${target + RUNTIME_TOLERANCE_SEC}s). Cut ${filmTotal - target}s: drop a memory or a shot, never squeeze lines.`, 'segments');

  checkStoryboardSheets(data, err);

  if (!cast.length) err('NO_CAST', 'Output contains no cast.', 'cast');
  cast.forEach((c, i) => {
    const p = `cast.${i}`;
    // signatureAccent is optional (empty = no accessory); only a given-but-vague one is flagged.
    if (accentOf(c.signatureAccent) && accentOf(c.signatureAccent).length < 5)
      warn('WEAK_SIGNATURE_ACCENT', `Cast ${c.elementTag ?? c.name}: signature accent is too vague; use the answers' own wording or leave it empty.`, p);
    if (c.age >= 13 && c.age <= 17)
      err('UNDERAGE_DEPICTION', `Cast ${c.elementTag ?? c.name} is age ${c.age}; teens are depicted as 18.`, p);
    if ([c.physicalDescription, c.signatureAccent, ...(c.signatureAccessories ?? [])].some((look) => new RegExp(DARK_EYEWEAR, 'i').test(look ?? '') && (EYES_HIDDEN.test(look) || !/forehead|pushed up/i.test(look))))
      err('EYES_HIDDEN', `Cast ${c.elementTag ?? c.name}: eyewear that would hide the eyes must be described as pushed up on the forehead, never over the eyes.`, p);
    if (c.age === 18 && !c.ageNote)
      err('MISSING_TRUE_AGE', `Cast ${c.elementTag}: shown as 18; record the true age from the answers math in ageNote (e.g. 'true age 15, 7 years older than the maker at 8').`, p);
    const ph = (input?.photoCharacters ?? []).find((x) => x.id === c.photoRef);
    if (c.photoRef && !ph && (input?.photoCharacters ?? []).length)
      err('UNKNOWN_PHOTO_REF', `Cast ${c.elementTag}: photoRef '${c.photoRef}' is not one of the photoCharacters ids.`, p);
    if (ph && !norm(c.skinTone).includes(norm(ph.skinTone)))
      err('SKIN_TONE_NOT_FROM_PHOTO', `Cast ${c.elementTag}: skinTone must be the photo's '${ph.skinTone}', not '${c.skinTone}'.`, p);
  });
  // WIGGLY: at most 3 cards (child, young adult, adult) per real person.
  const people = new Map();
  for (const c of cast) { const k = personKey(c); people.set(k, [...(people.get(k) ?? []), c.elementTag]); }
  for (const [k, tagsOf] of people) if (tagsOf.length > MAX_CARDS_PER_PERSON)
    err('TOO_MANY_AGE_VARIANTS', `${tagsOf.length} cast cards depict the same person '${k}' (${tagsOf.join(', ')}); max ${MAX_CARDS_PER_PERSON} (one per life stage: child, young adult shown as 18, adult).`, 'cast');
  // WIGGLY: photo characters are never guessed.
  if ((input?.photoCharacters ?? []).length) for (const [i, a] of (data?.assumptions ?? []).entries())
    if (/skin ?tone|complexion/i.test(a) && /assum|guess|no photo|without photo|not provided/i.test(a))
      err('GUESSED_SKIN_TONE', `Assumption ${i + 1} guesses skin tone ('${a.slice(0, 80)}'). Photo characters use their photo's skin tone; family resemblance follows them. Do not list it as an assumption.`, `assumptions.${i}`);
  storyboardSheetsOf(data).forEach((sh, si) => (sh.panels ?? []).forEach((pn, i) => {
    if (EYES_HIDDEN.test(pn.whatIsInFrame ?? ''))
      err('EYES_HIDDEN', `Storyboard sheet ${si + 1} panel ${pn.panelNumber ?? i + 1}: eyes must stay visible; eyewear that would hide them sits pushed up on the forehead.`, `storyboardSheets.${si}.panels.${i}`);
  }));

  // WIGGLY shot locks: who is on screen, scene locks, entrances/exits, speaker on screen and leading, speech length.
  issues.push(...checkStageShotLocks(data));
  // WIGGLY answer tracing: every line cites the answer it comes from; only people the family names are cast.
  issues.push(...checkAnswerSources(data, input), ...checkExtraCast(data, input), ...checkPropsTraceable(data, input));
  issues.push(...validateWritingTells('story-director', data));
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
