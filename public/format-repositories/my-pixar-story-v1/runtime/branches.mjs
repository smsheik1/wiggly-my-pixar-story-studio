import { requireBudget, planTotalCost } from './budget.mjs';
import { limitsFor } from './instructions.mjs';
import { current, locked, sheetKeyFor } from './gates.mjs';

export function isParallelStage(p) {
  return Array.isArray(p.branches) && p.branches.length > 0;
}

export function initCharacterBranches(p, rosterCharacters, refined = true, sheetMode = true) {
  p.branches = rosterCharacters.map((c) => ({
    id: `char:${c.id}`,
    type: 'character',
    characterId: c.id,
    locationId: null,
    angleId: null,
    shotId: null,
    clipId: null,
    effectId: null,
    step: refined ? 'characterPrompt' : 'candidates',
    gate: refined ? 'author' : 'produce',
    completed: false,
    attempts: {},
    reviewDisagreements: 0,
  }));
  syncFocusedBranch(p);
  return p.branches;
}

export function initLocationBranches(p, locations) {
  p.branches = locations.map((l) => ({
    id: `loc:${l.id}`,
    type: 'location',
    locationId: l.id,
    characterId: null,
    angleId: null,
    shotId: null,
    clipId: null,
    effectId: null,
    step: 'backgroundBrief',
    gate: 'author',
    completed: false,
    attempts: {},
    reviewDisagreements: 0,
  }));
  syncFocusedBranch(p);
  return p.branches;
}

export function initKeyframeBranches(p, shots) {
  p.branches = shots.map((s) => ({
    id: `shot:${s.id}`,
    type: 'keyframe',
    shotId: s.id,
    characterId: null,
    locationId: null,
    angleId: null,
    clipId: null,
    effectId: null,
    step: 'keyframePrompt',
    gate: 'author',
    completed: false,
    attempts: {},
    reviewDisagreements: 0,
  }));
  syncFocusedBranch(p);
  return p.branches;
}

export function initClipAndSoundBranches(p, clips) {
  const clipBranches = clips.map((c) => ({
    id: `clip:${c.id}`,
    type: 'video',
    clipId: c.id,
    characterId: null,
    locationId: null,
    angleId: null,
    shotId: null,
    effectId: null,
    step: 'videoPrompt',
    gate: 'author',
    completed: false,
    attempts: {},
    reviewDisagreements: 0,
  }));

  const soundBranch = {
    id: 'sound',
    type: 'sound',
    clipId: null,
    characterId: null,
    locationId: null,
    angleId: null,
    shotId: null,
    effectId: null,
    step: 'soundPlan',
    gate: 'author',
    completed: false,
    attempts: {},
    reviewDisagreements: 0,
  };

  p.branches = [...clipBranches, soundBranch];
  syncFocusedBranch(p);
  return p.branches;
}

export function syncFocusedBranch(p) {
  if (!p.branches || p.branches.length === 0) return;
  const limits = limitsFor(p);
  const uncompleted = p.branches.filter(b => !b.completed);
  if (uncompleted.length === 0) {
    p.characterId = null;
    p.locationId = null;
    p.angleId = null;
    p.shotId = null;
    p.clipId = null;
    p.effectId = null;
    return;
  }
  // Human gates inside branches queue up and are presented to the human ONE at a time.
  const humanBranch = uncompleted.find(b => ['human', 'authorize', 'escalate'].includes(b.gate));
  
  let focused;
  if (humanBranch) {
    focused = humanBranch;
  } else if ((limits.videoConcurrency === 1 && limits.soundConcurrency === 1) && uncompleted.some(b => b.type === 'video')) {
    focused = uncompleted.find(b => b.type === 'video') || uncompleted[0];
  } else {
    const currentBranch = uncompleted.find(b =>
      (p.characterId && b.characterId === p.characterId) ||
      (p.locationId && b.locationId === p.locationId) ||
      (p.shotId && b.shotId === p.shotId) ||
      (p.clipId && b.clipId === p.clipId) ||
      (p.effectId && (b.effectId === p.effectId || b.type === 'sound'))
    );
    focused = currentBranch || uncompleted[0];
  }

  p.step = focused.step;
  p.gate = focused.gate;
  p.characterId = focused.characterId;
  p.locationId = focused.locationId;
  p.angleId = focused.angleId;
  p.shotId = focused.shotId;
  p.clipId = focused.clipId;
  p.effectId = focused.effectId;
  p.reviewDisagreements = focused.reviewDisagreements ?? 0;
}

