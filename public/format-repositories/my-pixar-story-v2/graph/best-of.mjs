// Best-of first drafts for the Story Director: write up to 3 drafts in parallel (one per story approach from the plan,
// or two of the same task without a plan), gate each, judge the passing ones, and pick the winner before the review loop.
import { withCallRetry } from './provider-errors.mjs';
import { loadPick, V2_MODELS } from '../config/models.mjs';
import { isFatalProviderError } from './provider-errors.mjs';
import { runtimeOf, resolveTargetSeconds } from './length-guard.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

export const draftContext = new AsyncLocalStorage();

export const replyText = (m) => (typeof m === 'string' ? m
  : typeof m?.content === 'string' ? m.content
  : Array.isArray(m?.content) ? m.content.filter((b) => typeof b === 'string' || b?.type === 'text').map((b) => (typeof b === 'string' ? b : b.text ?? '')).join('') : String(m?.content ?? ''));

/**
 * True when best-of first drafts is enabled for this agent and config.
 * Config flag bestOfDrafts: 2 for story-director (absent/1 = off for other agents).
 * Skipped in patch mode (scope or task set) or when reflection rounds = 0.
 */
export function bestOfEnabled(agent, config, { scope = '', task = null, rounds = null } = {}) {
  if (scope || task) return false;
  if (rounds === 0) return false;
  if (config && 'bestOfDrafts' in config) return Number(config.bestOfDrafts) >= 2;
  if (config && typeof config === 'object' && Object.keys(config).length > 0) {
    return Number(config.bestOfDrafts ?? 1) >= 2;
  }
  return Number(V2_MODELS[agent]?.bestOfDrafts ?? 1) >= 2;
}


/**
 * Chat messages for the judge call: sees ONLY the scripts and the cold-read criteria.
 * Contains no input.json, no questionnaire answers, and no trace table.
 * Call as judgeMessages({ draftA, draftB, ... }), judgeMessages(draftA, draftB, opts) or judgeMessages({ drafts: [{ id, draft }], ... }).
 */
export function judgeMessages(aOrOpts, bOrOpts, opts = {}) {
  let list, options;
  if (aOrOpts && typeof aOrOpts === 'object' && Array.isArray(aOrOpts.drafts)) {
    options = aOrOpts; list = aOrOpts.drafts.map((d) => ({ id: d.id, draft: d.draft, runtime: d.runtime ?? runtimeOf(d.draft) }));
  } else if (aOrOpts && typeof aOrOpts === 'object' && ('draftA' in aOrOpts || 'draftB' in aOrOpts)) {
    options = aOrOpts;
    list = [{ id: 'A', draft: aOrOpts.draftA, runtime: aOrOpts.runtimeA ?? runtimeOf(aOrOpts.draftA) }, { id: 'B', draft: aOrOpts.draftB, runtime: aOrOpts.runtimeB ?? runtimeOf(aOrOpts.draftB) }];
  } else {
    options = opts ?? {};
    list = [{ id: 'A', draft: aOrOpts, runtime: options.runtimeA ?? runtimeOf(aOrOpts) }, { id: 'B', draft: bOrOpts, runtime: options.runtimeB ?? runtimeOf(bOrOpts) }];
  }
  const targetRuntime = options.targetRuntime ?? 90;
  const prompt = options.prompt ?? loadPick('story-director');
  return [
    { role: 'system', content: prompt },
    {
      role: 'user',
      content: [
        `Target total runtime: ${targetRuntime}s.`,
        ...list.map((d) => `Draft ${d.id} runtime: ${d.runtime}s.`),
        ...list.flatMap((d) => ['', `--- Draft ${d.id} ---`, '```json', JSON.stringify(d.draft ?? {}, null, 2), '```']),
      ].join('\n'),
    },
  ];
}

/**
 * Parses the winner from the judge reply text: last line WINNER: A, B, C, or TIE.
 * Unparseable replies return 'TIE'.
 */
