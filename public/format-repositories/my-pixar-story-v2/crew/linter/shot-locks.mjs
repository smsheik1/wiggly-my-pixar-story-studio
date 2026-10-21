// WIGGLY shot locks (change 5). Seedance renders each shot separately, so anything a shot does not restate drifts
// (r4: a hijab and dark glasses came and went, a phone jumped from hand to ear, look-alike sisters swapped faces).
// Generic for every family: all wording comes from the cast cards, the Character Architect's visual tells and the
// Story Director's scene locks.
//
//   Story Director   shot.onScreen      exactly who is in frame (must match the cast @tags in whatWeSee)
//                    shot.enters/exits  the only way someone appears or leaves mid-scene
//                    segment.scenes[]   { shots, present, props }: who is in the scene and each prop's one locked state
//   Character Arch.  character.visualTell  a distinct visible tell for look-alikes (drawn in the master render)
//   Seedance Comp.   every SHOT block: "On screen: @A, @B." + "Look @A: <locked wording>." + "Props: <locked state>."
//                    (locked wording = the cast card's signatureAccent + signatureAccessories + the visual tell, word for word;
//                     signatureAccent is optional: an empty / 'none' one is no accessory and is not locked)
import { accentOf } from '../story-director/schema.mjs';
import { dedupeItems } from '../seedance-compiler/look-dedupe.mjs';
import { EYES_HIDDEN } from './check-stage-play.mjs';
import { keyWords } from './answer-sources.mjs';
import { countWords, secondsNeeded, shotWords, budgetMessage, MAX_LINE_WORDS } from './speech.mjs';

