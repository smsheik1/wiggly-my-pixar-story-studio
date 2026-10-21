#!/usr/bin/env node
// v2 deterministic gate for Location Scout output.
// BASE: Gemini's validateLocationScoutOutput (gemini-ls-gate.md), applied per location.
// WIGGLY: stage-play coverage (MISSING_SETTING, UNKNOWN_SETTING, UNKNOWN_SCENE_REF, TAG_PARITY), MULTILINE_PROMPT,
// WRONG_IMAGE_ENGINE, PROMPT_LENGTH, MISSING_TIME_OF_DAY, family words + element tags in the people check, CLI.
// Return shape: { isValid, errors, warnings, issues[{severity, code, message, path}] }.
// Usage: node check-location-plates.mjs <ls-output.json> <location-scout-input.json>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IMAGE_ENGINE, PLATE_MIN, PLATE_MAX, EMPTY_PHRASE } from '../location-scout/schema.mjs';

export const HOUSE_STYLE = '3D animated feature film: full-size, real-world-scale set with believable architecture and proportions, cinematic feature-animation look, naturally detailed but clean materials (visible wood grain, fabric weave, painted walls), soft natural lighting, gently saturated colors';
export const PLATE_OPENING = `A background plate from a ${HOUSE_STYLE}. 16:9 widescreen environment plate, ${EMPTY_PHRASE}.`;
// WIGGLY false-positive fixes: negated lists ("no people, figures or crowds"), possessive room names
// ("sister's bedroom", "dad's car"), objects ("action figures", "baby blue", "family photos" are not people).
const HUMAN_WORDS = 'people|persons?|humans?|figures?|children|child|kids?|crowds?|silhouettes?|pedestrians?|mannequins?|characters?|family members?|men|women|anyone|one';
const NEGATED_LIST = new RegExp(`\\b(?:no|without|free of|devoid of|absent of)\\s+(?:(?:other|visible|any)\\s+)?(?:${HUMAN_WORDS})(?:\\s*(?:,|or|and|/|nor)\\s*(?:no\\s+)?(?:${HUMAN_WORDS}))*\\b`, 'gi');
const WIGGLY_SAFE = [NEGATED_LIST, /\b\w+'s\s+(?:bed)?(?:room|bedroom|kitchen|car|desk|chair|bed|house|home|office|study|corner|side|shelf|garage|garden)\b/gi,
  /\b(?:kids'|children's|boys'|girls')\s+\w+/gi, /\baction figures?\b/gi, /\bfigurines?\b/gi, /\bbaby (?:blue|pink|grand)\b/gi, /\bman-made\b/gi,
  /\b(?:family|people)\s+(?:photos?|photographs?|portraits?|pictures?)\b/gi, /\bfamily (?:room|car|home|kitchen|living room)\b/gi];
// Furniture/objects named for who uses them ("student desks", "kid chairs") are props, not people.
const USER_OBJECTS = /\b(?:students?|teachers?|kids?|child(?:ren)?|baby|people|guests?|office|staff)'?s?\s+(?:desks?|chairs?|tables?|lockers?|stools?|cubbies|seats?|benches?|drawings?|artwork|art|cots?|cribs?|mats?|backpacks?|bags?|coats?|shoes|books?|notebooks?|cubicles?|workstations?|monitors?|keyboards?)\b/gi;
const SAFE_PHRASES = [...WIGGLY_SAFE, USER_OBJECTS, /\bchildren'?s\s+\w+/gi, /\bteacher'?s\s+(desk|chair|table|stool|lectern|binder)\b/gi, /\bchild[- ](sized|scale|height)\b/gi,
  /\bno\s+(people|humans|figures|children|silhouettes|crowds|pedestrians|mannequins)\b/gi, /\b(completely\s+)?empty of people\b/gi];
