#!/usr/bin/env node
// v2 deterministic gate for Character Architect output.
// BASE: Gemini's validateCharacterArchitectOutput (gemini-ca-gate.md): exact codes, message strings and regexes,
// applied per character. Wiggly checks are added per character and in the cast-level gate validateCharacterSheets().
// Return shape (both): { isValid, errors, warnings, issues[{severity, code, message, path}] }.
// Usage: node check-character-sheets.mjs <ca-output.json> <story-director.json>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IMAGE_ENGINE, SHEET_MIN, SHEET_MAX, SHEET_EXPRESSIONS } from '../character-architect/schema.mjs';

export const MASTER_OPENING = 'A single-character full-body render from a feature-quality 3D animated film, production CG, not photorealistic and not flat cartoon.';
export const TEMPLATE_LABELS = ['Eyes:', 'Eyebrows:', 'Face:', 'Subject:', 'Skin:', 'Hands:', 'Silhouette:', 'Hair:', 'Wardrobe:', 'Pose:', 'Camera:', 'Background:'];
export const HELD = /\b(holds?|holding|clutching|grasping)\s+(a|an|the|his|her)\s+(?!only\b|weight\b|shape\b|pose\b)/i;
const CARRY = /\b(carries|carrying)\s+(?:a|an|the|his|her)?\s*(?:\w+\s+){0,2}(axe|cup|mug|bag|backpack|tool|toy|umbrella|book|phone|box|ball|doll|cane)s?\b/i;
const IN_HANDS = /\b(?:in|with)\s+(?:his|her|their|both)\s+hands\b/i;
const INK = /\b(tattoo|tattoos|biro mark|pen mark|ink on skin)\b/i;
const INK_NEGATION = /\b(no|without|never|zero)\s+(ink|tattoos?|markings?|pen marks?|biro marks?)\b/gi;
// Source of truth for BOBBLEHEAD_ADULT_VIOLATION. crew/character-architect/role.md must list every token (tests/ca-gate-rules.test.mjs).
export const CHILD_TOKENS = ['enlarged head', 'narrow shoulders', 'short legs', 'long torso'];
// Gemini's skin-zoning regex included bare 'black', which false-positives on clothing ("black hijab", "black boots").
// WIGGLY deviation: only skin phrases count.
const DARK_SKIN = /\b(?:dark|brown|warm brown|deep brown|ebony|black)(?:[- ]skin(?:ned)?)\b|\bskin(?: tone)?(?: is)?(?: an?)? (?:(?:warm|deep|dark|rich|medium|light)\s+){0,3}(?:brown|ebony|dark|black)\b/i;
const LIVE_ACTION = [['photorealistic', /photorealistic/i], ['film stock', /film stock/i], ['grain', /\bgrain\b/i], ['kodak', /\bkodak\b/i], ['35mm', /\b35\s?mm\b/i], ['pore detail', /pore detail/i]];
// WIGGLY extras (same negation rule), plus 'minor' which trips the image filter.
const WIGGLY_JARGON = [['hyperrealistic', /hyperrealistic/i], ['live-action', /live[- ]action/i], ['8k', /\b8k\b/i], ['4k', /\b4k\b/i], ['octane', /\boctane\b/i], ['unreal engine', /unreal engine/i], ['minor', /\bminor\b/i]];
const negated = (text, re) => {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m; while ((m = g.exec(text))) { const before = text.slice(Math.max(0, m.index - 4), m.index).toLowerCase(); if (!/(no |not )$/.test(before)) return false; }
  return true;
};
export const HIJAB_LINE = /no visible hair,? hairline,? (?:or|and) dark band/i;
const HAIR_VISIBLE = /\b(visible fringe|bangs|loose strands? (?:show|visible|peek)|hair (?:peeks|showing|visible|spills)|hairline (?:shows|showing|visible)|strands escaping)\b/i;
const TEEN_WORDS = /\b(teen|teenage|teenager|late teens|(?:thirteen|fourteen|fifteen|sixteen|seventeen|1[3-7])[- ]year[- ]old)\b/i;