const TAG = /@[\w_]+/g;
export const heardOnly = (d) => !!(d?.isVoiceover || d?.isOffCamera || /^(voiceover|off[- _]?camera)$/i.test(d?.mode ?? ''));
/** Comparison form for "word for word": case, curly quotes, spacing and a trailing full stop do not matter. */
export const lockNorm = (t) => String(t ?? '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
export const hasExact = (text, phrase) => lockNorm(text).includes(lockNorm(phrase));
/** Missing vs reworded: most of the phrase's key words are there, but not the exact wording. */
/** Head noun of an item phrase: 'red knitted cap pulled over his ears' -> 'cap'. */
export const headNoun = (phrase) => (String(phrase ?? '').toLowerCase().split(/\b(?:pushed|pulled|worn|on|over|around|in|with|that|which|tucked|clipped|always|fully|held)\b|[,;.(]/)[0].match(/[a-z][a-z-]{2,}/g) ?? []).at(-1) ?? null;
const reworded = (text, phrase) => {
  const kw = keyWords(phrase), tw = new Set(keyWords(text)), head = headNoun(phrase);
  return (!!head && new RegExp(`\\b${head.replace(/s$/, '')}s?\\b`, 'i').test(text)) || (kw.length > 0 && kw.filter((w) => tw.has(w)).length / kw.length >= 0.5);
};
/** Cast @tags in a text, in order of first mention. */
export const castTagsIn = (text, castTags) => [...new Set((String(text ?? '').match(TAG) ?? []).filter((t) => castTags.has(t)))];
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const list = (xs) => (xs.length ? xs.join(', ') : 'no one');

/** The locked wording for one character: signature accessories from the cast card, then the visual tell from the Character Architect. */
export function lockPhrases(card = {}, character = {}) {
  // signatureAccent is optional: an empty / 'none' accent (or accessory) is no accessory and is left out of the lock
  const acc = [card.signatureAccent, ...(card.signatureAccessories ?? [])].map(accentOf).filter((x) => x.length >= 3);
  const tell = String(character?.visualTell ?? '').trim();
  // one entry per item: drop an item equal to or contained in another (case-insensitive), keeping the longer one
  const out = dedupeItems([...acc.map((x) => ({ kind: 'accessory', text: x })), ...(tell ? [{ kind: 'tell', text: tell }] : [])]);
  return out;
}
/** The one "Look" line a SHOT block carries for an on-screen character. */
export const lookLine = (tag, phrases) => `Look ${tag}: ${phrases.map((p) => p.text).join('; ')}.`;

// ---------------------------------------------------------------- Story Director
/** Who is in frame: the shot's onScreen list, or (older outputs without it) the cast @tags in whatWeSee. */
export const onScreenOf = (shot, castTags) => (Array.isArray(shot?.onScreen) ? shot.onScreen : castTagsIn(shot?.whatWeSee, castTags));
/** Scene lock that holds a shot number (undefined if none). */
export const sceneOf = (seg, shotNumber) => (seg?.scenes ?? []).find((s) => (s.shots ?? []).includes(shotNumber));

/** Story Director gate: presence, scene locks, entrances/exits, speaker on screen and leading, speech length per shot. */
export function checkStageShotLocks(data) {
  const issues = [];
  const err = (code, message, path) => issues.push({ severity: 'error', code, message, path });
  const warn = (code, message, path) => issues.push({ severity: 'warning', code, message, path });
  const castTags = new Set((data?.cast ?? []).map((c) => c.elementTag));
  (data?.segments ?? []).forEach((seg, si) => {
    const P = `segments.${si}`, id = seg.segmentId ?? si + 1;
    const shots = seg.shots ?? [];
    const nums = shots.map((s, i) => s.shotNumber ?? i + 1);
    const scenes = Array.isArray(seg.scenes) ? seg.scenes : [];
    if (!scenes.length) err('SCENE_LOCK_MISSING', `Part ${id} has no scenes. Lock every scene once: scenes: [{ shots: [1, 2, ...], present: [@tags in the scene], props: ["<prop and its exact state>"] }].`, `${P}.scenes`);
    const owner = new Map();
    scenes.forEach((sc, ci) => {
      const sp = `${P}.scenes.${ci}`, sn = sc.shots ?? [];
      for (const n of sn) {
        if (!nums.includes(n)) err('SCENE_LOCK_COVERAGE', `Part ${id} scene ${ci + 1} lists shot ${n}, which does not exist.`, sp);
        else if (owner.has(n)) err('SCENE_LOCK_COVERAGE', `Part ${id} shot ${n} is in two scenes (${owner.get(n) + 1} and ${ci + 1}); each shot belongs to exactly one.`, sp);
        else owner.set(n, ci);
      }
      const idx = sn.map((n) => nums.indexOf(n)).filter((i) => i >= 0);
      if (idx.some((x, k) => k > 0 && x !== idx[k - 1] + 1)) err('SCENE_LOCK_ORDER', `Part ${id} scene ${ci + 1} shots (${sn.join(', ')}) must be consecutive and in order.`, sp);
      const locs = [...new Set(idx.map((i) => shots[i].location).filter(Boolean))];
      if (locs.length > 1) err('SCENE_LOCATION_MIXED', `Part ${id} scene ${ci + 1} spans locations ${locs.join(', ')}; a scene is one place. Split it into one scene per location.`, sp);
      for (const t of sc.present ?? []) if (!castTags.has(t)) err('SCENE_PRESENT_UNKNOWN', `Part ${id} scene ${ci + 1}: present lists ${t}, which is not a cast elementTag.`, `${sp}.present`);
      for (const [k, pr] of (sc.props ?? []).entries()) if (String(pr ?? '').trim().length < 5) err('PROP_LOCK_EMPTY', `Part ${id} scene ${ci + 1}: prop lock ${k + 1} is empty; write the prop and its exact state, e.g. "the phone held flat in @Theo's right hand, screen lit".`, `${sp}.props.${k}`);
      // seen at least once, or heard (a voice-over / off-camera line or narration counts): otherwise the person is named in
      // the scene but never in it, and the viewer never learns why. Error (r5: a listed sibling never appeared in any shot).
      const seenOrHeard = new Set(idx.flatMap((i) => [...onScreenOf(shots[i], castTags), shots[i].dialogue?.speaker, shots[i].narration?.speaker].filter(Boolean)));
      for (const t of sc.present ?? []) if (castTags.has(t) && !seenOrHeard.has(t)) err('PRESENT_NEVER_SEEN', `Part ${id} scene ${ci + 1}: ${t} is listed as present but is never on screen or heard in any of its shots. Show them in a shot (onScreen) or give them a voice-over line, or remove them from present and from the lines that name them as there.`, `${sp}.present`);
    });
    if (scenes.length) for (const n of nums) if (!owner.has(n)) err('SCENE_LOCK_COVERAGE', `Part ${id} shot ${n} is in no scene. Every shot belongs to exactly one scene lock.`, `${P}.scenes`);

    shots.forEach((shot, hi) => {
      const p = `${P}.shots.${hi}`, n = nums[hi], where = `Shot ${id}.${n}`;
      if (!Array.isArray(shot.onScreen)) err('ONSCREEN_MISSING', `${where} has no onScreen list. List exactly who is in frame (cast @tags; [] for nobody).`, `${p}.onScreen`);
      const on = onScreenOf(shot, castTags);
      for (const t of on) if (!castTags.has(t)) err('ONSCREEN_UNKNOWN', `${where}: onScreen lists ${t}, which is not a cast elementTag.`, `${p}.onScreen`);
      const seen = castTagsIn(shot.whatWeSee, castTags);
      if (Array.isArray(shot.onScreen) && !sameSet(seen, on.filter((t) => castTags.has(t))))
        err('ONSCREEN_MISMATCH', `${where}: onScreen is [${list(on)}] but whatWeSee shows [${list(seen)}]. They must name exactly the same people.`, `${p}.onScreen`);
      const sc = sceneOf(seg, n);
      if (sc) {
        const present = new Set(sc.present ?? []);
        for (const t of [...on, ...(shot.enters ?? []), ...(shot.exits ?? [])]) if (castTags.has(t) && !present.has(t))
          err('NOT_IN_SCENE', `${where}: ${t} is on screen but is not in this scene's present list. Characters do not appear without the story saying so: add ${t} to present (and to enters on the shot where they arrive), or take them out of the shot.`, `${p}.onScreen`);
        const order = (sc.shots ?? []).filter((x) => nums.includes(x));
        const k = order.indexOf(n);
        for (const t of shot.enters ?? []) {
          if (!on.includes(t)) err('ENTRANCE_NOT_SHOWN', `${where}: ${t} enters here but is not on screen in this shot.`, `${p}.enters`);
          const early = order.slice(0, k).filter((m) => onScreenOf(shots[nums.indexOf(m)], castTags).includes(t));
          if (early.length) err('APPEARS_BEFORE_ENTRANCE', `${where}: ${t} enters here but is already on screen in shot ${early.map((m) => `${id}.${m}`).join(', ')}. Move the entrance to their first shot on screen, or take them out of the earlier shots.`, `${p}.enters`);
        }
        for (const t of shot.exits ?? []) {
          if (!on.includes(t)) err('EXIT_NOT_SHOWN', `${where}: ${t} exits here but is not on screen in this shot.`, `${p}.exits`);
          const late = order.slice(k + 1).filter((m) => onScreenOf(shots[nums.indexOf(m)], castTags).includes(t));
          if (late.length) err('SHOWN_AFTER_EXIT', `${where}: ${t} exits here but is on screen again in shot ${late.map((m) => `${id}.${m}`).join(', ')}. Add an entrance or keep them out.`, `${p}.exits`);
        }
      }
      // the speaker of an on-camera line is in frame and leads the shot
      const d = shot.dialogue;
      if (d?.speaker && !heardOnly(d)) {
        if (!on.includes(d.speaker)) err('SPEAKER_NOT_ON_SCREEN', `${where}: ${d.speaker} speaks on camera but is not on screen. Put ${d.speaker} in onScreen and whatWeSee, or mark the line isOffCamera / isVoiceover.`, `${p}.dialogue`);
        else if (seen[0] !== d.speaker) err('SPEAKER_NOT_LEADING', `${where}: ${d.speaker} speaks, so whatWeSee leads with ${d.speaker} (it starts with ${seen[0] ?? 'no one'}). Start the action with the speaker.`, `${p}.whatWeSee`);
      }
      // one budget for everything spoken in the shot (dialogue then narration)
      const w = shotWords(shot), dur = (shot.endSec ?? 0) - (shot.startSec ?? 0);
      const longest = Math.max(countWords(shot.dialogue?.line), countWords(shot.narration?.line));
      if (longest > MAX_LINE_WORDS) err('DIALOGUE_TIMING_BUDGET', `${where}: a ${longest}-word line is too long for one shot (max ${MAX_LINE_WORDS} words); split it across two shots at a natural pause.`, p);
      else if (w && !shot.timingApproved && dur < secondsNeeded(w)) err('DIALOGUE_TIMING_BUDGET', budgetMessage(`${where} (${shot.startSec}s-${shot.endSec}s)`, w, dur), p);
    });
  });
  return issues;
}

// ---------------------------------------------------------------- Seedance Compiler
const LOCK_LINE = /^\s*(?:Camera|On screen|Look|Props)\b[^:\n]*:/i;
/** Lines of a SHOT block that describe action (not the header, camera, lock, dialogue or cut lines). */
export const actionLines = (blockText) => String(blockText ?? '').split('\n').map((l) => l.trim())
  .filter((l) => l && !/^SHOT\s+\d+/.test(l) && !LOCK_LINE.test(l) && !/\{.*\}/.test(l) && !/^Hard cut\.?$/.test(l));
/** Tags on the block's "On screen:" line, or null when the line is missing. */
export function presenceLine(blockText) {
  const m = /^\s*On screen:\s*(.*)$/im.exec(String(blockText ?? ''));
  return m ? [...new Set(m[1].match(TAG) ?? [])] : null;
}

/**
 * Seedance gate for one compiled segment against its stage-play segment.
 * blocks: [{ n, text }] from [SHOTS]; input: the SC input slice (cast cards + characters with visualTell).
 */
export function checkSeedanceShotLocks(seg, src, blocks, input, p) {
  const issues = [];
  const err = (code, message, path) => issues.push({ severity: 'error', code, message, path });
  if (!src) return issues;
  const cards = new Map((input?.cast ?? []).map((c) => [c.elementTag, c]));
  const chars = new Map((input?.characters ?? []).map((c) => [c.elementTag, c]));
  const castTags = new Set(cards.keys());
  // WIGGLY clips: a clip covers some of the part's shots; its timecodes restart at 0, offset by sourceStartSec.
  const inClip = new Set((seg.shots ?? []).map((s) => s.sceneId));
  const isClip = !!seg.sourceShotNumbers || !!seg.clipId || (seg.sourceStartSec ?? 0) > 0;
  const off = seg.sourceStartSec ?? 0;
  const staged = src.shots.filter((s) => !isClip || inClip.has(s.sceneId)).reduce((n, s) => n + (s.endSec - s.startSec), 0);
  if (seg.totalDurationSec !== staged) err('SEGMENT_DURATION_NOT_AS_STAGED', `${p}: totalDurationSec is ${seg.totalDurationSec}s but the staged ${isClip ? 'shots in this clip run' : 'part runs'} ${staged}s. Keep every shot's timecodes exactly as staged.`, `${p}.totalDurationSec`);
  const sp = `${p}.tenBlocks.block5_shots`;
  (seg.shots ?? []).forEach((s, j) => {
    const at = `${p}.shots.${j}`;
    const srcShot = src.shots.find((x) => x.sceneId === s.sceneId);
    if (!srcShot) return; // UNKNOWN_SCENE_REF reports it
    const label = `${p}: SHOT ${s.shotNumber} (scene ${s.sceneId})`;
    if (s.startSec + off !== srcShot.startSec || s.endSec + off !== srcShot.endSec)
      err('SHOT_TIMING_NOT_AS_STAGED', `${label} runs ${s.startSec}-${s.endSec}s but the stage play has ${srcShot.startSec - off}-${srcShot.endSec - off}s${off ? ` in this clip (staged ${srcShot.startSec}-${srcShot.endSec}s, clip starts at ${off}s)` : ''}. Copy the stage play's timecodes; never shorten a shot.`, at);
    const w = Math.max(shotWords(srcShot), countWords(s.dialogue?.line)), dur = s.endSec - s.startSec;
    if (w && !srcShot.timingApproved && dur < secondsNeeded(w)) err('DIALOGUE_TIMING_BUDGET', budgetMessage(`${label} (${s.startSec}s-${s.endSec}s)`, w, dur), `${at}.dialogue`);
    const want = onScreenOf(srcShot, castTags).filter((t) => castTags.has(t));
    if (!sameSet(s.cast ?? [], want)) err('CAST_NOT_AS_STAGED', `${label}: cast is [${list(s.cast ?? [])}] but the stage play puts [${list(want)}] on screen. Use exactly the staged onScreen list.`, `${at}.cast`);
    const b = blocks.find((x) => x.n === s.shotNumber);
    if (!b) return; // SHOT_HEADER_MISMATCH reports it
    const stated = presenceLine(b.text);
    if (!stated) err('PRESENCE_NOT_STATED', `${label} has no "On screen:" line. Write "On screen: ${want.length ? want.join(', ') : 'no one'}." in every SHOT block.`, sp);
    else if (!sameSet(stated, want)) err('PRESENCE_NOT_STATED', `${label}: "On screen:" names [${list(stated)}] but the stage play puts [${list(want)}] on screen.`, sp);
    for (const t of want) for (const ph of lockPhrases(cards.get(t), chars.get(t))) {
      if (hasExact(b.text, ph.text)) continue;
      const what = ph.kind === 'tell' ? 'visual tell' : 'signature accessory';
      const code = ph.kind === 'tell' ? 'VISUAL_TELL_MISSING' : reworded(b.text, ph.text) ? 'ACCESSORY_REWORDED' : 'ACCESSORY_MISSING';
      err(code, `${label}: ${t} is on screen, so the shot repeats their ${what} word for word: "${ph.text}"${code === 'ACCESSORY_REWORDED' ? ' (it is reworded here)' : ''}. Write ${JSON.stringify(lookLine(t, lockPhrases(cards.get(t), chars.get(t))))}`, sp);
    }
    for (const pr of sceneOf(src, srcShot.shotNumber)?.props ?? []) if (!hasExact(b.text, pr))
      err(reworded(b.text, pr) ? 'PROP_STATE_REWORDED' : 'PROP_STATE_MISSING', `${label}: the scene locks the prop state "${pr}"; repeat it word for word in every shot of the scene (a "Props:" line).`, sp);
    const textNoLines = b.text.replace(/\{[^}]*\}/g, '');
    if (EYES_HIDDEN.test(textNoLines)) err('EYES_HIDDEN', `${label}: eyes must stay visible; eyewear that would hide them is pushed up on the forehead.`, sp);
    const d = s.dialogue;
    if (d && !heardOnly(d)) {
      if (!(s.cast ?? []).includes(d.speaker)) err('SPEAKER_NOT_ON_SCREEN', `${label}: ${d.speaker} speaks on camera but is not in the shot's cast. Show them, or mark the line off-camera / voiceover as the stage play does.`, `${at}.dialogue`);
      const lead = castTagsIn(actionLines(b.text).join('\n'), castTags)[0];
      if (lead !== d.speaker) err('SPEAKER_NOT_LEADING', `${label}: ${d.speaker} speaks, so the action leads with ${d.speaker} (it starts with ${lead ?? 'no one'}).`, sp);
    }
  });
  return issues;
}

// ---------------------------------------------------------------- Character Architect
/** Age bands for the look-alike heuristic (teens are already drawn as 18). */
export const ageBand = (age) => (age < 13 ? 'child' : age < 30 ? 'young adult' : age < 50 ? 'adult' : 'older adult');
export const BUILD_TOLERANCE = 0.5; // heads tall
/**
 * Look-alike heuristic (documented in crew/character-architect/role.md): same gender AND same age band AND
 * (similar build: headsTall within 0.5) OR (both in the maker's family with the same skin tone; 'family' includes
 * in-laws and spouses, so this is never described as blood resemblance).
 * Returns the reason, or null.
 */
export function lookAlikeReason(a, b) {
  if (!a || !b || a.gender !== b.gender || ageBand(a.age) !== ageBand(b.age)) return null;
  const build = Math.abs((a.designSpecs?.headsTall ?? 0) - (b.designSpecs?.headsTall ?? 0)) <= BUILD_TOLERANCE;
  const family = a.family && b.family && lockNorm(a.skinTone) === lockNorm(b.skinTone);
  if (!build && !family) return null;
  return `both ${a.gender}, ${ageBand(a.age)}${build ? ', similar build' : ''}${family ? ", both in the maker's family with the same skin tone" : ''}`;
}
/** Two tells are distinct when they differ and share under half of their key words. */
export function tellsDistinct(x, y) {
  if (!x || !y || lockNorm(x) === lockNorm(y)) return false;
  const a = new Set(keyWords(x)), b = new Set(keyWords(y));
  const inter = [...a].filter((w) => b.has(w)).length, union = new Set([...a, ...b]).size;
  return union === 0 ? false : inter / union < 0.5;
}
/** Character Architect gate: look-alike pairs need distinct visual tells, and every tell is drawn in the master render. */
export function checkVisualTells(characters = []) {
  const issues = [];
  const err = (code, message, path) => issues.push({ severity: 'error', code, message, path });
  characters.forEach((c, i) => {
    if (c.visualTell && c.masterRenderPrompt?.promptText && !hasExact(c.masterRenderPrompt.promptText, c.visualTell))
      err('TELL_NOT_IN_RENDER', `${c.elementTag}: visual tell "${c.visualTell}" must appear word for word in the master render prompt so the reference image shows it.`, `characters.${i}.masterRenderPrompt.promptText`);
  });
  for (let i = 0; i < characters.length; i++) for (let j = i + 1; j < characters.length; j++) {
    const a = characters[i], b = characters[j], why = lookAlikeReason(a, b);
    if (!why) continue;
    const missing = [[a, i], [b, j]].filter(([c]) => !String(c.visualTell ?? '').trim());
    for (const [c, k] of missing) err('LOOKALIKE_NO_TELL', `${c.elementTag} could be confused with ${(c === a ? b : a).elementTag} (${why}). Give ${c.elementTag} a visualTell: one clear visible difference (hair, a garment, a colour, an accessory) that the other does not share.`, `characters.${k}.visualTell`);
    if (!missing.length && !tellsDistinct(a.visualTell, b.visualTell))
      err('LOOKALIKE_TELLS_TOO_SIMILAR', `${a.elementTag} ("${a.visualTell}") and ${b.elementTag} ("${b.visualTell}") could be confused (${why}) and their visual tells are too similar. Make ${b.elementTag}'s tell clearly different.`, `characters.${j}.visualTell`);
  }
  return issues;
}
