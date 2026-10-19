// Scoped rewrite enforcement for Story Director review loops.
// Parses flagged shot ids from FIXES and reverts unflagged shot edits or unflagged cuts.
import { MAX_LINE_WORDS } from '../crew/linter/speech.mjs';

/**
 * Extracts numbered or bulleted items from the critique's FIXES section.
 */
export function extractFixItems(critique) {
  const m = /^\s*[*_#]*\s*FIXES\b[^\n]*\n([\s\S]*?)(?:^\s*(?:Works|VERDICT)\b|$(?![\s\S]))/im.exec(String(critique ?? ''));
  if (!m) return [];
  const lines = m[1].split('\n');
  const items = [];
  let current = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^\s*\((?:none|no fixes)\)/i.test(line)) continue;
    const match = /^\s*(?:\d+[.)]|[-*])\s*(.*)$/.exec(line);
    if (match) {
      if (current) items.push(current);
      current = match[1].trim();
    } else if (current) {
      current += ' ' + line;
    } else {
      current = line;
    }
  }
  if (current) items.push(current);
  return items;
}

/**
 * Parses shot ids and ranges from a single fix item string.
 */
function parseShotsFromItem(itemText) {
  const shots = new Set();
  let text = itemText;

  // 1. Part X shot Y (- Z) pattern: "part 2 shot 1-3", "part 2, shot 3", "part 2 shot 1 to 3"
  const partShotRegex = /\bpart\s*(\d+)[,\s]+shots?\s*(\d+)(?:\s*(?:-|–|—|to)\s*(?:part\s*\1[,\s]+shots?\s*)?(\d+))?\b/gi;
  text = text.replace(partShotRegex, (_, part, start, end) => {
    const p = parseInt(part, 10);
    const s1 = parseInt(start, 10);
    if (end) {
      const s2 = parseInt(end, 10);
      const [from, to] = s1 <= s2 ? [s1, s2] : [s2, s1];
      for (let s = from; s <= to; s++) shots.add(`${p}.${s}`);
    } else {
      shots.add(`${p}.${s1}`);
    }
    return ' ';
  });

  // 2. Shot range pattern: "2.1-2.3", "2.1 - 2.2", "2.1 to 2.3", "2.1-3"
  // Note: negative lookahead ensures we do not match seconds e.g. 2.1-2.3s
  const rangeRegex = /\b(\d+)\.(\d+)\s*(?:-|–|—|to)\s*(?:(\d+)\.)?(\d+)\b(?!\s*(?:s\b|sec|seconds?))/gi;
  text = text.replace(rangeRegex, (_, part1, start, part2, end) => {
    const p1 = parseInt(part1, 10);
    const s1 = parseInt(start, 10);
    const p2 = part2 ? parseInt(part2, 10) : p1;
    const s2 = parseInt(end, 10);
    if (p1 === p2) {
      const [from, to] = s1 <= s2 ? [s1, s2] : [s2, s1];
      for (let s = from; s <= to; s++) shots.add(`${p1}.${s}`);
    } else {
      shots.add(`${p1}.${s1}`);
      shots.add(`${p2}.${s2}`);
    }
    return ' ';
  });

  // 3. Single shot pattern: "3.4", "shot 3.4", "shot:3.4", etc.
  const singleRegex = /\b(\d+)\.(\d+)\b(?!\s*(?:s\b|sec|seconds?))/gi;
  text = text.replace(singleRegex, (_, part, shot) => {
    shots.add(`${parseInt(part, 10)}.${parseInt(shot, 10)}`);
    return ' ';
  });

  return shots;
}

/**
 * Parse shot ids from the FIXES list in a critique.
 * Returns a Set of shot ids (with ranges expanded within a part).
 * Attaches unscopedFixes (items naming no shot id) and .shots for convenience.
 */
export function parseFixShots(critique) {
  const items = extractFixItems(critique);
  const allShots = new Set();
  const unscopedFixes = [];

  for (const item of items) {
    const shots = parseShotsFromItem(item);
    if (shots.size > 0) {
      for (const s of shots) allShots.add(s);
    } else {
      unscopedFixes.push(item);
    }
  }

  allShots.unscopedFixes = unscopedFixes;
  allShots.shots = allShots;
  return allShots;
}

/**
 * Formats scope and word-cap rules for the revision prompt.
 */
export function formatScopedRevisionInstructions(allowedShots) {
  const shotsList = Array.from(allowedShots ?? []).sort().join(', ');
  return [
    `Allowed shots to change: ${shotsList}.`,
    'Every shot outside this allowed set is frozen and must not change; any change to an unnamed shot will be reverted in code.',
    `A restored sentence longer than the per-line word cap (${MAX_LINE_WORDS} words) must be split across consecutive lines or shots, never left long.`,
  ].join('\n');
}

