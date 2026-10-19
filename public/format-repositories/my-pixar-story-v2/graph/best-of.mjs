// Best-of-2 first drafts for the Story Director: generate two drafts in parallel,
// gate each, judge if both pass, and pick the winner before the reflection loop.
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
 * Share of spoken lines (dialogue or narration) whose source kind is 'verbatim' (0..1).
 */
export function ownWordsShare(draft) {
  let total = 0;
  let verbatim = 0;
  for (const seg of draft?.segments ?? []) {
    for (const shot of seg?.shots ?? []) {
      for (const k of ['dialogue', 'narration']) {
        const d = shot?.[k];
        if (d?.line) {
          total++;
          if (d?.source?.kind === 'verbatim') verbatim++;
        }
      }
    }
  }
  return total > 0 ? verbatim / total : 0;
}

/**
 * Chat messages for the judge call: sees ONLY the two scripts and the cold-read criteria.
 * Contains no input.json, no questionnaire answers, and no trace table.
 */
export function judgeMessages(aOrOpts, bOrOpts, opts = {}) {
  let draftA, draftB, options;
  if (aOrOpts && typeof aOrOpts === 'object' && ('draftA' in aOrOpts || 'draftB' in aOrOpts)) {
    draftA = aOrOpts.draftA;
    draftB = aOrOpts.draftB;
    options = aOrOpts;
  } else {
    draftA = aOrOpts;
    draftB = bOrOpts;
    options = opts ?? {};
  }
  const targetRuntime = options.targetRuntime ?? 90;
  const runtimeA = options.runtimeA ?? runtimeOf(draftA);
  const runtimeB = options.runtimeB ?? runtimeOf(draftB);
  const prompt = options.prompt ?? loadPick('story-director');

  return [
    { role: 'system', content: prompt },
    {
      role: 'user',
      content: [
        `Target total runtime: ${targetRuntime}s.`,
        `Draft A runtime: ${runtimeA}s.`,
        `Draft B runtime: ${runtimeB}s.`,
        '',
        '--- Draft A ---',
        '```json',
        JSON.stringify(draftA ?? {}, null, 2),
        '```',
        '',
        '--- Draft B ---',
        '```json',
        JSON.stringify(draftB ?? {}, null, 2),
        '```',
      ].join('\n'),
    },
  ];
}

/**
 * Parses the winner from the judge reply text: last line WINNER: A, WINNER: B, or WINNER: TIE.
 * Unparseable replies return 'TIE'.
 */
