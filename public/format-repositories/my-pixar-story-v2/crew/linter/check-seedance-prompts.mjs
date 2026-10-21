#!/usr/bin/env node
import { accentOf } from '../story-director/schema.mjs';
import { validateWritingTells } from './writing-tells.mjs';
// v2 deterministic gate for Seedance Compiler output.
// BASE: Gemini's per-segment checks (gemini-sc-gate.md), his codes. validateSeedanceSegment() runs them on one segment.
// WIGGLY: validateSeedancePrompts() adds approved-asset binding, cast/location coverage, stage-play verbatim dialogue,
// timing budget, engine/resolution, Extend chain, URL ban, family rules, 180s cap, CLI.
// Return shape: { isValid, errors, warnings, issues[{severity, code, message, path}] }.
// Usage: node check-seedance-prompts.mjs <sc-output.json> <seedance-compiler-input.json>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { segmentCastPresence } from '../seedance-compiler/input.mjs';
import { checkSeedanceShotLocks } from './shot-locks.mjs';
import { VIDEO_ENGINE, VIDEO_ENGINES, VIDEO_RESOLUTION, MAX_SEGMENT_SECONDS, MAX_TOTAL_SECONDS, BLOCK_HEADERS, headerPositions, sendTimeTags } from '../seedance-compiler/schema.mjs';