/** Gemini base + Wiggly per-character checks. `c` is one character object. */
export function validateCharacterArchitectOutput(c, { pathPrefix = '' } = {}) {
  const issues = [];
  const P = (s) => (pathPrefix ? `${pathPrefix}.${s}` : s);
  const err = (code, message, path) => issues.push({ severity: 'error', code, message, path: P(path) });
  const warn = (code, message, path) => issues.push({ severity: 'warning', code, message, path: P(path) });
  const ds = c?.designSpecs ?? {};
  const master = c?.masterRenderPrompt?.promptText ?? '';
  const sheet = c?.modelSheetPrompt?.promptText;
  const prompts = [['masterRenderPrompt', master], ...(sheet !== undefined ? [['modelSheetPrompt', sheet]] : [])];

  // ---- Gemini: master render ----
  if (c?.masterRenderPrompt) {
    if (!master.includes(MASTER_OPENING)) err('INVALID_OPENING_LINE', `Master prompt must open with exactly: "${MASTER_OPENING}"`, 'masterRenderPrompt.promptText');
    for (const l of TEMPLATE_LABELS) if (!master.includes(l)) err('MISSING_TEMPLATE_LABEL', `Master prompt is missing the template label "${l}"`, 'masterRenderPrompt.promptText');
  }
  for (const [k, t] of prompts) {
    if (HELD.test(t) || CARRY.test(t) || IN_HANDS.test(t))
      err('HELD_OBJECT_VIOLATION', 'Empty Hands Law Violated: Nothing may be held in character hands in reference renders. Held props eat attention and lock the pose.', `${k}.promptText`);
    if (INK.test(t.replace(INK_NEGATION, '')))
      err(k === 'modelSheetPrompt' ? 'SHEET_SKIN_INK_VIOLATION' : 'SKIN_INK_VIOLATION', `Never put ink, pen, or drawn marks on skin (${k}). A biro mark renders as a tattoo every time.`, `${k}.promptText`);
    if (ds.headsTall >= 6.5) {
      const tok = CHILD_TOKENS.find((x) => t.toLowerCase().includes(x));
      if (tok) err('BOBBLEHEAD_ADULT_VIOLATION', `Adult character (${ds.headsTall} heads) contains child proportion token "${tok}" in ${k}. Bobblehead Anti-Pattern.`, `${k}.promptText`);
    }
    if (ds.headsTall <= 5) {
      if (k === 'masterRenderPrompt' && !/heads tall/i.test(t)) warn('MISSING_HEAD_RATIO', 'Child prompt should state its height in "heads tall".', `${k}.promptText`);
      if (/round belly/i.test(t)) err('CHILD_ROUND_BELLY_VIOLATION', `Child prompt contains "round belly" (${k}); use 'slim, flat torso and let head size carry the age'.`, `${k}.promptText`);
    }
    for (const [label, re] of LIVE_ACTION) if (re.test(t) && !negated(t, re))
      err('BANNED_LIVE_ACTION_JARGON', `Live-action jargon '${label}' found in ${k}; the look block is the opposite of live-action.`, `${k}.promptText`);
    // ---- Wiggly per prompt ----
    if (/[\r\n]/.test(t)) err('MULTILINE_PROMPT', `${k} must be a single line for Google Flow.`, `${k}.promptText`);
    for (const [label, re] of WIGGLY_JARGON) if (re.test(t) && !negated(t, re))
      err('BANNED_JARGON', `Forbidden jargon '${label}' found in ${k}. Use plain language instead.`, `${k}.promptText`);
    if (/gpt[- ]?image|seedream|midjourney|dall-?e/i.test(t)) err('WRONG_IMAGE_ENGINE', `${k} names another image engine; target is ${IMAGE_ENGINE} (Google Flow).`, `${k}.promptText`);
  }
  if (c?.masterRenderPrompt && DARK_SKIN.test(master) && (ds.skinZoning !== 'deep' || /pink nose tip/i.test(master)))
    err('SKIN_ZONING_MISMATCH', 'Dark or brown skin requires Deep Skin Zoning (no pink nose tip); the light setting turns dark skin grey and ashen.', 'designSpecs.skinZoning');

  // ---- Gemini: model sheet ----
  if (sheet !== undefined) {
    if (!sheet.includes('#B5B5B5')) err('MISSING_HEX_LOCK', 'Model sheet must lock the backdrop to #B5B5B5.', 'modelSheetPrompt.promptText');
    if (!sheet.includes('TOP ROW — TURNAROUND:')) err('MISSING_TURNAROUND_ROW', 'Model sheet is missing "TOP ROW — TURNAROUND:".', 'modelSheetPrompt.promptText');
    for (const v of ['front view', 'three-quarter', 'profile', 'back view'])
      if (!sheet.toLowerCase().includes(v)) err('MISSING_TURNAROUND_VIEW', `Model sheet turnaround is missing the ${v}.`, 'modelSheetPrompt.promptText');
    SHEET_EXPRESSIONS.forEach((e, i) => { if (!sheet.includes(`${i + 1}) ${e}`)) err('MISSING_EXPRESSION', `Model sheet is missing expression "${i + 1}) ${e}".`, 'modelSheetPrompt.promptText'); });
  }

  // ---- Wiggly per character (only when the Wiggly fields are present) ----
  for (const [k, eng] of [['masterRenderPrompt', c?.masterRenderPrompt?.targetEngine], ['modelSheetPrompt', c?.modelSheetPrompt?.targetEngine]])
    if (eng !== undefined && eng !== IMAGE_ENGINE) err('WRONG_IMAGE_ENGINE', `${k}.targetEngine must be ${IMAGE_ENGINE}, not '${eng}'.`, `${k}.targetEngine`);
  if (ds.headsTall >= 6.5 && ds.isChildProportionRiderApplied)
    err('BOBBLEHEAD', 'Bobblehead Anti-Pattern: Adult character (>=6.5 heads) cannot have child proportion rider applied!', 'designSpecs.isChildProportionRiderApplied');
  if (ds.headsTall <= 5.0 && ds.isChildProportionRiderApplied === false)
    err('CHILD_RIDER_MISSING', 'Child Proportion Rider is MANDATORY for young characters (<= 5.0 heads tall) to prevent adult long legs', 'designSpecs.isChildProportionRiderApplied');
  if (c?.skinTone) for (const [k, t] of prompts)
    if (!t.toLowerCase().includes(c.skinTone.toLowerCase())) err('MISSING_SKIN_TONE', `${k} does not name skin tone '${c.skinTone}'.`, `${k}.promptText`);
  // Hijab is a creative rule in role.md only; no code check (Shaz, Oct 15).
  if ((c?.age >= 13 && c?.age <= 17) || prompts.some(([, t]) => TEEN_WORDS.test(t)))
    err('UNDERAGE_DEPICTION', `${c?.elementTag ?? 'character'}: teens are depicted as eighteen; found age ${c?.age} or teen wording.`, 'age');

  const errors = issues.filter((i) => i.severity === 'error').map((i) => i.message);
  const warnings = issues.filter((i) => i.severity === 'warning').map((i) => i.message);
  return { isValid: errors.length === 0, errors, warnings, issues };
}