export function parseWinner(reply) {
  const text = replyText(reply);
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return 'TIE';
  const last = lines.at(-1).replace(/^\*+|\*+$/g, '').trim();
  const m = /^WINNER:\s*([AB]|TIE)\b/i.exec(last);
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
 * Evaluates two drafts, gates each, and invokes the judge model if both pass.
 * Returns { winner, winnerDraft, gateIssues, bestOf }.
 */
export async function pickDraft({
  draftA,
  draftB,
  errorA = null,
  errorB = null,
  gate,
  model,
  input = {},
  agent = 'story-director',
  dir = null,
  rel = null,
  signal = null,
} = {}) {
  if (errorA && errorB) throw errorA;

  const gateA = errorA ? { passes: false, errors: 0, issues: [] } : checkGate(gate, draftA);
  const gateB = errorB ? { passes: false, errors: 0, issues: [] } : checkGate(gate, draftB);

  const runtimeA = draftA ? runtimeOf(draftA) : 0;
  const runtimeB = draftB ? runtimeOf(draftB) : 0;
  const ownWordsA = draftA ? ownWordsShare(draftA) : 0;
  const ownWordsB = draftB ? ownWordsShare(draftB) : 0;

  const drafts = [
    { id: 'A', gateErrors: gateA.errors, runtime: runtimeA, ownWords: ownWordsA },
    { id: 'B', gateErrors: gateB.errors, runtime: runtimeB, ownWords: ownWordsB },
  ];

  // 1. Exactly one passes -> it wins.
  if (gateA.passes && !gateB.passes) {
    return {
      winner: 'A',
      winnerDraft: draftA,
      gateIssues: gateA.issues,
      bestOf: { drafts, judged: false, judgeReply: null, judgeReplyFile: null, winner: 'A', reason: 'gate' },
    };
  }
  if (!gateA.passes && gateB.passes) {
    return {
      winner: 'B',
      winnerDraft: draftB,
      gateIssues: gateB.issues,
      bestOf: { drafts, judged: false, judgeReply: null, judgeReplyFile: null, winner: 'B', reason: 'gate' },
    };
  }

  // 2. Both fail -> keep current behavior (proceed with draft A; gate + existing retry handle it).
  if (!gateA.passes && !gateB.passes) {
    // A draft whose run threw has no output; fall back to the other one (which failed the gate).
    const id = errorA ? 'B' : 'A';
    return {
      winner: id,
      winnerDraft: id === 'A' ? draftA : draftB,
      gateIssues: id === 'A' ? gateA.issues : gateB.issues,
      bestOf: { drafts, judged: false, judgeReply: null, judgeReplyFile: null, winner: id, reason: 'both-failed' },
    };
  }

  // 3. Both pass -> judge call with the same model.
  const targetRuntime = resolveTargetSeconds(input);
  const prompt = loadPick(agent);
  const messages = judgeMessages({
    draftA,
    draftB,
    targetRuntime,
    runtimeA,
    runtimeB,
    prompt,
  });

  let judgeReply = '';
  let parsedWinner = null;
  let judgeFile = null;

  try {
    const meta = {
      runName: `${agent} best-of judge`,
      tags: [`agent:${agent}`, 'best-of', 'judge'],
      signal,
    };
    const res = await withCallRetry(() => model.invoke(messages, meta), { signal: meta?.signal });
    judgeReply = replyText(res).trim();
    if (dir && judgeReply) {
      const filename = 'judge-reply.md';
      await writeFile(join(dir, filename), judgeReply + '\n');
      if (rel) judgeFile = rel(filename);
    }
    parsedWinner = parseWinner(judgeReply);
  } catch (e) {
    if (signal?.aborted) throw signal.reason ?? e;
    if (isFatalProviderError(e)) throw e;
    parsedWinner = 'TIE';
  }

  let winner;
  let reason;

  if (parsedWinner === 'A') {
    winner = 'A';
    reason = 'judge';
  } else if (parsedWinner === 'B') {
    winner = 'B';
    reason = 'judge';
  } else {
    // Unparseable/TIE/throw -> tiebreak by own-words share, then fewer runtime seconds, then A.
    if (ownWordsA > ownWordsB) {
      winner = 'A';
      reason = 'own-words';
    } else if (ownWordsB > ownWordsA) {
      winner = 'B';
      reason = 'own-words';
    } else if (runtimeA < runtimeB) {
      winner = 'A';
      reason = 'runtime';
    } else if (runtimeB < runtimeA) {
      winner = 'B';
      reason = 'runtime';
    } else {
      winner = 'A';
      reason = 'fallback';
    }
  }

  const winnerDraft = winner === 'A' ? draftA : draftB;
  const gateIssues = winner === 'A' ? gateA.issues : gateB.issues;

  return {
    winner,
    winnerDraft,
    gateIssues,
    bestOf: {
      drafts,
      judged: true,
      judgeReply: judgeFile,
      judgeReplyFile: judgeFile,
      winner,
      reason,
    },
  };
}

/**
 * Runs parallel generation of drafts A and B in separate workspaces, saves them,
 * and calls pickDraft.
 */
export async function runBestOf({
  agent,
  input,
  model,
  gate,
  signal,
  runsRoot,
  root,
  task,
  runOnce,
  prepareWorkspace,
  state = {},
  assetFiles = {},
  photoFiles = {},
} = {}) {
  const wsA = await prepareWorkspace({
    runsRoot: join(root, 'workspaces'),
    runId: 'draft-A',
    agent,
    input,
    approvedAssets: state.approvedAssets ?? {},
    assetFiles,
    photoFiles,
  });
  const wsB = await prepareWorkspace({
    runsRoot: join(root, 'workspaces'),
    runId: 'draft-B',
    agent,
    input,
    approvedAssets: state.approvedAssets ?? {},
    assetFiles,
    photoFiles,
  });

  const [resA, resB] = await Promise.all([
    draftContext.run({ draftId: 'A' }, async () => {
      try {
        const draft = await runOnce(
          task ?? `Produce the ${agent} output for this run.`,
          `${agent} deep agent draft A`,
          ['draft:A'],
          wsA.root
        );
        return { id: 'A', draft, error: null };
      } catch (e) {
        if (signal?.aborted) throw signal.reason ?? e;
        if (isFatalProviderError(e)) throw e;
        return { id: 'A', draft: null, error: e };
      }
    }),
    draftContext.run({ draftId: 'B' }, async () => {
      try {
        const draft = await runOnce(
          task ?? `Produce the ${agent} output for this run.`,
          `${agent} deep agent draft B`,
          ['draft:B'],
          wsB.root
        );
        return { id: 'B', draft, error: null };
      } catch (e) {
        if (signal?.aborted) throw signal.reason ?? e;
        if (isFatalProviderError(e)) throw e;
        return { id: 'B', draft: null, error: e };
      }
    }),
  ]);

  const dir = join(root, 'reflection');
  await mkdir(dir, { recursive: true });
  const rel = (f) => relative(runsRoot, join(dir, f));

  if (resA.draft) await writeFile(join(dir, 'draft-A.json'), JSON.stringify(resA.draft, null, 2));
  if (resB.draft) await writeFile(join(dir, 'draft-B.json'), JSON.stringify(resB.draft, null, 2));

  return await pickDraft({
    draftA: resA.draft,
    draftB: resB.draft,
    errorA: resA.error,
    errorB: resB.error,
    gate,
    model,
    input,
    agent,
    dir,
    rel,
    signal,
  });
}