export function findBranchForEvent(p, e) {
  if (!p.branches || p.branches.length === 0) return null;
  if (e.branchId) {
    const b = p.branches.find(b => b.id === e.branchId);
    if (b) return b;
  }
  if (e.characterId) {
    const b = p.branches.find(b => b.characterId === e.characterId);
    if (b) return b;
  }
  if (e.locationId) {
    const b = p.branches.find(b => b.locationId === e.locationId);
    if (b) return b;
  }
  if (e.shotId) {
    const b = p.branches.find(b => b.shotId === e.shotId);
    if (b) return b;
  }
  if (e.clipId) {
    const b = p.branches.find(b => b.clipId === e.clipId);
    if (b) return b;
  }
  if (e.effectId) {
    const b = p.branches.find(b => b.effectId === e.effectId || b.type === 'sound');
    if (b) return b;
  }
  if (e.artifactId) {
    const art = p.artifacts?.find(a => a.id === e.artifactId);
    if (art) {
      const parts = art.key.split(':');
      if (parts[1]) {
        const b = p.branches.find(b =>
          b.characterId === parts[1] || b.locationId === parts[1] || b.shotId === parts[1] || b.clipId === parts[1] || b.effectId === parts[1]
        );
        if (b) return b;
      }
      if (['soundPlan', 'music', 'effect'].includes(art.kind)) {
        const b = p.branches.find(b => b.type === 'sound');
        if (b) return b;
      }
    }
  }
  if (e.jobId) {
    const job = p.jobs?.find(j => j.id === e.jobId);
    if (job) {
      const parts = job.key.split(':');
      if (parts[1]) {
        const b = p.branches.find(b =>
          b.characterId === parts[1] || b.locationId === parts[1] || b.shotId === parts[1] || b.clipId === parts[1] || b.effectId === parts[1]
        );
        if (b) return b;
      }
      if (['music', 'effect'].includes(parts[0])) {
        const b = p.branches.find(b => b.type === 'sound');
        if (b) return b;
      }
    }
  }
  if (e.plan && ['music', 'effect'].includes(e.plan.operation)) {
    const b = p.branches.find(b => b.type === 'sound');
    if (b) return b;
  }
  if (e.plan && e.plan.operation === 'video') {
    const b = p.branches.find(b => b.type === 'video' && !b.completed);
    if (b) return b;
  }
  if (['soundPlan', 'music', 'effect'].includes(e.action) || (e.action === 'artifact' && ['soundPlan', 'music', 'effect'].includes(e.content?.kind))) {
    const b = p.branches.find(b => b.type === 'sound');
    if (b) return b;
  }
  if (e.taskId) {
    const b = p.branches.find(b => b.taskId === e.taskId);
    if (b) return b;
  }
  if (p.characterId) {
    const b = p.branches.find(b => b.characterId === p.characterId);
    if (b) return b;
  }
  if (p.locationId) {
    const b = p.branches.find(b => b.locationId === p.locationId);
    if (b) return b;
  }
  if (p.shotId) {
    const b = p.branches.find(b => b.shotId === p.shotId);
    if (b) return b;
  }
  if (p.clipId) {
    const b = p.branches.find(b => b.clipId === p.clipId);
    if (b) return b;
  }
  if (p.effectId) {
    const b = p.branches.find(b => b.effectId === p.effectId || b.type === 'sound');
    if (b) return b;
  }
  return p.branches.find(b => !b.completed) || p.branches[0];
}

