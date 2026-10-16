#!/usr/bin/env node
// v2 deterministic gate for Seedance Compiler output.
// BASE: Gemini's per-segment checks (gemini-sc-gate.md), his codes. validateSeedanceSegment() runs them on one segment.
// WIGGLY: validateSeedancePrompts() adds approved-asset binding, cast/location coverage, stage-play verbatim dialogue,
// timing budget, engine/resolution, Extend chain, URL ban, family rules, 180s cap, CLI.
// Return shape: { isValid, errors, warnings, issues[{severity, code, message, path}] }.
// Usage: node check-seedance-prompts.mjs <sc-output.json> <seedance-compiler-input.json>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VIDEO_ENGINE, VIDEO_RESOLUTION, MAX_SEGMENT_SECONDS, MAX_TOTAL_SECONDS, BLOCK_HEADERS, headerPositions } from '../seedance-compiler/schema.mjs';

import { WORDS_PER_SECOND, budgetMessage } from './speech.mjs';
export { WORDS_PER_SECOND };
const heardOnly = (d) => !!(d?.isVoiceover || d?.isOffCamera || /^(voiceover|off[- _]?camera)$/i.test(d?.mode ?? ''));
export const DIALOGUE_EXCLUSION = 'The only spoken words in the entire segment are the lines in braces';
export const REFERENCE_CLOSING = 'Each reference is one person or one object and appears once';
const SHOT_HEADER = /SHOT\s+(\d+)\s*\|\s*([0-9.]+)[–-]([0-9.]+)s/g;
const NON_SPEAKER_LABELS = ['Camera', 'Room', 'Lighting', 'Pose', 'Eyes', 'Face', 'Silhouette', 'Hair', 'Wardrobe', 'Background', 'SHOT', 'Location', 'Identity'];
const URLISH = /\b(?:https?:\/\/|file:\/\/|s3:\/\/)\S+|(?:\/Users|\/home|\/tmp|~)\/\S+|\b[\w-]+\.(?:jpe?g|png|heic|webp|mp4|mov)\b/i;
const TEEN_WORDS = /\b(teen|teens|teenage|teenager|minor|(?:thirteen|fourteen|fifteen|sixteen|seventeen|1[3-7])[- ]year[- ]old)\b/i;
const LIVE_ACTION = [['photorealistic', /photorealistic/i], ['film stock', /film stock/i], ['film grain', /film grain/i], ['kodak', /\bkodak\b/i],
  ['35mm', /\b35\s?mm\b/i], ['live action', /live[- ]action/i], ['lens flare', /lens flare/i], ['hyperrealistic', /hyperrealistic/i],
  ['8k', /\b8k\b/i], ['4k', /\b4k\b/i], ['octane', /\boctane\b/i], ['unreal engine', /unreal engine/i]];
const PHYSICS = [['anticipation', /anticipation/i], ['moving hold', /moving hold/i], ['snap', /\bsnap/i], ['honest', /\bhonest\b/i]];
const unNegatedHit = (text, re) => {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m; while ((m = g.exec(text))) if (!/\b(no|not) $/i.test(text.slice(Math.max(0, m.index - 4), m.index))) return true;
  return false;
};
const words = (line) => line.replace(/[{}]/g, ' ').trim().split(/\s+/).filter(Boolean).length;

/** Split a compiled prompt into its blocks by header (body text only). */
export function splitBlocks(text) {
  const pos = headerPositions(text);
  const out = {};
  BLOCK_HEADERS.forEach((h, i) => {
    if (pos[i] < 0) return;
    const after = pos.filter((p) => p > pos[i]);
    out[h] = text.slice(pos[i] + h.length, after.length ? Math.min(...after) : text.length).trim();
  });
  return out;
}

