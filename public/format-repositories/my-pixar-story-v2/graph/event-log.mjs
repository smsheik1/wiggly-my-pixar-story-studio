// Append-only event log for Wiggly v2: records every state transition, agent attempt,
// gate result, reflection, and asset approval to events.jsonl.
// Enables deterministic time-travel replay and safe rewind/branching without re-spending tokens.
import { appendFileSync, readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Append one event to an events.jsonl file.
 * Observers never break a run: if disk write fails, it silently catches.
 */
export function appendEvent(file, event) {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const payload = {
      at: event.at || new Date().toISOString(),
      ...event,
    };
    appendFileSync(file, JSON.stringify(payload) + '\n', 'utf8');
  } catch {
    // Observers never break an active execution
  }
}

/**
 * Read and parse all events from an events.jsonl file.
 * Returns empty array if file does not exist or is empty.
 */
export function readEvents(file) {
  if (!file || !existsSync(file)) return [];
  try {
    const raw = readFileSync(file, 'utf8');
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Wrap an existing onEvent observer so that it simultaneously appends every event
 * to events.jsonl while preserving all downstream tracker/report behavior.
 */
export function withEventLog(eventsFile, onEvent = () => {}) {
  if (!eventsFile) return onEvent;
  return (e) => {
    appendEvent(eventsFile, e);
    try {
      onEvent(e);
    } catch {
      // Observers never break a run
    }
  };
}

/**
 * Project a pipeline state from an event stream up to an optional filter
 * (e.g. before a specific agent, attempt, or timestamp).
 */
export function projectState(events, { beforeAgent = null, beforeAttempt = null, upToTimestamp = null } = {}) {
  const state = {
    status: 'idle',
    attempts: {},
    retryCounts: {},
    gateIssues: {},
    validationErrors: [],
    approvedAssets: undefined,
    pendingApproval: [],
    completedAgents: [],
  };

  const isoCutoff = upToTimestamp ? new Date(upToTimestamp).getTime() : Infinity;

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const evTime = ev.at ? new Date(ev.at).getTime() : 0;
    if (evTime > isoCutoff) break;

    const { agent, type, attempt } = ev;

    // Check if we hit the beforeAgent / beforeAttempt cutoff
    if (beforeAgent && agent === beforeAgent) {
      if (beforeAttempt == null || attempt >= beforeAttempt) {
        break; // Stop replay before this agent or attempt started
      }
    }

    if (type === 'start') {
      state.status = 'running';
    } else if (type === 'attempt') {
      state.status = 'running';
      if (agent) {
        state.attempts[agent] = attempt || 1;
        state.retryCounts[agent] = Math.max(0, (attempt || 1) - 1);
      }
    } else if (type === 'attempt-result') {
      if (agent && ev.issues) {
        state.gateIssues[agent] = ev.issues;
        if (!ev.isValid) {
          state.validationErrors.push({
            node: agent,
            attempt: attempt || 1,
            errors: ev.issues.map((i) => ({ severity: i.severity || 'error', message: i.message || '', ...i })),
            timestamp: ev.at,
          });
        }
      }
    } else if (type === 'passed') {
      if (agent && !state.completedAgents.includes(agent)) {
        state.completedAgents.push(agent);
      }
    } else if (type === 'failed' || type === 'fatal') {
      state.status = 'failed';
    } else if (type === 'awaiting-approval') {
      state.status = 'awaiting-approval';
      state.pendingApproval = ev.pending || [];
    } else if (type === 'assets-approved') {
      state.status = 'approved';
      state.approvedAssets = { ...(state.approvedAssets || {}), ...(ev.approvedAssets || {}) };
      if (ev.assetFiles) {
        state.assetFiles = { ...(state.assetFiles || {}), ...(ev.assetFiles || {}) };
      }
      state.pendingApproval = [];
    } else if (type === 'run-finished') {
      state.status = ev.status || 'done';
    }
  }

  return state;
}

/**
 * Rewind / Branch from an existing run to a new run directory:
 * Copies all upstream outputs and approved assets that completed before `targetAgent`,
 * creates the new run directory with projected state, and logs a branch event.
 */
export function rewindRun({
  sourceRunDir,
  targetAgent,
  newRunDir,
  log = console.log,
}) {
  if (!existsSync(sourceRunDir)) throw new Error(`sourceRunDir not found: ${sourceRunDir}`);
  if (existsSync(newRunDir)) throw new Error(`newRunDir already exists: ${newRunDir}`);

  const eventsFile = join(sourceRunDir, 'events.jsonl');
  const events = readEvents(eventsFile);

  // Project state up to before the target agent ran
  const projected = projectState(events, { beforeAgent: targetAgent });

  // Create new run directory and outputs folder
  const newOutputsDir = join(newRunDir, 'outputs');
  mkdirSync(newOutputsDir, { recursive: true });

  const srcOutputs = join(sourceRunDir, 'outputs');
  if (existsSync(srcOutputs)) {
    for (const f of readdirSync(srcOutputs)) {
      if (!f.endsWith('.json')) continue;
      const base = f.replace(/\.json$/, '');
      // Only copy outputs of agents that completed BEFORE targetAgent
      if (projected.completedAgents.includes(base) || base === 'reflections') {
        copyFileSync(join(srcOutputs, f), join(newOutputsDir, f));
      }
    }
  }

  // Copy assets if they exist
  const srcAssets = join(sourceRunDir, 'assets');
  const newAssets = join(newRunDir, 'assets');
  if (existsSync(srcAssets)) {
    mkdirSync(newAssets, { recursive: true });
    for (const f of readdirSync(srcAssets)) {
      const srcPath = join(srcAssets, f);
      if (statSync(srcPath).isFile()) {
        copyFileSync(srcPath, join(newAssets, f));
      }
    }
  }

  // Write new state.json
  const newState = {
    status: projected.status,
    placeholderAssets: false,
    approvedAssets: projected.approvedAssets,
    pendingApproval: projected.pendingApproval,
    retryCounts: projected.retryCounts,
    escalations: [],
    validationErrors: projected.validationErrors,
    rewoundFrom: {
      sourceRunDir,
      targetAgent,
      at: new Date().toISOString(),
    },
  };
  appendFileSync(join(newOutputsDir, 'state.json'), JSON.stringify(newState, null, 2), 'utf8');

  // Seed the new run's events.jsonl with history up to cutoff plus a 'branch' event
  const newEventsFile = join(newRunDir, 'events.jsonl');
  for (const ev of events) {
    if (ev.agent === targetAgent) break;
    appendEvent(newEventsFile, ev);
  }
  appendEvent(newEventsFile, {
    type: 'run-branched',
    sourceRunDir,
    targetAgent,
    message: `Branched run from ${sourceRunDir} before agent "${targetAgent}"`,
  });

  log(`Rewound run created at ${newRunDir} (ready to execute "${targetAgent}" with upstream assets intact)`);
  return { newRunDir, projected, newState };
}