const HUMAN = /\b(person|people|child|children|teacher|student|pedestrian|silhouette|mannequin|crowd)\b/i;
// WIGGLY: family-story words and element tags (other than @Loc N).
const HUMAN_WIGGLY = /\b(man|men|woman|women|boy|girl|kid|kids|toddler|baby|mom|mum|mother|dad|father|sister|brother|grandma|grandpa|someone|figure|figures|humans?)\b/i;
const ELEMENT_TAG = /@(?!Loc \d)[A-Za-z_]\w*/;
const WALL_TEXT = ['alphabet strip', 'alphabet chart', 'motivational poster', 'blackboard writing', 'chalkboard writing', 'written chart', 'poster with text', 'posters on the wall'];
const CONTEXT_SIGN = /\b(reading|reads|says|saying|labeled|banner|sign|plaque|board)\s+(?:reading\s+)?["']([^"']{1,40})["']/gi;
const QUOTED = /["']([^"']{1,35})["']/g;
const LIGHT_SOURCES = ['sunlight', 'window light', 'streaming from', 'key light', 'morning light', 'afternoon light'];
// WIGGLY: night, car and interior practicals are valid key sources too (was a false positive on night/car plates).
const LIGHT_SOURCE_RE = /\b(sun(?:light|set|rise|beams?)?|golden hour|moon(?:light|lit)?|lamp(?:s|light)?|streetlights?|street lamps?|headlights?|tail ?lights?|dashboard (?:glow|lights?)|(?:tv|television|screen|monitor) (?:glow|light)|overhead (?:lights?|lamp|fluorescents?)|ceiling (?:lights?|lamp)|pendant (?:lights?|lamp)|fluorescent (?:tubes?|lights?|panels?)|candle(?:s|light)?|fire(?:light|place)|skylight|(?:from|through) (?:a|the) (?:\w+ )?windows?|neon sign|porch light|lantern|light from|lit by|glow from)\b/i;
// Fluorescent *colours* overpower the cast; fluorescent *tube lighting* is a light source, not a palette (false positive fixed).
const PALETTE = /\b(neon\s+(yellow|pink|green|blue|orange)|fluorescent\s+(yellow|pink|green|blue|orange|red|purple|colou?rs?|paint|walls?)|hot\s+pink\s+walls?)\b/i;
const FOCAL = ['35mm', '50mm', 'wide shot', 'master shot', 'establishing shot'];
const LIVE_ACTION = [['photorealistic', /photorealistic/i], ['film stock', /film stock/i], ['film grain', /film grain/i], ['kodak', /\bkodak\b/i],
  ['35mm grain', /35\s?mm grain/i], ['lens flare', /lens flare/i],
  ['hyperrealistic', /hyperrealistic/i], ['live-action', /live[- ]action/i], ['8k', /\b8k\b/i], ['4k', /\b4k\b/i], ['octane', /\boctane\b/i], ['unreal engine', /unreal engine/i]]; // WIGGLY extras
const TIME_CLASS = { dawn: 'dawn', sunrise: 'dawn', morning: 'day', midday: 'day', noon: 'day', daytime: 'day', afternoon: 'day', 'late afternoon': 'day', 'golden hour': 'dusk', sunset: 'dusk', dusk: 'dusk', evening: 'dusk', night: 'night', nighttime: 'night' };
const TIME_CLASS_OF = (t) => { const m = /\b(dawn|sunrise|late afternoon|morning|midday|noon|daytime|afternoon|golden hour|sunset|dusk|evening|nighttime|night)\b/i.exec(t ?? ''); return m ? TIME_CLASS[m[1].toLowerCase()] : null; };
const TIME_WORDS = /\b(dawn|morning|midday|noon|afternoon|golden hour|sunset|dusk|evening|night)\b/i;
// Local negation fix: a hit is exempt only when "no " / "not " DIRECTLY precedes it.
const unNegatedHit = (text, re) => {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m; while ((m = g.exec(text))) if (!/\b(no|not) $/i.test(text.slice(Math.max(0, m.index - 4), m.index))) return true;
  return false;
};

/** Signs found in a prompt (unique texts). Gemini's detection. */
export function detectSigns(t) {
  const found = new Set();
  for (const m of t.matchAll(CONTEXT_SIGN)) found.add(m[2].trim());
  for (const m of t.matchAll(QUOTED)) {
    const q = m[1].trim();
    if (HOUSE_STYLE.includes(q)) continue;
    if ((q === q.toUpperCase() && /[A-Z]/.test(q)) || /welcome|family|classroom|room|rules/i.test(q)) found.add(q);
  }
  return [...found];
}

