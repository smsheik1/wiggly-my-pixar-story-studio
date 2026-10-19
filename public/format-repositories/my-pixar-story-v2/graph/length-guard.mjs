/**
 * Length enforcement and rewrite guards for the Story Director self-review loop.
 * Pure helpers: cut quota calculation for critique prompts and rewrite growth/gate guards.
 */

export const runtimeOf = (o) => (Number.isFinite(o?.shapeBar?.totalRuntimeSec) ? o.shapeBar.totalRuntimeSec : null);

/** Target runtime seconds: input.targetTotalRuntimeSec ?? input.format.targetTotalSeconds ?? default 90 */
export const resolveTargetSeconds = (input) => {
  if (Number.isFinite(input?.targetTotalRuntimeSec)) return input.targetTotalRuntimeSec;
  if (Number.isFinite(input?.format?.targetTotalSeconds)) return input.format.targetTotalSeconds;
  return 90;
};

/** Count shots across parts / segments of a stage play (guard against missing arrays). */
export function countShots(draft) {
  const parts = Array.isArray(draft?.segments)
    ? draft.segments
    : (Array.isArray(draft?.parts) ? draft.parts : []);
  let count = 0;
  for (const part of parts) {
    if (Array.isArray(part?.shots)) count += part.shots.length;
  }
  if (count === 0 && Array.isArray(draft?.shots)) count = draft.shots.length;
  return count;
}

/**
 * Hard cut-quota line for critique messages: computes draft runtime vs target and injects
 * required cuts or states at/under target.
 * Replaces/extends the existing runtimeNote.
 */
export function cutQuotaNote(input, draft, prevDraft = null, options = {}) {
  const now = runtimeOf(draft);
  if (now == null) return '';
  const target = resolveTargetSeconds(input);
  // prevDraft: the draft this one revised (object) or, for older callers, a runtime number.
  const prev = Number.isFinite(prevDraft) ? prevDraft : runtimeOf(prevDraft);
  const first = options?.firstRuntime ?? null;
  const prevPart = (prev != null && prev !== now ? `; previous draft ${prev}s` : '')
    + (first != null && first !== now && first !== prev ? `; first draft ${first}s` : '');

  if (now > target) {
    const excess = now - target;
    const shotCount = countShots(draft);
    const avg = shotCount > 0 && now > 0 ? (now / shotCount) : 0;
    const nShots = avg > 0 ? Math.ceil(excess / avg) : 0;
    const shotNote = nShots > 0 ? ` (about ${nShots} shot${nShots === 1 ? '' : 's'})` : '';
    return `Runtime: this draft ${now}s; target ${target}s${prevPart}: cut at least ${excess}s${shotNote}. Any added shot must be paid for by a cut.`;
  }

  const status = now === target ? 'at target' : 'under target';
  return `Runtime: this draft ${now}s; target ${target}s${prevPart}: ${status}. The revision must not be longer.`;
}

/** Extract error-severity issue count from gate result, issue array, or number. */
export function countGateErrors(gate) {
  if (typeof gate === 'number') return gate;
  if (!gate) return 0;
  const list = Array.isArray(gate) ? gate : (Array.isArray(gate?.issues) ? gate.issues : []);
  return list.filter((i) => i?.severity === 'error').length;
}

/**
 * Judge a rewritten draft against the draft it revised:
 * (1) Length guard: rejects if rewrite runtime > revised draft runtime.
 *     Allows up to +2s tolerance ONLY if revised draft was already at/under target.
 *     If runtime is missing on either side, does not reject on length.
 * (2) Gate guard: rejects if rewrite has more error-severity gate issues than revised draft.
 */
export function judgeRewrite({ input, before, after, gateBefore = [], gateAfter = [] }) {
  const target = resolveTargetSeconds(input);
  const runtimeBefore = runtimeOf(before);
  const runtimeAfter = runtimeOf(after);

  if (runtimeBefore != null && runtimeAfter != null) {
    const grewBy = runtimeAfter - runtimeBefore;
    const tolerance = runtimeBefore <= target ? 2 : 0;
    if (grewBy > tolerance) {
      return {
        accepted: false,
        reason: 'grew',
        bySec: grewBy,
        rejected: { reason: 'grew', bySec: grewBy },
        message: `rewrite rejected: grew ${grewBy}s`,
      };
    }
  }

  const errorsBefore = countGateErrors(gateBefore);
  const errorsAfter = countGateErrors(gateAfter);
  if (errorsAfter > errorsBefore) {
    return {
      accepted: false,
      reason: 'gate',
      errorsBefore,
      errorsAfter,
      rejected: { reason: 'gate', errorsBefore, errorsAfter },
      message: `rewrite rejected: gate errors increased from ${errorsBefore} to ${errorsAfter}`,
    };
  }

  return { accepted: true };
}