/** Wiggly cast-level gate: every character + TAG_PARITY with the Story Director cast + PROMPT_LENGTH + mode rules. */
export function validateCharacterSheets(data, story) {
  const issues = [];
  const err = (code, message, path) => issues.push({ severity: 'error', code, message, path });
  const chars = data?.characters ?? [];
  const castTags = new Set((story?.cast ?? []).map((c) => c.elementTag));
  const sheetTags = new Set(chars.map((c) => c.elementTag));
  for (const t of castTags) if (!sheetTags.has(t)) err('TAG_PARITY', `Story cast member ${t} has no character entry.`, 'characters');
  for (const t of sheetTags) if (!castTags.has(t)) err('TAG_PARITY', `Character ${t} is not in the Story Director cast.`, 'characters');
  chars.forEach((c, i) => {
    const p = `characters.${i}`;
    issues.push(...validateCharacterArchitectOutput(c, { pathPrefix: p }).issues);
    const sheet = c.modelSheetPrompt?.promptText;
    if (data.mode === 'model-sheet') {
      if (sheet === undefined) err('MISSING_MODEL_SHEET', `${c.elementTag}: model-sheet mode needs a modelSheetPrompt.`, p);
      else {
        if (sheet.length < SHEET_MIN || sheet.length > SHEET_MAX)
          err('PROMPT_LENGTH', `${c.elementTag}: modelSheetPrompt is ${sheet.length} characters; must be ${SHEET_MIN}-${SHEET_MAX}.`, `${p}.modelSheetPrompt.promptText`);
        if (!/attached approved master render/i.test(sheet) || !c.modelSheetPrompt.masterRenderRef)
          err('MASTER_RENDER_NOT_REFERENCED', `${c.elementTag}: model sheet must match the attached approved master render (masterRenderRef).`, `${p}.modelSheetPrompt`);
      }
    } else if (sheet !== undefined) err('WRONG_MODE', `${c.elementTag}: master-render mode outputs master renders only.`, `${p}.modelSheetPrompt`);
  });
  const errors = issues.filter((i) => i.severity === 'error').map((i) => i.message);
  const warnings = issues.filter((i) => i.severity === 'warning').map((i) => i.message);
  return { isValid: errors.length === 0, errors, warnings, issues };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, storyFile] = process.argv.slice(2);
  if (!file || !storyFile) { console.error('usage: check-character-sheets.mjs <ca-output.json> <story-director.json>'); process.exit(2); }
  let d, s;
  try { d = JSON.parse(readFileSync(file, 'utf8')); s = JSON.parse(readFileSync(storyFile, 'utf8')); }
  catch (e) { console.error('cannot read JSON: ' + e.message); process.exit(2); }
  const r = validateCharacterSheets(d, s);
  for (const i of r.issues) console.log(`${i.severity.toUpperCase()} ${i.code}: ${i.message}`);
  if (!r.isValid) { console.log(`FAIL (${r.errors.length} errors, ${r.warnings.length} warnings)`); process.exit(1); }
  console.log(`PASS: ${d.mode}, ${d.characters.length} characters, ${r.warnings.length} warnings`);
}
