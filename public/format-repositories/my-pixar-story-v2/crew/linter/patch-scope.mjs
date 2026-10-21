// WIGGLY patch mode: fix one thing without redoing the story. A target (a line, a shot or a part) is rewritten;
// everything else in the Story Director output must stay byte-identical. This module parses target ids and proves
// the scope in code: every changed path is either inside the target, a timing ripple of it, a dependent field
// that must move with it, or an append-only addition (new cast card / location). See docs/specs/patch-mode.md.

const LINE_KINDS = ['dialogue', 'narration'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (v) => { const s = v === undefined ? 'undefined' : JSON.stringify(v); return s.length > 90 ? `${s.slice(0, 87)}...` : s; };
export const pathText = (path) => path.reduce((s, k) => (typeof k === 'number' ? `${s}[${k}]` : s ? `${s}.${k}` : k), '');

export class PatchTargetError extends Error { constructor(m) { super(m); this.name = 'PatchTargetError'; this.code = 'PATCH_TARGET_INVALID'; } }

/**
 * Parse a target id against a Story Director output.
 *   part:<segmentId>                       e.g. part:2     (also "2")
 *   shot:<segmentId>.<shotNumber>          e.g. shot:2.3   (also "2.3")
 *   line:<segmentId>.<shotNumber>[.<kind>] e.g. line:2.3.narration (also "2.3.dialogue"); kind may be left out
 *                                           when the shot has only one spoken line
 */
export function parseTarget(raw, sd) {
  const s = String(raw ?? '').trim();
  const m = /^(?:(part|shot|line):)?(\d+)(?:\.(\d+))?(?:\.(dialogue|narration))?$/i.exec(s);
  if (!m) throw new PatchTargetError(`target "${s}" is not a target id. Use part:<part>, shot:<part>.<shot> or line:<part>.<shot>[.dialogue|.narration], e.g. part:2, shot:2.3, line:2.3.dialogue.`);
  let [, kind, segStr, shotStr, lineKind] = m;
  kind = kind?.toLowerCase() ?? (lineKind ? 'line' : shotStr ? 'shot' : 'part');
  const segmentId = +segStr;
  const si = (sd?.segments ?? []).findIndex((g) => g.segmentId === segmentId);
  if (si < 0) throw new PatchTargetError(`target "${s}": there is no part ${segmentId} (parts: ${(sd?.segments ?? []).map((g) => g.segmentId).join(', ')}).`);
  if (kind === 'part') { if (shotStr) throw new PatchTargetError(`target "${s}": a part target has no shot number.`); return { kind, id: `part:${segmentId}`, segmentId, si, isFinal: si === sd.segments.length - 1 }; }
  if (!shotStr) throw new PatchTargetError(`target "${s}": a ${kind} target needs <part>.<shot>, e.g. ${kind}:${segmentId}.1.`);
  const shotNumber = +shotStr;
  const shots = sd.segments[si].shots ?? [];
  const hi = shots.findIndex((h) => h.shotNumber === shotNumber);
  if (hi < 0) throw new PatchTargetError(`target "${s}": part ${segmentId} has no shot ${shotNumber} (shots: ${shots.map((h) => h.shotNumber).join(', ')}).`);
  if (kind === 'shot') { if (lineKind) throw new PatchTargetError(`target "${s}": use line:${segmentId}.${shotNumber}.${lineKind} for a line.`); return { kind, id: `shot:${segmentId}.${shotNumber}`, segmentId, shotNumber, si, hi }; }
  const has = LINE_KINDS.filter((k) => shots[hi][k]);
  if (lineKind) { lineKind = lineKind.toLowerCase(); if (!has.includes(lineKind)) throw new PatchTargetError(`target "${s}": shot ${segmentId}.${shotNumber} has no ${lineKind} line${has.length ? ` (it has ${has.join(' and ')})` : ''}.`); }
  else if (has.length === 1) lineKind = has[0];
  else throw new PatchTargetError(has.length ? `target "${s}": shot ${segmentId}.${shotNumber} has both dialogue and narration; say which: line:${segmentId}.${shotNumber}.dialogue or .narration.` : `target "${s}": shot ${segmentId}.${shotNumber} has no spoken line; target the shot instead (shot:${segmentId}.${shotNumber}).`);
  return { kind, id: `line:${segmentId}.${shotNumber}.${lineKind}`, segmentId, shotNumber, line: lineKind, si, hi };
}

/** Leaf-level differences between two JSON values. Arrays of different length are one change at the array path. */
export function diffPaths(a, b, path = []) {
  if (same(a, b)) return [];
  if (isObj(a) && isObj(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diffPaths(a[k], b[k], [...path, k]));
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.flatMap((x, i) => diffPaths(x, b[i], [...path, i]));
  return [{ path, before: a, after: b }];
}

/** Plain-language description of what a target may change (shown to the agent and printed by the CLI). */
export function describeScope(t) {
  const ripple = 'its shot\'s endSec, and the startSec/endSec of the later shots in the same part shifted by exactly the same number of seconds (with the part\'s targetDurationSec, shapeBar.parts duration and shapeBar.totalRuntimeSec moved by that amount) if the line needs a longer shot';
  const common = 'masthead.draftNumber and assumptions may be updated to match (the HTML deck and storyboard sheets are rebuilt in code).';
  if (t.kind === 'line') return `Only the ${t.line} line of shot ${t.segmentId}.${t.shotNumber} (segments[${t.si}].shots[${t.hi}].${t.line}: speaker, line, flags, source) may change, plus ${ripple}, and segments[${t.si}].answerSources. ${common} Everything else is locked.`;
  if (t.kind === 'shot') return `Only shot ${t.segmentId}.${t.shotNumber} (segments[${t.si}].shots[${t.hi}], every field except shotNumber and startSec) may change, plus ${ripple}; the present and props of the scene lock that contains it; segments[${t.si}].answerSources; that shot's storyboard panel and the fullPrompt of its sheet; and new cast cards or locations appended at the end of cast / locations (existing ones are locked). ${common} The number of shots in the part is locked (target the part to add or remove shots).`;
  return `Only part ${t.segmentId} (segments[${t.si}], every field except segmentId) may change, plus its shapeBar.parts entry and shapeBar.totalRuntimeSec, its storyboard sheets, the description (not the name) of any existing location, and new cast cards or locations appended at the end of cast / locations (existing ones are locked).${t.isFinal ? ' This is the final part, so finaleThesis may change too.' : ''} ${common} Every other part is locked.`;
}

/**
 * Prove a patched Story Director output changed nothing outside the target.
 * Returns gate issues (severity error): PATCH_OUTSIDE_TARGET, PATCH_TIMING_RIPPLE, PATCH_LOCKED_APPEND.
 */
export function checkPatchScope(prior, next, target) {
  const issues = [];
  const err = (code, message, path) => issues.push({ severity: 'error', code, message, path });
  const t = target.si === undefined ? parseTarget(target.id ?? target, prior) : target;
  const { si, hi } = t;
  const segId = prior.segments[si].segmentId;
  const isFinal = si === prior.segments.length - 1;
  const changes = diffPaths(prior, next);
  // timing ripple: the target shot's end moves by delta; later shots shift by delta; totals move by delta (or stay)
  const pShots = prior.segments[si]?.shots ?? [], nShots = next.segments?.[si]?.shots ?? [];
  const delta = t.kind !== 'part' && nShots[hi] ? nShots[hi].endSec - pShots[hi].endSec : 0;
  const okTotal = (path, b, a) => (a === b || a === b + delta ? true : (err('PATCH_TIMING_RIPPLE', `${pathText(path)} went from ${b} to ${a}; the target shot moved by ${delta}s, so it may only move by ${delta}s.`, pathText(path)), true));
  const sheets = (d) => (d.storyboardSheets ?? []);
  const sheetOf = (d, j) => sheets(d)[j];
  const scenesWithShot = new Set((prior.segments[si].scenes ?? []).map((sc, c) => ((sc.shots ?? []).includes(t.shotNumber) ? c : -1)).filter((c) => c >= 0));

  for (const ch of changes) {
    const p = ch.path, [k0, k1, k2, k3, k4] = p;
    const at = pathText(p);
    // always allowed: derived or bookkeeping fields (the deck and storyboard sheets are rebuilt in code from the JSON)
    if (k0 === 'htmlScriptDocument' || k0 === 'storyboardSheets' || k0 === 'assumptions' || (k0 === 'masthead' && k1 === 'draftNumber')) continue;
    if (k0 === 'finaleThesis' && t.kind === 'part' && isFinal) continue;
    // a part target may correct an existing location's description (time of day, a named object's colour / make); names stay locked
    if (t.kind === 'part' && k0 === 'locations' && typeof k1 === 'number' && k2 === 'description' && p.length === 3) continue;
    // append-only cast and locations (shot and part targets)
    if ((k0 === 'cast' || k0 === 'locations') && p.length === 1) {
      const a = ch.before ?? [], b = ch.after ?? [];
      if (t.kind === 'line') err('PATCH_OUTSIDE_TARGET', `${k0} changed; a line patch cannot add or remove ${k0 === 'cast' ? 'cast cards' : 'locations'}.`, at);
      else if (b.length < a.length || !a.every((x, i) => same(x, b[i]))) err('PATCH_LOCKED_APPEND', `${k0}: existing entries are locked; new ones may only be appended at the end (${a.length} before, ${b.length} now).`, at);
      continue;
    }
    if (k0 === 'segments' && k1 === si && p.length >= 2) {
      if (t.kind === 'part') { if (k2 === 'segmentId') err('PATCH_OUTSIDE_TARGET', `${at}: the part id is locked.`, at); continue; }
      if (k2 === 'answerSources') continue;
      if (k2 === 'targetDurationSec' && p.length === 3) { okTotal(p, ch.before, ch.after); continue; }
      if (k2 === 'shots' && p.length === 3) { err('PATCH_OUTSIDE_TARGET', `${at}: the number of shots in part ${segId} changed (${ch.before?.length} -> ${ch.after?.length}); a ${t.kind} patch keeps the shot count. Target part:${segId} to add or remove shots.`, at); continue; }
      if (k2 === 'shots' && typeof k3 === 'number') {
        if (k3 === hi) {
          if (k4 === 'endSec' && p.length === 5) continue; // delta, checked through the later shots and totals
          if (t.kind === 'shot' && k4 !== 'shotNumber' && k4 !== 'startSec') continue;
          if (t.kind === 'line' && k4 === t.line) continue;
        } else if (k3 > hi && (k4 === 'startSec' || k4 === 'endSec') && p.length === 5) {
          if (ch.after !== ch.before + delta) err('PATCH_TIMING_RIPPLE', `${at} went from ${ch.before} to ${ch.after}; later shots may only shift by the target's ${delta}s (to ${ch.before + delta}) so every other shot keeps its length.`, at);
          continue;
        }
      }
      if (k2 === 'scenes' && t.kind === 'shot' && typeof k3 === 'number' && scenesWithShot.has(k3) && (k4 === 'present' || k4 === 'props')) continue;
    }
    if (k0 === 'shapeBar' && t.kind !== 'part' && ((k1 === 'totalRuntimeSec' && p.length === 2) || (k1 === 'parts' && k2 === si && k3 === 'durationSec' && p.length === 4))) { okTotal(p, ch.before, ch.after); continue; }
    if (k0 === 'shapeBar' && t.kind === 'part' && ((k1 === 'totalRuntimeSec' && p.length === 2) || (k1 === 'parts' && k2 === si))) continue;
    // storyboard: the shot's panel (+ its sheet prompt) for a shot target; the part's sheets for a part target
    if (k0 === 'storyboardSheets') {
      if (t.kind === 'part') {
        const others = (d) => sheets(d).filter((x) => x.segmentId !== segId);
        if (p.length === 1) { if (same(others(prior), others(next))) continue; }
        else if (typeof k1 === 'number' && sheetOf(prior, k1)?.segmentId === segId && sheetOf(next, k1)?.segmentId === segId) continue;
      } else if (t.kind === 'shot' && typeof k1 === 'number' && sheetOf(prior, k1)?.segmentId === segId) {
        if (k2 === 'fullPrompt') continue;
        if (k2 === 'panels' && typeof k3 === 'number' && p.length > 4 && sheetOf(prior, k1).panels?.[k3]?.shotNumberRef === t.shotNumber && k4 !== 'shotNumberRef' && k4 !== 'panelNumber') continue;
      }
    }
    err('PATCH_OUTSIDE_TARGET', `${at} changed (${short(ch.before)} -> ${short(ch.after)}) but it is outside the target ${t.id}. Copy it back exactly from the current output.`, at);
  }
  return issues;
}

/** Shots ("<part>.<shot>") whose Story Director content differs between two outputs (same part/shot numbering). */
export function changedShots(prior, next) {
  const out = [];
  for (const seg of next.segments ?? []) {
    const old = (prior.segments ?? []).find((g) => g.segmentId === seg.segmentId);
    for (const sh of seg.shots ?? []) {
      const o = old?.shots?.find((x) => x.shotNumber === sh.shotNumber);
      if (!o || !same(o, sh)) out.push(`${seg.segmentId}.${sh.shotNumber}`);
    }
  }
  return out;
}

// ---- patch gating: a patch answers only for its target ----
/** Checks waived once the animatic is approved (the approved cut sets runtime; listed-but-unseen cast is the reviewer's call). */
export const ANIMATIC_WAIVED = new Set(['RUNTIME_OVER_TARGET', 'PRESENT_NEVER_SEEN']);
/** True when a gate issue sits inside the patch target (a part target also owns location descriptions). */
export function issueInTarget(i, t) {
  if (!t || typeof i?.path !== 'string') return false;
  const own = t.kind === 'part' ? `segments.${t.si}` : t.kind === 'shot' || t.kind === 'line' ? `segments.${t.si}.shots.${t.hi}` : null;
  if (t.kind === 'part' && /^locations\.\d+\.description$/.test(i.path)) return true;
  return i.path === `segments.${t.si}` || i.path.startsWith(`segments.${t.si}.`) || (own && i.path.startsWith(own));
}
/**
 * Patch gate severity: errors outside the target that the prior already had (same code + path) become warnings, and so do
 * ANIMATIC_WAIVED codes once the animatic is approved. Errors inside the target, and new errors anywhere, stay errors.
 */
export function scopePatchIssues(issues, { target, priorIssues = [], animaticApproved = false } = {}) {
  const had = new Set(priorIssues.filter((i) => i.severity === 'error').map((i) => `${i.code}|${i.path ?? ''}`));
  return issues.map((i) => {
    if (i.severity !== 'error') return i;
    const waived = animaticApproved && ANIMATIC_WAIVED.has(i.code);
    const old = !issueInTarget(i, target) && had.has(`${i.code}|${i.path ?? ''}`);
    return waived || old ? { ...i, severity: 'warning', message: `(${waived ? 'waived: animatic approved' : 'pre-existing, outside the patch'}) ${i.message}` } : i;
  });
}