/** Gemini base + Wiggly checks for one location object. */
export function validateLocationScoutOutput(l, { pathPrefix = '' } = {}) {
  const issues = [];
  const P = (s) => (pathPrefix ? `${pathPrefix}.${s}` : s);
  const err = (code, message, path) => issues.push({ severity: 'error', code, message, path: P(path) });
  const warn = (code, message, path) => issues.push({ severity: 'warning', code, message, path: P(path) });
  const t = l?.locationPlatePrompt?.promptText ?? '';
  const pp = 'locationPlatePrompt.promptText';
  // ---- Gemini ----
  if (!t.includes(HOUSE_STYLE)) err('INVALID_OPENING_STYLE', `Prompt must include the house line "${HOUSE_STYLE}".`, pp);
  if (!t.includes(EMPTY_PHRASE)) err('MISSING_EMPTY_OF_PEOPLE', `Empty Set Law: prompt must include verbatim "${EMPTY_PHRASE}".`, pp);
  const stripped = SAFE_PHRASES.reduce((s, re) => s.replace(re, ' '), t);
  const human = stripped.match(HUMAN) ?? stripped.match(HUMAN_WIGGLY);
  if (human || ELEMENT_TAG.test(t) || l?.emptySetGuarantee === false)
    err('HUMAN_FIGURE_IN_BACKGROUND', `Empty Set Law violated: "${human?.[0] ?? t.match(ELEMENT_TAG)?.[0] ?? 'emptySetGuarantee=false'}" puts a person in the plate.`, pp);
  for (const w of WALL_TEXT) if (t.toLowerCase().includes(w) && !new RegExp(`\\bno (?:other )?${w}`, 'i').test(t))
    err('BANNED_WALL_TEXT_ELEMENT', `Anti-Rune: "${w}" generates garbled wall text.`, pp);
  const signs = detectSigns(t);
  const sr = l?.singleSignRule ?? {};
  if (signs.length > 1) err('MULTIPLE_SIGNS_DETECTED', `Single-Sign Law: ${signs.length} signs found (${signs.join(', ')}); max one.`, pp);
  if (!sr.hasSign && signs.length > 0) err('UNEXPECTED_SIGN_PRESENT', `singleSignRule.hasSign is false but the prompt has a sign (${signs.join(', ')}).`, pp);
  if (sr.hasSign && (!sr.signText || !t.includes(sr.signText))) err('SIGN_TEXT_MISSING', 'hasSign needs signText, written verbatim in the prompt.', 'singleSignRule.signText'); // WIGGLY
  if (!LIGHT_SOURCES.some((s) => t.toLowerCase().includes(s)) && !LIGHT_SOURCE_RE.test(t)) err('MISSING_LIGHTING_SOURCE', `Lighting Anchor: name the key light source (${LIGHT_SOURCES.join(', ')}).`, pp);
  if (!/shadow/i.test(t)) warn('MISSING_SHADOW_DESCRIPTION', 'Lighting Anchor: describe the shadows.', pp);
  if (PALETTE.test(t)) err('PALETTE_DISCIPLINE_VIOLATION', `Palette Discipline: "${t.match(PALETTE)[0]}" overpowers the cast.`, pp);
  if (!FOCAL.some((f) => t.toLowerCase().includes(f))) warn('MISSING_CAMERA_STAGING_FOCAL', `Camera: name a focal/shot (${FOCAL.join(', ')}).`, pp);
  for (const [label, re] of LIVE_ACTION) if (unNegatedHit(t, re))
    err('BANNED_LIVE_ACTION_JARGON', `Live-action jargon '${label}' found; the look is production CG.`, pp);
  const ar = l?.locationPlatePrompt?.aspectRatio;
  if (ar !== undefined && ar !== '16:9') err('INVALID_ASPECT_RATIO', `aspectRatio must be 16:9, got '${ar}'.`, 'locationPlatePrompt.aspectRatio');
  // ---- WIGGLY ----
  const eng = l?.locationPlatePrompt?.targetEngine;
  if (eng !== IMAGE_ENGINE) err('WRONG_IMAGE_ENGINE', `targetEngine must be ${IMAGE_ENGINE}, not '${eng}'.`, 'locationPlatePrompt.targetEngine');
  if (/gpt[- ]?image|seedream|midjourney|dall-?e|flux|imagen|nano banana pro/i.test(t)) err('WRONG_IMAGE_ENGINE', `Prompt names another image engine; target is ${IMAGE_ENGINE} (Google Flow).`, pp);
  if (/[\r\n]/.test(t)) err('MULTILINE_PROMPT', 'Prompt must be a single line for Google Flow.', pp);
  if (t.length < PLATE_MIN || t.length > PLATE_MAX) err('PROMPT_LENGTH', `Prompt is ${t.length} chars; must be ${PLATE_MIN}-${PLATE_MAX}.`, pp);
  if (!TIME_WORDS.test(t)) warn('MISSING_TIME_OF_DAY', 'Prompt should state the time of day.', pp);
  const errors = issues.filter((i) => i.severity === 'error').map((i) => i.message);
  const warnings = issues.filter((i) => i.severity === 'warning').map((i) => i.message);
  return { isValid: errors.length === 0, errors, warnings, issues };
}

