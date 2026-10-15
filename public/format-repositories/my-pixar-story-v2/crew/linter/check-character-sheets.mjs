#!/usr/bin/env node
// v2 deterministic gate for Character Architect output, checked against the Story Director output.
// Return shape matches check-stage-play.mjs: { isValid, errors, warnings, issues[{severity, code, message, path}] }.
// Usage: node check-character-sheets.mjs <sheets.json> <story-director.json>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BANNED_JARGON } from './check-stage-play.mjs';
import { IMAGE_ENGINE, PROMPT_MIN, PROMPT_MAX } from '../character-architect/schema.mjs';

const NUM_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
export const SHEET_JARGON = [
  ...BANNED_JARGON,
  // Character-sheet extras: the word 'minor' trips the image filter; packet tags must never reach the model.
  ['minor', /\bminor\b/i, 'write the age look, e.g. "an eight-year-old boy"'],
];
export const HIJAB_LINE = /no visible hair,? hairline,? (?:or|and) dark band/i;
const HAIR_VISIBLE = /\b(visible fringe|bangs|loose strands? (?:show|visible|peek)|hair (?:peeks|showing|visible|spills)|hairline (?:shows|showing|visible)|strands escaping)\b/i;
const TEEN_WORDS = /\b(teen|teenage|teenager|late teens|(?:thirteen|fourteen|fifteen|sixteen|seventeen|1[3-7])[- ]year[- ]old)\b/i;

export function validateCharacterSheets(data, story) {
  const issues = [];
  const err = (code, message, path) => issues.push({ severity: 'error', code, message, ...(path ? { path } : {}) });
  const warn = (code, message, path) => issues.push({ severity: 'warning', code, message, ...(path ? { path } : {}) });
  const chars = data?.characters ?? [];
  const cast = story?.cast ?? [];
  const castTags = new Set(cast.map((c) => c.elementTag));
  const sheetTags = new Set(chars.map((c) => c.elementTag));

  for (const t of castTags) if (!sheetTags.has(t)) err('TAG_PARITY', `Story cast member ${t} has no character sheet.`, 'characters');
  for (const t of sheetTags) if (!castTags.has(t)) err('TAG_PARITY', `Character sheet ${t} is not in the Story Director cast.`, 'characters');

  chars.forEach((c, i) => {
    const p = `characters.${i}`, tag = c.elementTag;
    const prompt = String(c.sheetPrompt ?? '');
    const castCard = cast.find((k) => k.elementTag === tag);
    if (/[\r\n]/.test(prompt)) err('MULTILINE_PROMPT', `${tag}: sheetPrompt must be a single line for Google Flow.`, p);
    if (prompt.length < PROMPT_MIN || prompt.length > PROMPT_MAX)
      err('PROMPT_LENGTH', `${tag}: sheetPrompt is ${prompt.length} characters; must be ${PROMPT_MIN}-${PROMPT_MAX}.`, p);
    const tone = String(c.skinTone ?? castCard?.skinTone ?? '').toLowerCase();
    if (!tone || !prompt.toLowerCase().includes(tone)) err('MISSING_SKIN_TONE', `${tag}: sheetPrompt does not name skin tone '${tone}'.`, p);
    if (castCard && c.skinTone && castCard.skinTone && c.skinTone.toLowerCase() !== castCard.skinTone.toLowerCase())
      warn('SKIN_TONE_DRIFT', `${tag}: skinTone '${c.skinTone}' differs from the Story Director cast '${castCard.skinTone}'.`, p);
    const gender = c.gender ?? castCard?.gender, family = c.family ?? castCard?.family ?? true;
    if (gender === 'female' && family !== false) {
      if (!/hijab/i.test(prompt) || !HIJAB_LINE.test(prompt))
        err('MISSING_HIJAB', `${tag}: female family member needs a hijab with 'no visible hair, hairline or dark band'.`, p);
      if (HAIR_VISIBLE.test(prompt)) err('HAIR_VISIBLE', `${tag}: sheetPrompt shows hair under or around the hijab.`, p);
    }
    const age = c.age ?? castCard?.age;
    if ((age >= 13 && age <= 17) || TEEN_WORDS.test(prompt))
      err('UNDERAGE_DEPICTION', `${tag}: teens are depicted as eighteen; found age ${age} or teen wording in the prompt.`, p);
    const n = c.expressionCount;
    const stated = Number.isInteger(n) && new RegExp(`\\bexactly (?:${n}|${NUM_WORDS[n] ?? '_'})\\b[^.]{0,60}\\b(?:expressions?|portraits?|faces?)\\b`, 'i').test(prompt);
    if (!stated || (c.expressions ?? []).length !== n)
      err('EXPRESSION_COUNT_NOT_STATED', `${tag}: prompt must say 'exactly ${NUM_WORDS[n] ?? n} expressions' matching expressionCount.`, p);
    if ((c.targetEngine ?? IMAGE_ENGINE) !== IMAGE_ENGINE || /gpt[- ]?image|midjourney|dall-?e/i.test(prompt))
      err('WRONG_IMAGE_ENGINE', `${tag}: character sheets must target ${IMAGE_ENGINE} (Google Flow).`, p);
    for (const [label, re, plain] of SHEET_JARGON) if (re.test(prompt))
      err('BANNED_JARGON', `Forbidden jargon '${label}' found in ${tag} sheetPrompt. Use plain language instead (e.g. '${plain}')`, p);
  });

  const errors = issues.filter((i) => i.severity === 'error').map((i) => i.message);
  const warnings = issues.filter((i) => i.severity === 'warning').map((i) => i.message);
  return { isValid: errors.length === 0, errors, warnings, issues };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, storyFile] = process.argv.slice(2);
  if (!file || !storyFile) { console.error('usage: check-character-sheets.mjs <sheets.json> <story-director.json>'); process.exit(2); }
  let d, s;
  try { d = JSON.parse(readFileSync(file, 'utf8')); s = JSON.parse(readFileSync(storyFile, 'utf8')); }
  catch (e) { console.error('cannot read JSON: ' + e.message); process.exit(2); }
  const r = validateCharacterSheets(d, s);
  for (const i of r.issues) console.log(`${i.severity.toUpperCase()} ${i.code}: ${i.message}`);
  if (!r.isValid) { console.log(`FAIL (${r.errors.length} errors, ${r.warnings.length} warnings)`); process.exit(1); }
  console.log(`PASS: ${d.characters.length} character sheets, ${r.warnings.length} warnings`);
}