/**
 * Recomputes shapeBar.totalRuntimeSec from shots if per-shot durations exist.
 */
export function recomputeRuntime(draft) {
  if (!draft) return draft;
  const segments = Array.isArray(draft.segments) ? draft.segments : (Array.isArray(draft.parts) ? draft.parts : []);
  if (!segments.length) return draft;

  let hasDurations = false;
  let totalSec = 0;
  const partDurations = [];

  for (const seg of segments) {
    let segSec = 0;
    if (Array.isArray(seg.shots) && seg.shots.length > 0) {
      for (const shot of seg.shots) {
        if (typeof shot?.startSec === 'number' && typeof shot?.endSec === 'number') {
          hasDurations = true;
          segSec += Math.max(0, shot.endSec - shot.startSec);
        }
      }
    }
    partDurations.push(segSec);
    totalSec += segSec;
  }

  if (hasDurations && draft.shapeBar) {
    draft.shapeBar.totalRuntimeSec = totalSec;
    if (Array.isArray(draft.shapeBar.parts)) {
      draft.shapeBar.parts.forEach((p, idx) => {
        if (partDurations[idx] !== undefined) {
          p.durationSec = partDurations[idx];
        }
      });
    }
  }
  return draft;
}

/**
 * True when a shot's content or duration changed (timecode shifts alone are timing ripples).
 */
export function shotContentChanged(prevShot, nextShot) {
  if (!prevShot || !nextShot) return true;
  if (JSON.stringify(prevShot) === JSON.stringify(nextShot)) return false;

  const keys = new Set([...Object.keys(prevShot), ...Object.keys(nextShot)]);
  for (const k of keys) {
    if (k === 'startSec' || k === 'endSec') continue;
    if (JSON.stringify(prevShot[k]) !== JSON.stringify(nextShot[k])) {
      return true;
    }
  }

  if (typeof prevShot.startSec === 'number' && typeof prevShot.endSec === 'number' &&
      typeof nextShot.startSec === 'number' && typeof nextShot.endSec === 'number') {
    const prevDur = prevShot.endSec - prevShot.startSec;
    const nextDur = nextShot.endSec - nextShot.startSec;
    if (prevDur !== nextDur) return true;
    return false;
  }

  return false;
}

/**
 * Enforces rewrite scope against a previous draft and an allowed set of shot ids.
 * - Any shot not in allowed that changed is reverted to the previous version.
 * - Any shot deleted that was not named is restored.
 * - New shots are allowed only if inserted adjacent to a named shot.
 * - Named shots may be deleted (cuts).
 * - Recomputes shapeBar.totalRuntimeSec from shots after reverts if per-shot durations exist.
 * Returns the enforced draft with .reverted array attached.
 */