/** Wiggly set-level gate: every location + stage-play coverage. `input` is the Location Scout input slice. */
export function validateLocationPlates(data, input) {
  const issues = [];
  const err = (code, message, path) => issues.push({ severity: 'error', code, message, path });
  const locs = data?.locations ?? [];
  const settings = input?.settings ?? [];
  const known = new Set((input?.scenes ?? []).map((s) => s.sceneId));
  const sceneLoc = new Map((input?.scenes ?? []).map((s) => [s.sceneId, s.location]));
  for (const s of settings) if (!locs.some((l) => l.settingName === s.name))
    err('MISSING_SETTING', `Stage-play setting "${s.name}" has no location plate.`, 'locations');
  locs.forEach((l, i) => {
    const p = `locations.${i}`;
    if (settings.length && !settings.some((s) => s.name === l.settingName)) err('UNKNOWN_SETTING', `Plate "${l.settingName}" is not a stage-play setting.`, `${p}.settingName`);
    if (l.elementTag !== `@Loc ${i + 1}`) err('TAG_PARITY', `${p}: elementTag must be '@Loc ${i + 1}', got '${l.elementTag}'.`, `${p}.elementTag`);
    for (const id of l.sceneIds ?? []) {
      if (!known.has(id)) err('UNKNOWN_SCENE_REF', `${l.settingName}: scene ${id} is not in the stage play.`, `${p}.sceneIds`);
      else if (sceneLoc.get(id) !== l.settingName) err('UNKNOWN_SCENE_REF', `${l.settingName}: scene ${id} is set in "${sceneLoc.get(id)}".`, `${p}.sceneIds`);
    }
    const want = settings.find((s) => s.name === l.settingName)?.sceneIds ?? [];
    const miss = want.filter((id) => !(l.sceneIds ?? []).includes(id));
    if (miss.length) err('TAG_PARITY', `${l.settingName}: missing scene ids ${miss.join(', ')}.`, `${p}.sceneIds`);
    // the Story Director's description sets the time of day (one moment, one light); the plate keeps it
    const tw = TIME_CLASS_OF(settings.find((s) => s.name === l.settingName)?.description), tp = TIME_CLASS_OF(String(l.timeOfDay ?? '').replace(/-/g, ' '));
    if (tw && tp && tw !== tp) err('TIME_OF_DAY_NOT_AS_STAGED', `${l.settingName}: timeOfDay is "${l.timeOfDay}" but the stage play describes it at ${tw}. Use the stage play's time of day in timeOfDay, the lighting anchor and the prompt.`, `${p}.timeOfDay`);
    issues.push(...validateLocationScoutOutput(l, { pathPrefix: p }).issues);
  });
  const errors = issues.filter((i) => i.severity === 'error').map((i) => i.message);
  const warnings = issues.filter((i) => i.severity === 'warning').map((i) => i.message);
  return { isValid: errors.length === 0, errors, warnings, issues };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [out, inp] = process.argv.slice(2);
  if (!out || !inp) { console.error('usage: check-location-plates.mjs <ls-output.json> <location-scout-input.json>'); process.exit(2); }
  const r = validateLocationPlates(JSON.parse(readFileSync(out, 'utf8')), JSON.parse(readFileSync(inp, 'utf8')));
  for (const i of r.issues) console.log(`${i.severity.toUpperCase()} ${i.code} ${i.path}: ${i.message}`);
  console.log(r.isValid ? 'PASS' : 'FAIL'); process.exit(r.isValid ? 0 : 1);
}