/** Gemini base: one segment. */
export function validateSeedanceSegment(seg, { pathPrefix = '' } = {}) {
  const issues = [];
  const P = (s) => (pathPrefix ? `${pathPrefix}.${s}` : s);
  const err = (code, message, path = 'compiledPrompt') => issues.push({ severity: 'error', code, message, path: P(path) });
  const warn = (code, message, path = 'compiledPrompt') => issues.push({ severity: 'warning', code, message, path: P(path) });
  const t = seg?.compiledPrompt ?? '';
  // 1 blocks
  const pos = headerPositions(t);
  pos.forEach((p, i) => { if (p < 0) err('MISSING_SCHEMA_BLOCK', `Missing block ${BLOCK_HEADERS[i]}.`); });
  let last = -1;
  pos.forEach((p, i) => { if (p < 0) return; if (p < last) err('OUT_OF_ORDER_BLOCK', `${BLOCK_HEADERS[i]} is out of order.`); last = Math.max(last, p); });
  const B = splitBlocks(t);
  const shotsText = seg?.tenBlocks?.block5_shots ?? B['[SHOTS]'] ?? '';
  const audio = seg?.tenBlocks?.block8_audio ?? B['[AUDIO]'] ?? '';
  // 2 timecodes
  const headers = [...shotsText.matchAll(SHOT_HEADER)];
  if (!headers.length) err('NO_SHOTS_FOUND', 'No "SHOT N | a–bs" headers found in [SHOTS].');
  let prevEnd = 0;
  headers.forEach((m, i) => {
    const [a, b] = [m[2], m[3]];
    if (a.includes('.') || b.includes('.')) err('DECIMAL_TIMECODE_DETECTED', `SHOT ${m[1]}: timecodes must be whole seconds (${a}–${b}s).`);
    const s = Number(a), e = Number(b);
    if (!(e > s)) err('INVALID_TIMECODE_RANGE', `SHOT ${m[1]}: end must be after start.`);
    if (s !== prevEnd) err('TIMECODE_DISCONTINUITY', `SHOT ${m[1]} starts at ${s}s; expected ${prevEnd}s.`);
    if (e > MAX_SEGMENT_SECONDS) err('RUNTIME_CEILING_EXCEEDED', `SHOT ${m[1]} ends at ${e}s, past the ${MAX_SEGMENT_SECONDS}s ceiling.`);
    prevEnd = e;
  });
  // 3 cut terminators / pans
  for (const blk of shotsText.split(/(?=SHOT\s+\d+\s*\|)/).filter((x) => /^SHOT\s+\d+/.test(x.trim()))) {
    const n = blk.match(/SHOT\s+(\d+)/)[1];
    if (!/Hard cut\.\s*$/.test(blk.trim())) err('MISSING_HARD_CUT_TERMINATOR', `SHOT ${n} must end with "Hard cut."`);
    if (/\bpan(s|ning|ned)?\b/i.test(blk) && !/One continuous move/.test(blk)) warn('UNMARKED_CONTINUOUS_PAN', `SHOT ${n} pans without "One continuous move — the camera never stops and never cuts."`);
  }
  // 4 dialogue syntax + laws
  for (const line of shotsText.split('\n').map((l) => l.trim())) {
    if (/^@([\w_]+)\s*(?:,[^:]*)?:/.test(line) && !/\{.+\}/.test(line)) err('UNBRACKETED_DIALOGUE', `Dialogue must be in braces: "${line}"`);
    const m = line.match(/^([A-Z][\w_]+)\s*:\s*\{/);
    if (m && !NON_SPEAKER_LABELS.includes(m[1])) err('MISSING_SPEAKER_HANDLE_AT', `Speaker "${m[1]}" needs an @ handle.`);
  }
  if (!t.includes(REFERENCE_CLOSING)) err('MISSING_REFERENCE_CLOSING_LAW', `[REFERENCE MATERIALS] must close with "${REFERENCE_CLOSING}. No duplicates."`); // WIGGLY: error (Gemini: warning)
  const goal = seg?.tenBlocks?.block3_goal ?? B['[GOAL]'] ?? '';
  if (!/ends the instant|do not continue|do not resolve/i.test(goal)) warn('MISSING_HARD_NARRATIVE_STOP', '[GOAL] should state the hard narrative stop ("It ends the instant…").', 'tenBlocks.block3_goal');
  if (!t.includes(DIALOGUE_EXCLUSION)) err('MISSING_DIALOGUE_EXCLUSION', `[EXCLUSIONS] must include "${DIALOGUE_EXCLUSION}."`);
  // 5 audio
  if (/[{}]/.test(audio)) err('DIALOGUE_IN_AUDIO_BLOCK', '[AUDIO] must contain zero dialogue (no braces).', 'tenBlocks.block8_audio');
  // 6 tags
  const refs = B['[REFERENCE MATERIALS]'] ?? seg?.tenBlocks?.block1_referenceMaterials ?? '';
  const registered = new Set([...refs.matchAll(/^@([\w_]+)\s*=/gm)].map((m) => '@' + m[1]));
  const attached = new Set(seg?.attachedElements ?? []);
  for (const m of shotsText.matchAll(/@([\w_]+)/g)) {
    const tag = '@' + m[1];
    if (/^@(Image|Loc)$/.test(tag)) { err('SLOT_TAG_IN_PROMPT', `Use element names, not ${tag} N slots.`); continue; } // WIGGLY
    if (!registered.has(tag)) err('UNREGISTERED_ELEMENT_TAG', `${tag} is used in [SHOTS] but not bound in [REFERENCE MATERIALS].`);
    else if (seg?.attachedElements && !attached.has(tag)) warn('UNATTACHED_ELEMENT_METADATA', `${tag} is not in attachedElements.`, 'attachedElements');
  }
  if (/@(?:Image|Loc) \d+/.test(t) && !issues.some((i) => i.code === 'SLOT_TAG_IN_PROMPT')) err('SLOT_TAG_IN_PROMPT', 'Use element names, never @Image N / @Loc N, in the prompt.');
  // 7 jargon
  for (const [label, re] of LIVE_ACTION) if (unNegatedHit(t, re)) err('BANNED_LIVE_ACTION_JARGON', `Live-action jargon '${label}' found; the look is production CG.`);
  // 8 physics
  const cam = seg?.tenBlocks?.block7_cameraAndPerformance ?? B['[CAMERA AND PERFORMANCE]'] ?? '';
  for (const [label, re] of PHYSICS) if (!re.test(cam)) warn('MISSING_ANIMATION_PHYSICS', `[CAMERA AND PERFORMANCE] should cover '${label}'.`, 'tenBlocks.block7_cameraAndPerformance');
  // WIGGLY: payload + structured shots agree with headers
  const gp = seg?.generationPayload ?? {};
  if (gp.engine !== VIDEO_ENGINE) err('WRONG_ENGINE', `engine must be ${VIDEO_ENGINE}, not '${gp.engine}'.`, 'generationPayload.engine');
  if (/\b(kling|veo|sora|runway|hailuo|higgsfield|volcano engine|seedance[- ]?(?:1|2\.0|2\.1))\b/i.test(t)) err('WRONG_ENGINE', 'Prompt names another video engine.');
  if (gp.resolution !== VIDEO_RESOLUTION) err('WRONG_RESOLUTION', `resolution must be ${VIDEO_RESOLUTION}, not '${gp.resolution}'.`, 'generationPayload.resolution');
  if (/\b(720p|1080p|2k|4k)\b/i.test(t)) err('WRONG_RESOLUTION', 'Prompt asks for a different resolution.');
  if (URLISH.test(t) || (seg?.references ?? []).some((r) => URLISH.test(r.assetKey ?? '') || /^[a-z]+:\/\//i.test(r.assetKey ?? '')))
    err('URL_IN_PROMPT', 'URLs, file paths or file names are not allowed; bind references by tag + approved asset key.');
  if (seg?.shots && headers.length && (seg.shots.length !== headers.length || seg.shots.some((s, i) => +headers[i][2] !== s.startSec || +headers[i][3] !== s.endSec)))
    err('SHOT_HEADER_MISMATCH', 'Structured shots and SHOT headers in [SHOTS] disagree.', 'shots');
  if (TEEN_WORDS.test(t)) err('UNDERAGE_DEPICTION', 'Teen/minor wording; teens are depicted as eighteen.');
  const errors = issues.filter((i) => i.severity === 'error').map((i) => i.message);
  const warnings = issues.filter((i) => i.severity === 'warning').map((i) => i.message);
  return { isValid: errors.length === 0, errors, warnings, issues };
}

/** Wiggly film-level gate. `input` is the Seedance Compiler input slice. */
export function validateSeedancePrompts(data, input) {
  const issues = [];
  const err = (code, message, path) => issues.push({ severity: 'error', code, message, path });
  const segs = data?.segments ?? [];
  const cast = new Map((input?.cast ?? []).map((c) => [c.elementTag, c]));
  const approved = new Map((input?.references ?? []).map((r) => [r.tag, r]));
  const locBySetting = new Map((input?.locations ?? []).map((l) => [l.settingName, l.elementName]));
  const srcSegs = new Map((input?.segments ?? []).map((s) => [s.segmentId, s]));
  let total = 0;
  segs.forEach((seg, i) => {
    const p = `segments.${i}`;
    issues.push(...validateSeedanceSegment(seg, { pathPrefix: p }).issues);
    const t = seg.compiledPrompt ?? '';
    total += seg.totalDurationSec ?? 0;
    if (i > 0 && seg.extendsFrom !== i) err('MISSING_EXTEND', `${p}: segment ${i + 1} must extend from segment ${i}.`, `${p}.extendsFrom`);
    const refTags = new Map((seg.references ?? []).map((r) => [r.tag, r]));
    for (const [tag, r] of refTags) {
      const a = approved.get(tag);
      if (!a || a.assetKey !== r.assetKey) err('UNKNOWN_REFERENCE_TAG', `${p}: reference ${tag} is not bound to its approved asset key.`, `${p}.references`);
      if (!new RegExp(`^${tag}\\s*=`, 'm').test(t)) err('UNKNOWN_REFERENCE_TAG', `${p}: reference ${tag} is not bound in [REFERENCE MATERIALS] ("${tag} = …").`, `${p}.compiledPrompt`);
    }
    const bound = new Set([...refTags.values()].filter((r) => r.kind === 'character').map((r) => r.tag));
    const src = srcSegs.get(seg.segmentId);
    if (!src) err('UNKNOWN_SEGMENT', `${p}: segmentId ${seg.segmentId} is not in the stage play.`, `${p}.segmentId`);
    const present = new Set();
    (seg.shots ?? []).forEach((s, j) => {
      const sp = `${p}.shots.${j}`;
      for (const c of s.cast ?? []) present.add(c);
      if (!refTags.has(s.locationTag)) err('MISSING_LOCATION_REFERENCE', `${sp}: location ${s.locationTag} is not bound in references.`, `${sp}.locationTag`);
      const srcShot = src?.shots.find((x) => x.sceneId === s.sceneId);
      if (src && !srcShot) err('UNKNOWN_SCENE_REF', `${sp}: scene ${s.sceneId} is not in stage-play segment ${seg.segmentId}.`, `${sp}.sceneId`);
      if (srcShot) {
        const want = locBySetting.get(srcShot.location);
        if (!want) err('MISSING_LOCATION_REFERENCE', `${sp}: stage-play setting "${srcShot.location}" has no approved plate.`, `${sp}.locationTag`);
        else if (want !== s.locationTag) err('MISSING_LOCATION_REFERENCE', `${sp}: scene ${s.sceneId} is in ${srcShot.location} (${want}), not ${s.locationTag}.`, `${sp}.locationTag`);
        for (const k of ['dialogue', 'narration']) if (srcShot[k] && !t.includes(srcShot[k].line))
          err('DIALOGUE_NOT_VERBATIM', `${sp}: stage-play line ${srcShot[k].line} is missing verbatim from the prompt.`, `${sp}.dialogue`);
      }
      if (s.dialogue) {
        // Voiceover / off-camera speakers are heard, not seen: they need no image reference.
        if (!heardOnly(s.dialogue)) present.add(s.dialogue.speaker);
        if (!cast.has(s.dialogue.speaker)) err('SPEAKER_NOT_IN_CAST', `${sp}: speaker ${s.dialogue.speaker} is not in the stage-play cast.`, `${sp}.dialogue.speaker`);
        const secs = s.endSec - s.startSec, n = words(s.dialogue.line);
        if (n > WORDS_PER_SECOND * secs) err('DIALOGUE_TIMING_BUDGET', budgetMessage(`${sp} (${s.startSec}s-${s.endSec}s)`, n, secs), `${sp}.dialogue.line`);
        if (!t.includes(s.dialogue.line)) err('DIALOGUE_NOT_VERBATIM', `${sp}: line ${s.dialogue.line} is not in the prompt.`, `${sp}.dialogue`);
      }
    });
    // On-camera stage-play speakers must be bound; narration and voiceover are audio only.
    for (const sh of src?.shots ?? []) if (sh.dialogue && !heardOnly(sh.dialogue)) present.add(sh.dialogue.speaker);
    for (const tag of present) {
      if (!bound.has(tag)) err('MISSING_CAST_REFERENCE', `${p}: ${tag} appears or speaks but has no bound reference.`, `${p}.references`);
      const c = cast.get(tag);
      if (c && c.age >= 13 && c.age <= 17) err('UNDERAGE_DEPICTION', `${p}: ${tag} has age ${c.age}; teens are depicted as 18.`, `${p}.references`);
    }
  });
  for (const id of srcSegs.keys()) if (!segs.some((s) => s.segmentId === id)) err('MISSING_SEGMENT', `Stage-play segment ${id} has no compiled prompt.`, 'segments');
  if (total > MAX_TOTAL_SECONDS) err('RUNTIME_CAP', `Total runtime ${total}s exceeds ${MAX_TOTAL_SECONDS}s.`, 'segments');
  const errors = issues.filter((i) => i.severity === 'error').map((i) => i.message);
  const warnings = issues.filter((i) => i.severity === 'warning').map((i) => i.message);
  return { isValid: errors.length === 0, errors, warnings, issues };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [out, inp] = process.argv.slice(2);
  if (!out || !inp) { console.error('usage: check-seedance-prompts.mjs <sc-output.json> <seedance-compiler-input.json>'); process.exit(2); }
  const r = validateSeedancePrompts(JSON.parse(readFileSync(out, 'utf8')), JSON.parse(readFileSync(inp, 'utf8')));
  for (const i of r.issues) console.log(`${i.severity.toUpperCase()} ${i.code} ${i.path}: ${i.message}`);
  console.log(r.isValid ? 'PASS' : 'FAIL'); process.exit(r.isValid ? 0 : 1);
}