export function enforceScope(prev, next, allowed) {
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed ?? []);
  const out = structuredClone(next ?? {});
  const reverted = [];

  const prevSegments = Array.isArray(prev?.segments) ? prev.segments : (Array.isArray(prev?.parts) ? prev.parts : []);
  const nextSegments = Array.isArray(out?.segments) ? out.segments : (Array.isArray(out?.parts) ? out.parts : []);

  const prevSegMap = new Map();
  prevSegments.forEach((seg, idx) => {
    const id = seg.segmentId ?? idx + 1;
    prevSegMap.set(id, seg);
  });

  const allSegIds = [];
  prevSegments.forEach((seg, idx) => {
    allSegIds.push(seg.segmentId ?? idx + 1);
  });
  nextSegments.forEach((seg, idx) => {
    const id = seg.segmentId ?? idx + 1;
    if (!allSegIds.includes(id)) allSegIds.push(id);
  });

  for (const segId of allSegIds) {
    const prevSeg = prevSegMap.get(segId);
    let nextSeg = nextSegments.find((s, idx) => (s.segmentId ?? idx + 1) === segId);

    if (!prevSeg && nextSeg) {
      continue;
    }
    if (prevSeg && !nextSeg) {
      nextSeg = structuredClone(prevSeg);
      nextSegments.push(nextSeg);
      for (const shot of prevSeg.shots ?? []) {
        const shotId = `${segId}.${shot.shotNumber}`;
        if (!allowedSet.has(shotId) && !reverted.includes(shotId)) {
          reverted.push(shotId);
        }
      }
      continue;
    }

    const prevShots = Array.isArray(prevSeg.shots) ? prevSeg.shots : [];
    const nextShots = Array.isArray(nextSeg.shots) ? nextSeg.shots : [];

    const prevShotMap = new Map();
    prevShots.forEach((s) => {
      prevShotMap.set(s.shotNumber, s);
    });

    // Identify named cut shots from prev
    const cutNamedShotNumbers = new Set(
      prevShots
        .filter((s) => allowedSet.has(`${segId}.${s.shotNumber}`) && !nextShots.some((ns) => ns.shotNumber === s.shotNumber))
        .map((s) => s.shotNumber)
    );

    // 1. Identify new shots and check adjacency to named shots
    const unallowedNewShotIndices = new Set();
    let i = 0;
    while (i < nextShots.length) {
      const shot = nextShots[i];
      if (!prevShotMap.has(shot.shotNumber)) {
        const clusterStart = i;
        while (i < nextShots.length && !prevShotMap.has(nextShots[i].shotNumber)) {
          i++;
        }
        const clusterEnd = i - 1;

        const beforeShot = clusterStart > 0 ? nextShots[clusterStart - 1] : null;
        const afterShot = clusterEnd < nextShots.length - 1 ? nextShots[clusterEnd + 1] : null;

        const beforeId = beforeShot ? `${segId}.${beforeShot.shotNumber}` : null;
        const afterId = afterShot ? `${segId}.${afterShot.shotNumber}` : null;

        let isAdjacent = (beforeId && allowedSet.has(beforeId)) || (afterId && allowedSet.has(afterId));

        // Also check if adjacent to a cut named shot in prev
        if (!isAdjacent && cutNamedShotNumbers.size > 0) {
          const beforePrevIdx = beforeShot ? prevShots.findIndex((s) => s.shotNumber === beforeShot.shotNumber) : -1;
          const afterPrevIdx = afterShot ? prevShots.findIndex((s) => s.shotNumber === afterShot.shotNumber) : prevShots.length;
          for (let p = beforePrevIdx + 1; p < afterPrevIdx; p++) {
            if (cutNamedShotNumbers.has(prevShots[p].shotNumber)) {
              isAdjacent = true;
              break;
            }
          }
        }

        if (!isAdjacent) {
          for (let k = clusterStart; k <= clusterEnd; k++) {
            unallowedNewShotIndices.add(k);
            const shotId = `${segId}.${nextShots[k].shotNumber}`;
            if (!reverted.includes(shotId)) reverted.push(shotId);
          }
        }
      } else {
        i++;
      }
    }

    // 2. Build surviving next shots and revert unnamed shot edits
    const survivingNextShots = [];
    for (let idx = 0; idx < nextShots.length; idx++) {
      if (unallowedNewShotIndices.has(idx)) continue;
      const shot = nextShots[idx];
      const shotId = `${segId}.${shot.shotNumber}`;
      if (prevShotMap.has(shot.shotNumber)) {
        const prevShot = prevShotMap.get(shot.shotNumber);
        if (!allowedSet.has(shotId)) {
          if (shotContentChanged(prevShot, shot)) {
            survivingNextShots.push(structuredClone(prevShot));
            if (!reverted.includes(shotId)) reverted.push(shotId);
          } else {
            survivingNextShots.push(shot);
          }
        } else {
          survivingNextShots.push(shot);
        }
      } else {
        survivingNextShots.push(shot);
      }
    }

    // 3. Restore unnamed deleted shots
    const survivingShotNumbers = new Set(survivingNextShots.map((s) => s.shotNumber));
    for (let pIdx = 0; pIdx < prevShots.length; pIdx++) {
      const prevShot = prevShots[pIdx];
      const shotId = `${segId}.${prevShot.shotNumber}`;
      if (!survivingShotNumbers.has(prevShot.shotNumber)) {
        if (allowedSet.has(shotId)) {
          // Named cut
          continue;
        }
        if (!reverted.includes(shotId)) reverted.push(shotId);

        let insertIdx = 0;
        for (let k = pIdx - 1; k >= 0; k--) {
          const priorNum = prevShots[k].shotNumber;
          const foundIdx = survivingNextShots.findIndex((s) => s.shotNumber === priorNum);
          if (foundIdx >= 0) {
            insertIdx = foundIdx + 1;
            break;
          }
        }
        survivingNextShots.splice(insertIdx, 0, structuredClone(prevShot));
        survivingShotNumbers.add(prevShot.shotNumber);
      }
    }

    nextSeg.shots = survivingNextShots;
  }

  recomputeRuntime(out);

  out.reverted = reverted;
  Object.defineProperty(out, 'draft', { get() { return this; }, enumerable: false, configurable: true });
  return out;
}