import { WORDS_PER_SECOND } from './speech.mjs';
export { WORDS_PER_SECOND };
const heardOnly = (d) => !!(d?.isVoiceover || d?.isOffCamera || /^(voiceover|off[- _]?camera)$/i.test(d?.mode ?? ''));
export const SELF_CONTAINED_TELL = /\b(?:previous|prior|last|earlier) (?:segment|clip|part)\b|\b(?:last|final|end) frame\b|\bcontinu\w* (?:directly )?from\b/i;
export const DIALOGUE_EXCLUSION = 'The only spoken words in the entire segment are the lines in braces';
export const MOUTHS_CLOSED_LINE = 'No one on screen speaks; every on-screen mouth stays closed.';
const MOUTHS_CLOSED_SPEAK = /no one on screen speaks/i;
const MOUTHS_CLOSED_LIPS = /mouths?\b[^.\n]{0,30}\bstays? closed/i;
export const SILENT_LINE = 'Silent scene apart from ambience: no dialogue, no voice, no humming; every mouth stays closed and still.';
const words = (x) => String(x ?? '').replace(/[{}]/g, '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
/** First 6+ word run of a heard-only line that appears in the prompt (post-narration engines), or null. */
export function leakedNarration(line, prompt, n = 6) {
  const w = words(line), t = ` ${words(prompt).join(' ')} `;
  if (!w.length) return null;
  if (w.length < n) return t.includes(` ${w.join(' ')} `) ? w.join(' ') : null;
  for (let i = 0; i + n <= w.length; i++) { const g = w.slice(i, i + n).join(' '); if (t.includes(` ${g} `)) return g; }
  return null;
}
export const NO_MUMBLE_LINE = 'No humming, mumbling, breaths-as-words or partial words from anyone on screen.';
const NO_MUMBLE = /no humming, mumbling/i;
/** The signature garment of a Character Architect main outfit: its first item ('teal zip hoodie, jeans, ...' -> 'teal zip hoodie'). */
export const garmentOf = (outfit) => String(outfit ?? '').split(/[,;]/)[0].trim().replace(/\.$/, '');
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
// Heard-only speaker label at the start of a [SHOTS] line ("@AdultTheo, voiceover: {..}"): a voice, not an on-screen element.
const HEARD_SPEAKER_LABEL = /^(\s*)@[\w_]+(\s*,\s*(?:voice[- ]?over|off[- ]?camera)\s*:)/gim;
// WIGGLY (r4-dry15): every SHOT block states its camera direction on one line: "Camera: <framing>, <angle>, <move>."
export const CAMERA_LINE = /^\s*Camera:\s*([^,\n]+),\s*([^,\n]+),\s*([^\n]+?)\.?\s*$/m;
/** Each cast card's signature accessory as its head noun ('red knitted cap pushed back' -> cap). */
export function accessoryWords(cast = []) {
  const out = [];
  for (const c of cast) {
    const item = accentOf(c?.signatureAccent).toLowerCase().split(/\b(?:pushed|pulled|worn|on|over|around|in|with|that|which|tucked|clipped|always)\b|[,;.(]/)[0];
    const word = (item.match(/[a-z][a-z-]{2,}/g) ?? []).at(-1);
    if (word) out.push({ tag: c.elementTag, word, re: new RegExp(`\\b${word.replace(/[-]/g, '[- ]?').replace(/s$/, '')}s?\\b`, 'i') });
  }
  return out;
}
const BREATHING = /\bbreath(?:e|es|ing)?\b/i;
const BROKEN_HARD_STOP = /ends the instant[^.]*?\band do not\b/i;
const normWords = (x) => String(x ?? '').toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
/** [SHOTS] split into per-shot blocks: [{ n, text }]. */
export const shotBlocks = (shotsText) => shotsText.split(/(?=SHOT\s+\d+\s*\|)/).filter((x) => /^SHOT\s+\d+/.test(x.trim())).map((x) => ({ n: +x.match(/SHOT\s+(\d+)/)[1], text: x }));
const withoutBraces = (x) => String(x ?? '').replace(/\{[^}]*\}/g, '');

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
export function validateSeedanceSegment(seg, { pathPrefix = '', engine = VIDEO_ENGINE } = {}) {
  const cap = VIDEO_ENGINES[engine]?.segmentMaxSec ?? MAX_SEGMENT_SECONDS;
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
    if (e > cap) err('RUNTIME_CEILING_EXCEEDED', `SHOT ${m[1]} ends at ${e}s, past the ${cap}s ${engine} clip ceiling.`);
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
  for (const m of shotsText.replace(HEARD_SPEAKER_LABEL, '$1$2').matchAll(/@([\w_]+)/g)) {
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
  if (gp.engine !== engine) err('WRONG_ENGINE', `engine must be ${engine}, not '${gp.engine}'.`, 'generationPayload.engine');
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
  const engine = input?.targetEngine ?? VIDEO_ENGINE;
  const cap = input?.segmentMaxSec ?? VIDEO_ENGINES[engine]?.segmentMaxSec ?? MAX_SEGMENT_SECONDS;
  const voiceTags = new Set();
  const post = input?.postNarration ?? !!VIDEO_ENGINES[engine]?.postNarration;
  let total = 0;
  // WIGGLY clips: a staged part longer than the engine cap is split into consecutive clips at shot boundaries.
  for (const [id, src] of srcSegs) {
    for (const sh of src.shots) if (sh.endSec - sh.startSec > cap)
      err('SHOT_LONGER_THAN_CLIP_CAP', `BLOCKER: stage-play shot ${sh.sceneId} runs ${sh.endSec - sh.startSec}s, longer than ${engine}'s ${cap}s clip; it cannot be split mid-shot. The Story Director must restage it (report it in "assumptions" as BLOCKER).`, 'segments');
    const clips = segs.map((s, k) => [s, k]).filter(([s]) => s.segmentId === id);
    if (!clips.length) continue;
    const covered = clips.flatMap(([s]) => (s.shots ?? []).map((x) => x.sceneId));
    const want = src.shots.map((x) => x.sceneId);
    if (covered.join() !== want.join()) err('CLIP_SPLIT_NOT_AT_SHOTS', `Part ${id}: its clips cover shots [${covered.join(', ')}] but the stage play has [${want.join(', ')}]. Each staged shot goes into exactly one clip, in order, never split mid-shot.`, `segments.${clips[0][1]}`);
    const idx = clips.map(([, k]) => k);
    if (idx.some((k, j) => j && k !== idx[j - 1] + 1)) err('CLIP_SPLIT_NOT_AT_SHOTS', `Part ${id}: its clips must be consecutive segments.`, 'segments');
    if (clips.length > 1) clips.forEach(([s, k], j) => {
      const wantId = `${id}${String.fromCharCode(97 + j)}`;
      if (s.clipId !== wantId) err('CLIP_ID', `segments.${k}: clip ${j + 1} of part ${id} has clipId "${s.clipId ?? ''}"; use "${wantId}".`, `segments.${k}.clipId`);
    });
    for (const [s, k] of clips) {
      const first = src.shots.find((x) => x.sceneId === s.shots?.[0]?.sceneId);
      if (first && (s.sourceStartSec ?? 0) !== first.startSec) err('CLIP_SOURCE_OFFSET', `segments.${k}: sourceStartSec is ${s.sourceStartSec ?? 0} but its first shot ${first.sceneId} starts at ${first.startSec}s in the staged part.`, `segments.${k}.sourceStartSec`);
      const nums = (s.shots ?? []).map((x) => src.shots.find((y) => y.sceneId === x.sceneId)?.shotNumber);
      if (s.sourceShotNumbers && s.sourceShotNumbers.join() !== nums.join()) err('CLIP_SOURCE_SHOTS', `segments.${k}: sourceShotNumbers [${s.sourceShotNumbers.join(', ')}] must be the staged shots [${nums.join(', ')}].`, `segments.${k}.sourceShotNumbers`);
      if (clips.length > 1 && !s.sourceShotNumbers) err('CLIP_SOURCE_SHOTS', `segments.${k}: a split clip records its staged shots in sourceShotNumbers.`, `segments.${k}.sourceShotNumbers`);
      if ((s.totalDurationSec ?? 0) > cap) err('CLIP_OVER_ENGINE_CAP', `segments.${k}: ${s.totalDurationSec}s is longer than ${engine}'s ${cap}s clip. Split the part into clips at shot boundaries.`, `segments.${k}.totalDurationSec`);
    }
  }
  segs.forEach((seg, i) => {
    const p = `segments.${i}`;
    issues.push(...validateSeedanceSegment(seg, { pathPrefix: p, engine }).issues);
    const t = seg.compiledPrompt ?? '';
    total += seg.totalDurationSec ?? 0;
    if (i > 0 && VIDEO_ENGINES[engine]?.continuation === 'extend' && seg.extendsFrom !== i) err('MISSING_EXTEND', `${p}: segment ${i + 1} must extend from segment ${i}.`, `${p}.extendsFrom`);
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
        for (const k of ['dialogue', 'narration']) if (srcShot[k] && !(post && (k === 'narration' || heardOnly(srcShot[k]))) && !t.includes(srcShot[k].line))
          err('DIALOGUE_NOT_VERBATIM', `${sp}: stage-play line ${srcShot[k].line} is missing verbatim from the prompt.`, `${sp}.dialogue`);
      }
      if (s.dialogue && post && heardOnly(s.dialogue)) err('NARRATION_IN_PROMPT', `${sp}: ${engine} gets narration in post; a voiceover / off-camera line has no "dialogue" here. Drop it and describe the silent beat.`, `${sp}.dialogue`);
      else if (s.dialogue) {
        // Voiceover / off-camera speakers are heard, not seen: they need no image reference.
        if (!heardOnly(s.dialogue)) present.add(s.dialogue.speaker);
        if (!cast.has(s.dialogue.speaker)) err('SPEAKER_NOT_IN_CAST', `${sp}: speaker ${s.dialogue.speaker} is not in the stage-play cast.`, `${sp}.dialogue.speaker`);
        // speech length (dialogue + narration + pad) vs the shot: checkSeedanceShotLocks
        if (!t.includes(s.dialogue.line)) err('DIALOGUE_NOT_VERBATIM', `${sp}: line ${s.dialogue.line} is not in the prompt.`, `${sp}.dialogue`);
      }
    });
    // WIGGLY (r4-dry15): camera direction, voice-only cast, [GOAL] grammar, breathing filler.
    const shotsText = seg.tenBlocks?.block5_shots ?? '';
    for (const b of shotBlocks(shotsText)) {
      const sp = `${p}.tenBlocks.block5_shots`;
      const m = b.text.match(CAMERA_LINE);
      if (!m) { err('MISSING_CAMERA_DIRECTION', `${p}: SHOT ${b.n} needs a "Camera: <framing>, <angle>, <move>." line (from the stage play's framing, cameraAngle, cameraMove).`, sp); }
      else {
        const srcShot = src?.shots.find((x) => x.sceneId === seg.shots?.[b.n - 1]?.sceneId) ?? (seg.shots ? undefined : src?.shots.find((x) => x.shotNumber === b.n));
        const line = normWords(m[0]);
        const miss = ['framing', 'cameraAngle', 'cameraMove'].filter((k) => srcShot?.[k] && !line.includes(normWords(srcShot[k])));
        if (miss.length) issues.push({ severity: 'warning', code: 'CAMERA_DIRECTION_MISMATCH', message: `${p}: SHOT ${b.n} camera line does not match the stage play's ${miss.map((k) => `${k} "${srcShot[k]}"`).join(', ')}.`, path: sp });
      }
      if (BREATHING.test(withoutBraces(b.text))) issues.push({ severity: 'warning', code: 'FILLER_BREATHING', message: `${p}: SHOT ${b.n} uses breathing as filler action; give a concrete action or hold instead.`, path: sp });
    }
    // WIGGLY shot locks (change 5): presence, Look lock (accessories + visual tell word for word), prop states, eyes visible,
    // speaker on screen and leading, timecodes as staged, speech length. Replaces the old "accessory never in [SHOTS]" rule.
    issues.push(...checkSeedanceShotLocks(seg, src, shotBlocks(shotsText), input, p));
    // WIGGLY (Omni r5-dry6): on-screen characters lip-synced the off-screen narrator. Every shot with a heard-only line
    // says plainly that no one on screen speaks and every mouth stays closed; [VOICES] calls the narrator off screen, never seen.
    for (const b of shotBlocks(shotsText)) {
      const heard = [...b.text.matchAll(/^\s*(@[\w_]+)\s*,\s*(?:voice[- ]?over|off[- ]?camera)\s*:/gim)].map((m) => m[1]);
      for (const h of heard) voiceTags.add(h);
      if (heard.length && !(MOUTHS_CLOSED_SPEAK.test(b.text) && MOUTHS_CLOSED_LIPS.test(b.text)))
        err('VOICEOVER_MOUTHS_OPEN', `${p}: SHOT ${b.n} has a voiceover / off-camera line, so it also says "${MOUTHS_CLOSED_LINE}"`, `${p}.tenBlocks.block5_shots`);
    }
    // Multi-location clip: every shot names its place ("Location: @kitchen."), or the engine blends the rooms.
    const locRefs = (seg.references ?? []).filter((r) => r.kind === 'location').map((r) => r.tag);
    if (locRefs.length > 1) shotBlocks(shotsText).forEach((b, j) => {
      const line = b.text.split('\n').find((l) => /^\s*Location:/.test(l)) ?? '';
      const named = locRefs.filter((t) => new RegExp(`${t}\\b`).test(line)), own = seg.shots?.[j]?.locationTag;
      if (!named.length || (own && locRefs.includes(own) && !named.includes(own)))
        err('SHOT_LOCATION_MISSING', `${p}: SHOT ${b.n}: this clip has ${locRefs.length} locations (${locRefs.join(', ')}), so every shot has a line "Location: ${own && locRefs.includes(own) ? own : locRefs[0]}." naming its own location.`, `${p}.tenBlocks.block5_shots`);
    });
    // Wardrobe lock: the Look line restates the signature garment too (Omni dropped hoodies when only the accessory was named).
    const outfit = new Map((input?.characters ?? []).filter((c) => c.mainOutfit).map((c) => [c.elementTag, garmentOf(c.mainOutfit)]));
    (seg.shots ?? []).forEach((s, j) => {
      const b = shotBlocks(shotsText)[j]; if (!b) return;
      for (const tag of s.cast ?? []) {
        const g = outfit.get(tag); if (!g) continue;
        const look = b.text.split('\n').find((l) => new RegExp(`^\\s*Look ${tag}:`).test(l)) ?? '';
        if (!normWords(look).includes(normWords(g))) err('GARMENT_MISSING', `${p}: SHOT ${b.n}: ${tag} is on screen, so their Look line restates their signature garment "${g}" word for word.`, `${p}.tenBlocks.block5_shots`);
      }
    });
    const voices = seg.tenBlocks?.block2_voices ?? '';
    const heardHere = new Set((seg.shots ?? []).filter((s) => s.dialogue && heardOnly(s.dialogue)).map((s) => s.dialogue.speaker));
    for (const b of shotBlocks(shotsText)) for (const m of b.text.matchAll(/^\s*(@[\w_]+)\s*,\s*(?:voice[- ]?over|off[- ]?camera)\s*:/gim)) heardHere.add(m[1]);
    for (const tag of heardHere) {
      const line = voices.split('\n').find((l) => l.trim().startsWith(tag)) ?? '';
      // The narrator's own character can be on screen in the clip (the adult self): then the voice is still off screen, but not "never seen".
      const seen = (seg.shots ?? []).some((s) => (s.cast ?? []).includes(tag));
      const want = seen ? `An off-screen narrator voice; ${tag} on screen never speaks these lines.` : 'An off-screen narrator, never seen.';
      if (!/off[- ]screen narrator/i.test(line) || !(seen ? /never speaks these lines/i : /never seen/i).test(line))
        err('NARRATOR_NOT_OFF_SCREEN', `${p}: ${tag} has voiceover / off-camera lines here, so their [VOICES] line starts "${want}"`, `${p}.tenBlocks.block2_voices`);
    }
    if (heardHere.size && !NO_MUMBLE.test(`${seg.tenBlocks?.block8_audio ?? ''}\n${seg.tenBlocks?.block9_exclusions ?? ''}`))
      err('MUMBLE_NOT_EXCLUDED', `${p}: this clip has narration, so [EXCLUSIONS] says "${NO_MUMBLE_LINE}"`, `${p}.tenBlocks.block9_exclusions`);
    // Post narration (Omni): the engine voices any words it is given, so no heard-only line (or 6+ words of one) is in the
    // prompt, and every shot that carries narration in the stage play states the silent-scene line instead.
    if (post) for (const s of seg.shots ?? []) {
      const srcShot = src?.shots.find((x) => x.sceneId === s.sceneId); if (!srcShot) continue;
      const heardLines = [srcShot.narration, heardOnly(srcShot.dialogue) ? srcShot.dialogue : null].filter(Boolean);
      for (const h of heardLines) { const g = leakedNarration(h.line, t);
        if (g) err('NARRATION_IN_PROMPT', `${p}: scene ${s.sceneId}: the ${engine} prompt contains narration words ("${g}"). Narration is added in post; never put its words in the prompt, describe the silent beat instead.`, `${p}.compiledPrompt`); }
      const b = shotBlocks(shotsText)[s.shotNumber - 1];
      if (heardLines.length && b && !b.text.includes(SILENT_LINE)) err('SILENT_LINE_MISSING', `${p}: SHOT ${s.shotNumber} (scene ${s.sceneId}) carries narration added in post, so it says "${SILENT_LINE}"`, `${p}.tenBlocks.block5_shots`);
    }
    const maxChars = input?.promptMaxChars ?? VIDEO_ENGINES[engine]?.promptMaxChars;
    const sentLen = maxChars ? sendTimeTags(t, seg.references ?? [], engine).length : 0;
    if (maxChars && sentLen > maxChars) err('PROMPT_TOO_LONG', `${p}: compiledPrompt is ${sentLen} characters as sent (${t.length} written + ${sentLen - t.length} for the [ImageN]/[AudioN] tags added at send time); ${engine} accepts at most ${maxChars}. Tighten [VISUAL STYLE], [CAMERA AND PERFORMANCE], [CONTINUITY] and [MAINTAIN CONSISTENCY] prose; never cut a lock line, story noun or spoken line.`, `${p}.compiledPrompt`);
    // Reference images as sent: element refs plus one storyboard panel per shot that has one; the engine caps the count.
    const maxRefs = VIDEO_ENGINES[engine]?.maxRefImages;
    if (maxRefs) { const panels = new Set((seg.shots ?? []).map((s) => src?.shots.find((x) => x.sceneId === s.sceneId)?.storyboardPanel).filter(Boolean));
      const n = (seg.references ?? []).length + panels.size;
      if (n > maxRefs) err('TOO_MANY_REFERENCES', `${p}: ${n} reference images (${(seg.references ?? []).length} element refs + ${panels.size} storyboard panels); ${engine} takes at most ${maxRefs}. Split the clip at a shot boundary.`, `${p}.references`); }
    // Self-contained clips (continuation 'cut'): each clip renders alone from its references, so it never leans on another clip.
    if (VIDEO_ENGINES[engine]?.continuation === 'cut') { const m = SELF_CONTAINED_TELL.exec(t);
      if (m) err('CLIP_NOT_SELF_CONTAINED', `${p}: "${m[0]}". ${engine} renders every clip on its own (it may be re-rendered alone), so the prompt never refers to another clip or its last frame; set the scene up fully from the references.`, `${p}.compiledPrompt`); }
    // Per-clip references: only the people and places actually in this clip's shots (an extra picture invites an extra person).
    const onCam = new Set((seg.shots ?? []).flatMap((s) => [...(s.cast ?? []), ...(s.dialogue && !heardOnly(s.dialogue) ? [s.dialogue.speaker] : [])]));
    const locs = new Set((seg.shots ?? []).map((s) => s.locationTag));
    for (const r of seg.references ?? []) {
      const extra = (r.kind === 'character' && !onCam.has(r.tag)) || (r.kind === 'location' && !locs.has(r.tag));
      if (extra) issues.push({ severity: engine === VIDEO_ENGINE ? 'warning' : 'error', code: 'REFERENCE_NOT_IN_CLIP', message: `${p}: ${r.tag} is attached but is not in any of this clip's shots; attach only who and where is on screen in this clip.`, path: `${p}.references` });
    }
    const goal = seg.tenBlocks?.block3_goal ?? '';
    if (BROKEN_HARD_STOP.test(goal)) err('BROKEN_HARD_STOP', `${p}: [GOAL] hard stop is one broken sentence ("It ends the instant X ... and do not ..."). Write "It ends the instant X. Do not continue past that moment, do not resolve anything and do not add an ending."`, `${p}.tenBlocks.block3_goal`);
    const voiceOnly = src ? (src.voiceOnlyCast ?? segmentCastPresence(src, [...cast.keys()]).voiceOnlyCast) : [];
    const block1 = seg.tenBlocks?.block1_referenceMaterials ?? t;
    for (const tag of voiceOnly) {
      const where = [refTags.has(tag) && 'references', (seg.attachedElements ?? []).includes(tag) && 'attachedElements',
        new RegExp(`^${tag}\\s*=`, 'm').test(block1) && '[REFERENCE MATERIALS]', (seg.shots ?? []).some((s) => (s.cast ?? []).includes(tag)) && 'shots[].cast'].filter(Boolean);
      if (where.length) err('VOICE_ONLY_REFERENCE', `${p}: ${tag} is only heard in this part (voiceover / off camera), so attach no image of them: remove from ${where.join(', ')}.`, `${p}.references`);
    }
    // On-camera stage-play speakers must be bound; narration and voiceover are audio only.
    const clipScenes = new Set((seg.shots ?? []).map((x) => x.sceneId));
    for (const sh of src?.shots ?? []) if (clipScenes.has(sh.sceneId) || !seg.sourceShotNumbers) if (sh.dialogue && !heardOnly(sh.dialogue)) present.add(sh.dialogue.speaker);
    for (const tag of present) {
      if (!bound.has(tag)) err('MISSING_CAST_REFERENCE', `${p}: ${tag} appears or speaks but has no bound reference.`, `${p}.references`);
      const c = cast.get(tag);
      if (c && c.age >= 13 && c.age <= 17) err('UNDERAGE_DEPICTION', `${p}: ${tag} has age ${c.age}; teens are depicted as 18.`, `${p}.references`);
    }
  });
  for (const id of srcSegs.keys()) if (!segs.some((s) => s.segmentId === id)) err('MISSING_SEGMENT', `Stage-play segment ${id} has no compiled prompt.`, 'segments');
  if (total > MAX_TOTAL_SECONDS) err('RUNTIME_CAP', `Total runtime ${total}s exceeds ${MAX_TOTAL_SECONDS}s.`, 'segments');
  issues.push(...validateWritingTells('seedance-compiler', data));
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
