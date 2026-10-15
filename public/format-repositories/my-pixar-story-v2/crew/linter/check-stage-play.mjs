#!/usr/bin/env node
// v2 deterministic validation gate for a Story Director stage play.
// Usage: node check-stage-play.mjs <stage-play.json>     (exit 0 PASS, 1 FAIL, 2 usage/parse)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StagePlay, DIALOGUE_RE } from '../story-director/schema.mjs';

export const MAX_PART_SECONDS = 30;
export const MAX_TOTAL_SECONDS = 90;
export const MIN_SHOT_SECONDS = 2;
const words = s => (s.trim().match(/\S+/g) ?? []).length;
/** Whole-second budget for a spoken line: <=6 words 2s, <=12 3s, <=18 4s, longer is not allowed. */
export function lineBudget(n) { return n <= 6 ? 2 : n <= 12 ? 3 : n <= 18 ? 4 : null; }
const BANNED = /\b(photorealistic|hyperrealistic|35mm|film grain|live[- ]action|8k|4k|octane|unreal engine|trending on artstation)\b/i;
const HAIR_VISIBLE = /\b(visible hair|hairline showing|bangs|fringe|loose hair|hair (?:peeks|showing|visible))\b/i;

export function lintStagePlay(raw) {
  const r = StagePlay.safeParse(raw);
  if (!r.success) return r.error.issues.map(i => `schema ${i.path.join('.') || '(root)'}: ${i.message}`);
  const doc = r.data, errs = [];
  const castIds = new Set(doc.cast.map(c => c.id));
  const locIds = new Set(doc.locations.map(l => l.id));
  const used = new Set();

  // Cast rules
  for (const c of doc.cast) {
    const age = Number((c.ageVariant.match(/\d+/) ?? [])[0]);
    if (age >= 13 && age <= 17) errs.push(`cast ${c.id}: teen shown as ${age}; teens must be depicted as 18`);
    if (c.minor && age >= 13) errs.push(`cast ${c.id}: minor=true but age ${age} (teens are drawn as 18, minor=false)`);
    if (c.gender === 'female' && c.family) {
      if (!/hijab/i.test(c.look)) errs.push(`cast ${c.id}: female family member without hijab in look`);
      if (HAIR_VISIBLE.test(c.look)) errs.push(`cast ${c.id}: look shows hair under/around the hijab`);
    }
  }

  // Parts / timecodes
  const partSec = new Map(); let total = 0; const seenShot = new Set();
  let lastPart = 0;
  for (const b of doc.beats) {
    const tag = `beat ${b.beat}`;
    if (b.part < lastPart) errs.push(`${tag}: part ${b.part} out of order`);
    lastPart = b.part;
    partSec.set(b.part, (partSec.get(b.part) ?? 0) + b.durationSeconds);
    total += b.durationSeconds;
    let t = 0;
    const shotDur = new Map();
    for (const s of b.shots) {
      const id = `${tag} ${s.id}`;
      if (seenShot.has(s.id)) errs.push(`${id}: duplicate shot id`);
      seenShot.add(s.id);
      if (s.start !== t) errs.push(`${id}: starts at ${s.start}, expected ${t} (${s.start > t ? 'gap' : 'overlap'})`);
      const d = s.end - s.start;
      if (d < MIN_SHOT_SECONDS) errs.push(`${id}: ${d}s < ${MIN_SHOT_SECONDS}s minimum`);
      shotDur.set(s.id, d); t = s.end;
      if (!locIds.has(s.locationId)) errs.push(`${id}: unknown location ${s.locationId}`);
      for (const c of s.characterIds) { if (!castIds.has(c)) errs.push(`${id}: unknown cast id ${c}`); used.add(c); }
    }
    if (t !== b.durationSeconds) errs.push(`${tag}: shots end at ${t}, expected ${b.durationSeconds}`);

    // Dialogue format, parity, timing budget
    const perShot = new Map();
    for (const q of b.dialogue) {
      const m = q.line.match(DIALOGUE_RE);
      const [, spk, text] = m;
      if (!castIds.has(spk)) errs.push(`${tag}: speaker @${spk} not in cast`);
      used.add(spk);
      if (!shotDur.has(q.shotId)) { errs.push(`${tag}: dialogue on unknown shot ${q.shotId}`); continue; }
      const shot = b.shots.find(s => s.id === q.shotId);
      if (!shot.characterIds.includes(spk)) errs.push(`${tag} ${q.shotId}: @${spk} speaks but is not in frame`);
      const need = lineBudget(words(text));
      if (need === null) errs.push(`${tag}: line over 18 words: ${text}`);
      else if (q.seconds < need) errs.push(`${tag}: line "${text}" given ${q.seconds}s, budget ${need}s`);
      perShot.set(q.shotId, (perShot.get(q.shotId) ?? 0) + q.seconds);
    }
    for (const [sid, need] of perShot) if (need > shotDur.get(sid)) errs.push(`${tag} ${sid}: ${need}s of dialogue in a ${shotDur.get(sid)}s shot`);
    if (b.narration.includes('/')) errs.push(`${tag}: slash in narration`);
    if (words(b.narration) / 2.5 > b.durationSeconds) errs.push(`${tag}: narration ${words(b.narration)} words won't fit ${b.durationSeconds}s`);
  }
  for (const [p, s] of partSec) if (s > MAX_PART_SECONDS) errs.push(`part ${p}: ${s}s > ${MAX_PART_SECONDS}s segment ceiling`);
  if (total > MAX_TOTAL_SECONDS) errs.push(`film ${total}s > ${MAX_TOTAL_SECONDS}s total`);
  for (const id of castIds) if (!used.has(id)) errs.push(`cast ${id}: never appears in any shot or line`);

  if (/[\r\n]/.test(doc.storyboardPrompt)) errs.push('storyboardPrompt must be a single line (Google Flow)');
  if (/gpt[- ]?image/i.test(doc.storyboardPrompt)) errs.push('storyboardPrompt targets GPT Image; must be Nano Banana 2.1');
  const { deckHtml, ...rest } = doc;
  const m = (JSON.stringify(rest) + deckHtml).match(BANNED);
  if (m) errs.push(`banned jargon: ${m[0]}`);
  return errs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('usage: check-stage-play.mjs <file.json>'); process.exit(2); }
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error('cannot read JSON: ' + e.message); process.exit(2); }
  const errs = lintStagePlay(doc);
  if (errs.length) { console.log(`FAIL (${errs.length})`); for (const e of errs) console.log(' - ' + e); process.exit(1); }
  const secs = doc.beats.reduce((n, b) => n + b.durationSeconds, 0);
  console.log(`PASS: ${doc.beats.length} beats, ${new Set(doc.beats.map(b => b.part)).size} parts, ${doc.beats.reduce((n, b) => n + b.shots.length, 0)} shots, ${secs}s total`);
}