export function parseWinner(reply) {
  const text = replyText(reply);
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return 'TIE';
  const last = lines.at(-1).replace(/^\*+|\*+$/g, '').trim();
  const m = /^WINNER:\s*([ABC]|TIE)\b/i.exec(last);
  if (!m) return 'TIE';
  return m[1].toUpperCase();
}

function checkGate(gate, draft) {
  if (!draft) return { passes: false, errors: 0, issues: [] };
  let issues = [];
  try {
    issues = gate ? (gate(draft)?.issues ?? []) : [];
  } catch {
    issues = [];
  }
  const errorIssues = issues.filter((i) => i.severity === 'error');
  return {
    passes: errorIssues.length === 0,
    errors: errorIssues.length,
    issues,
  };
}

/**
 * Gates every candidate draft and picks one: the only passing draft wins; when none passes, the first draft that exists
 * proceeds (the gate and the node's retry handle it); when two or more pass, the judge picks among the passing ones
 * (a TIE or unreadable reply falls back to the runtime closest to the target, then the first).
 * candidates: [{ id, draft, error }]. Returns { winner, winnerDraft, gateIssues, bestOf }.
 */
export async function pickBest({ candidates = [], gate, model, input = {}, agent = 'story-director', dir = null, rel = null, signal = null } = {}) {
  if (candidates.length && candidates.every((c) => c.error)) throw candidates[0].error;
  const rows = candidates.map((c) => ({ ...c, gate: c.error ? { passes: false, errors: 0, issues: [] } : checkGate(gate, c.draft), runtime: c.draft ? runtimeOf(c.draft) : 0 }));
  const drafts = rows.map((r) => ({ id: r.id, gateErrors: r.gate.errors, runtime: r.runtime, ...(r.label ? { approach: r.label } : {}) }));
  const done = (r, judged, reason, judgeFile = null) => ({ winner: r.id, winnerDraft: r.draft, gateIssues: r.gate.issues,
    bestOf: { drafts, judged, judgeReply: judgeFile, judgeReplyFile: judgeFile, winner: r.id, reason } });
  const passing = rows.filter((r) => r.gate.passes);
  if (passing.length === 1) return done(passing[0], false, 'gate');
  if (passing.length === 0) {
    const first = rows.find((r) => !r.error);
    console.warn(`[best-of] ${agent}: no draft passed the gate after repair; draft ${first.id} goes ahead to the review loop and the node's retry`);
    return done(first, false, 'both-failed');
  }

  const targetRuntime = resolveTargetSeconds(input);
  const messages = judgeMessages({ drafts: passing.map((r) => ({ id: r.id, draft: r.draft, runtime: r.runtime })), targetRuntime, prompt: loadPick(agent) });
  let parsed = 'TIE', judgeFile = null;
  try {
    const meta = { runName: `${agent} best-of judge`, tags: [`agent:${agent}`, 'best-of', 'judge'], signal };
    const res = await withCallRetry(() => model.invoke(messages, meta), { signal: meta?.signal });
    const judgeReply = replyText(res).trim();
    if (dir && judgeReply) { await writeFile(join(dir, 'judge-reply.md'), judgeReply + '\n'); if (rel) judgeFile = rel('judge-reply.md'); }
    parsed = parseWinner(judgeReply);
  } catch (e) {
    if (signal?.aborted) throw signal.reason ?? e;
    if (isFatalProviderError(e)) throw e;
    parsed = 'TIE';
  }
  const chosen = passing.find((r) => r.id === parsed);
  if (chosen) return done(chosen, true, 'judge', judgeFile);
  // Unparseable/TIE/throw (or a winner that did not pass) -> runtime closest to the target, then the first.
  const off = (r) => Math.abs(r.runtime - targetRuntime);
  const best = Math.min(...passing.map(off));
  const closest = passing.filter((r) => off(r) === best);
  return done(closest[0], true, closest.length === 1 ? 'runtime' : 'fallback', judgeFile);
}

/** Two-draft form of pickBest (kept for callers and tests). */
export async function pickDraft({ draftA, draftB, errorA = null, errorB = null, ...rest } = {}) {
  return pickBest({ candidates: [{ id: 'A', draft: draftA, error: errorA }, { id: 'B', draft: draftB, error: errorB }], ...rest });
}