export function nextBranch(p, branch) {
  branch.reviewDisagreements = 0;
  const refined = p.workflowRevision >= 3;
  const sheetMode = p.workflowRevision >= 5;

  if (branch.type === 'character') {
    if (branch.step === 'characterPrompt') {
      branch.step = 'candidates';
      branch.gate = 'produce';
    } else if (branch.step === 'candidates') {
      if (sheetMode) {
        if (locked(p, sheetKeyFor(p, branch.characterId))) {
          branch.completed = true;
        } else {
          branch.step = 'sheet';
          branch.gate = 'produce';
        }
      } else {
        branch.step = 'sheetPrompt';
        branch.gate = 'author';
      }
    } else if (branch.step === 'sheetPrompt') {
      branch.step = 'sheet';
      branch.gate = 'produce';
    } else if (branch.step === 'sheet') {
      if (locked(p, sheetKeyFor(p, branch.characterId))) {
        branch.completed = true;
      }
    }
  } else if (branch.type === 'location') {
    if (branch.step === 'backgroundBrief') {
      branch.step = 'backgroundPrompt';
      branch.gate = 'author';
    } else if (branch.step === 'backgroundPrompt') {
      branch.step = 'backgroundCandidates';
      branch.gate = 'produce';
    } else if (branch.step === 'backgroundCandidates') {
      const loc = current(p, 'backgrounds')?.content.locations.find(l => l.id === branch.locationId);
      const angle = loc?.angles?.find(a => !locked(p, `backgroundAngle:${branch.locationId}:${a.id}`));
      if (angle) {
        branch.angleId = angle.id;
        branch.step = 'backgroundAngleBrief';
        branch.gate = 'author';
      } else {
        branch.completed = true;
      }
    } else if (branch.step === 'backgroundAngleBrief') {
      branch.step = 'backgroundAnglePrompt';
      branch.gate = 'author';
    } else if (branch.step === 'backgroundAnglePrompt') {
      branch.step = 'backgroundAngle';
      branch.gate = 'produce';
    } else if (branch.step === 'backgroundAngle') {
      const loc = current(p, 'backgrounds')?.content.locations.find(l => l.id === branch.locationId);
      const angle = loc?.angles?.find(a => !locked(p, `backgroundAngle:${branch.locationId}:${a.id}`));
      if (angle) {
        branch.angleId = angle.id;
        branch.step = 'backgroundAngleBrief';
        branch.gate = 'author';
      } else {
        branch.completed = true;
      }
    }
  } else if (branch.type === 'keyframe') {
    if (branch.step === 'keyframePrompt') {
      branch.step = 'keyframe';
      branch.gate = 'produce';
    } else if (branch.step === 'keyframe') {
      if (locked(p, `keyframe:${branch.shotId}`)) {
        branch.completed = true;
      }
    }
  } else if (branch.type === 'video') {
    if (branch.step === 'videoPrompt') {
      branch.step = 'video';
      branch.gate = 'produce';
    } else if (branch.step === 'video') {
      if (locked(p, `video:${branch.clipId}`)) {
        branch.completed = true;
      }
    }
  } else if (branch.type === 'sound') {
    if (branch.step === 'soundPlan') {
      const sp = current(p, 'soundPlan')?.content;
      if (sp?.music && !locked(p, 'music')) {
        branch.step = 'music';
        branch.gate = sp.music.mode === 'generate' ? 'produce' : 'author';
      } else {
        const missing = sp?.effects?.find(e => !locked(p, `effect:${e.id}`));
        if (missing) {
          branch.effectId = missing.id;
          branch.step = 'effect';
          branch.gate = missing.mode === 'generate' ? 'produce' : 'author';
        } else {
          branch.completed = true;
        }
      }
    } else if (branch.step === 'music') {
      const sp = current(p, 'soundPlan')?.content;
      const missing = sp?.effects?.find(e => !locked(p, `effect:${e.id}`));
      if (missing) {
        branch.effectId = missing.id;
        branch.step = 'effect';
        branch.gate = missing.mode === 'generate' ? 'produce' : 'author';
      } else {
        branch.completed = true;
      }
    } else if (branch.step === 'effect') {
      const sp = current(p, 'soundPlan')?.content;
      const missing = sp?.effects?.find(e => !locked(p, `effect:${e.id}`));
      if (missing) {
        branch.effectId = missing.id;
        branch.step = 'effect';
        branch.gate = missing.mode === 'generate' ? 'produce' : 'author';
      } else {
        branch.completed = true;
      }
    }
  }
}

export function activeBranches(p) {
  if (!p.branches || p.branches.length === 0) return [];
  const limits = limitsFor(p);
  const uncompleted = p.branches.filter(b => !b.completed);

  const byType = {};
  for (const b of uncompleted) {
    const t = b.type || 'character';
    if (!byType[t]) byType[t] = [];
    byType[t].push(b);
  }

  const result = [];
  if (byType.character) {
    result.push(...byType.character.slice(0, limits.characterConcurrency ?? 2));
  }
  if (byType.location) {
    result.push(...byType.location.slice(0, limits.locationConcurrency ?? 2));
  }
  if (byType.keyframe) {
    result.push(...byType.keyframe.slice(0, limits.keyframeConcurrency ?? 2));
  }
  if (byType.video) {
    result.push(...byType.video.slice(0, limits.videoConcurrency ?? 2));
  }
  if (byType.sound) {
    const soundLimit = limits.soundConcurrency ?? 2;
    const videoLimit = limits.videoConcurrency ?? 2;
    if (soundLimit === 1 && videoLimit === 1 && byType.video && byType.video.length > 0) {
      // Concurrency 1: strictly serial, clips first then sound
    } else {
      result.push(...byType.sound.slice(0, soundLimit));
    }
  }
  return result;
}

export function batchRequireBudget(p, batchJobsOrPlans, options = {}) {
  const totalCost = batchJobsOrPlans.reduce((sum, item) => {
    const plan = item.plan ?? item;
    return sum + planTotalCost(plan);
  }, 0);
  requireBudget(p, totalCost);
  if (options.reserveId) {
    p.budget ??= { maxCostUsd: 0, reservations: [] };
    p.budget.reservations.push({
      id: options.reserveId,
      provider: options.provider ?? 'batch-runtime',
      estimatedCostUsd: totalCost,
    });
  }
  return totalCost;
}

export function projectForBranch(p, branch) {
  if (!branch) return p;
  const clone = structuredClone(p);
  clone.step = branch.step;
  clone.gate = branch.gate;
  clone.characterId = branch.characterId;
  clone.locationId = branch.locationId;
  clone.angleId = branch.angleId;
  clone.shotId = branch.shotId;
  clone.clipId = branch.clipId;
  clone.effectId = branch.effectId;
  clone.reviewDisagreements = branch.reviewDisagreements ?? 0;
  return clone;
}

export function applyBranchEvents(p, events, applyEventFn, taskForFn) {
  const branchIndex = e => {
    const branch = findBranchForEvent(p, e);
    if (!branch || !p.branches) return 0;
    return p.branches.indexOf(branch);
  };
  const sorted = [...events].sort((a, b) => branchIndex(a) - branchIndex(b));
  let curr = p;
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    const branch = findBranchForEvent(curr, ev);
    const eventToApply = { ...ev };
    if (taskForFn && branch && branch.step && ev.taskId !== 'stale') {
      const task = taskForFn(projectForBranch(curr, branch));
      eventToApply.taskId = task.taskId;
    }
    const res = applyEventFn(curr, eventToApply);
    if (res && typeof res.then === 'function') {
      return (async () => {
        curr = await res;
        for (let j = i + 1; j < sorted.length; j++) {
          const ev2 = sorted[j];
          const branch2 = findBranchForEvent(curr, ev2);
          const eventToApply2 = { ...ev2 };
          if (taskForFn && branch2 && branch2.step && ev2.taskId !== 'stale') {
            const task2 = taskForFn(projectForBranch(curr, branch2));
            eventToApply2.taskId = task2.taskId;
          }
          curr = await applyEventFn(curr, eventToApply2);
        }
        return curr;
      })();
    }
    curr = res;
  }
  return curr;
}