const DRAFT_IDS = ['A', 'B', 'C'];
/** The repair message for a draft that failed the gate: the original task, the draft, and its gate errors to fix. */
export const repairTask = (task, draft, issues = []) => [
  task ?? '',
  '',
  'Your draft below failed the gate. Fix every error listed, change nothing else, keep the story and its approach, and submit the full corrected output.',
  'Gate errors:',
  ...issues.filter((i) => i.severity === 'error').map((i) => `- ${i.code}${i.path ? ` (${i.path})` : ''}: ${i.message}`),
  '',
  'Your draft:',
  JSON.stringify(draft),
].join('\n');
/**
 * Writes the drafts in parallel, each in its own workspace, saves them and picks one (pickBest).
 * tasks: one first-user-message per draft (one per story approach), up to 3; default two drafts of the same task.
 * labels: optional approach label per draft, recorded in bestOf.drafts.
 */
export async function runBestOf({
  agent, input, model, gate, signal, runsRoot, root, task, tasks, labels = [], runOnce, prepareWorkspace, state = {}, assetFiles = {}, photoFiles = {},
} = {}) {
  const list = (tasks?.length ? tasks : [task, task]).slice(0, DRAFT_IDS.length).map((t) => t ?? `Produce the ${agent} output for this run.`);
  const results = await Promise.all(list.map(async (t, i) => {
    const id = DRAFT_IDS[i];
    const ws = await prepareWorkspace({ runsRoot: join(root, 'workspaces'), runId: `draft-${id}`, agent, input, approvedAssets: state.approvedAssets ?? {}, assetFiles, photoFiles });
    return draftContext.run({ draftId: id }, async () => {
      try {
        return { id, label: labels[i] ?? null, draft: await runOnce(t, `${agent} deep agent draft ${id}`, [`draft:${id}`], ws.root), error: null };
      } catch (e) {
        if (signal?.aborted) throw signal.reason ?? e;
        if (isFatalProviderError(e)) throw e;
        return { id, label: labels[i] ?? null, draft: null, error: e };
      }
    });
  }));
  const dir = join(root, 'reflection');
  await mkdir(dir, { recursive: true });
  const rel = (f) => relative(runsRoot, join(dir, f));
  for (const r of results) if (r.draft) await writeFile(join(dir, `draft-${r.id}.json`), JSON.stringify(r.draft, null, 2));
  // A draft that fails the gate gets one repair with its gate errors before the pick, so the judge compares stories,
  // not which draft happened to trip fewer checks.
  const repaired = [];
  const candidates = await Promise.all(results.map(async (r, i) => {
    if (!r.draft) return r;
    const g = checkGate(gate, r.draft);
    if (g.passes) return r;
    const ws = await prepareWorkspace({ runsRoot: join(root, 'workspaces'), runId: `draft-${r.id}-repair`, agent, input, approvedAssets: state.approvedAssets ?? {}, assetFiles, photoFiles });
    return draftContext.run({ draftId: r.id, repair: true }, async () => {
      try {
        const fixed = await runOnce(repairTask(list[i], r.draft, g.issues), `${agent} deep agent draft ${r.id} repair`, [`draft:${r.id}`, 'repair'], ws.root);
        if (!fixed) return r;
        await writeFile(join(dir, `draft-${r.id}-repair.json`), JSON.stringify(fixed, null, 2));
        repaired.push({ id: r.id, gateErrorsBefore: g.errors, gateErrorsAfter: checkGate(gate, fixed).errors });
        return { ...r, draft: fixed };
      } catch (e) {
        if (signal?.aborted) throw signal.reason ?? e;
        if (isFatalProviderError(e)) throw e;
        return r;
      }
    });
  }));
  const picked = await pickBest({ candidates, gate, model, input, agent, dir, rel, signal });
  if (repaired.length) picked.bestOf.repaired = repaired;
  return picked;
}
