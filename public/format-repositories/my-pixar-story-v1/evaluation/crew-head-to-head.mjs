import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openRunCopy, projectStates, findState } from './r4-replay.mjs';
import { OpenRouterHost } from '../runtime/openrouter-host.mjs';
import { runCrewTask, taskAssets } from '../runtime/crew.mjs';
import { taskFor, applyEvent } from '../runtime/workflow.mjs';
import { Event } from '../runtime/contracts.mjs';

const PRICE_TABLE = {
  'meta/muse-spark-1.3-contributor': { inputUsdPerM: 0.10, outputUsdPerM: 0.20 },
  'deepseek/deepseek-v4.1-flash': { inputUsdPerM: 0.30, outputUsdPerM: 1.20 },
};

export const TASK_DEFS = {
  'theo-room-prompt': { role: 'pixar-prompter', name: 'Theo', key: 'backgroundPrompt:childhood-room', gate: 'author' },
  'sage-prompt-review': { role: 'text-reviewer', name: 'Sage', key: 'backgroundPrompt:childhood-room', gate: 'review' },
  'vera-sheet-review': { role: 'visual-reviewer', name: 'Vera', key: 'candidates:shaz-late-teen', gate: 'review', versions: [1, 2] },
  'vera-room-review': { role: 'visual-reviewer', name: 'Vera', key: 'backgroundCandidates:childhood-room', gate: 'review', versions: [1, 2] },
  'leo-script': { role: 'script-writer', name: 'Leo', key: 'script', gate: 'author' },
  // r4 adult Shaz sheets v1: three sheets Vera falsely rejected for the watch "switching wrists".
  // Ground truth: Shaz approved v1 option 2 (index 1, sha ac1a7538…) after the redo. Not in RUN_ORDER;
  // run it by name with --tasks vera-adult-sheet-review.
  'vera-adult-sheet-review': { role: 'visual-reviewer', name: 'Vera', key: 'candidates:shaz-adult', gate: 'review', versions: [1] },
};

// Evaluation-only spend ceiling: --max-usd can lower it, never raise it.
export const HARD_CAP_USD = 0.10;

// Evaluation-only reasoning efforts. The production OpenRouterHost still refuses xhigh/max;
// only this script may raise effort, per model, and only to a level the model offers.
export const EVAL_EFFORTS = {
  'meta/muse-spark-1.3-contributor': ['low', 'medium', 'high', 'xhigh', 'max'],
  'deepseek/deepseek-v4.1-flash': ['low', 'high', 'max'],
};
export const EFFORT_FLAG_MODELS = { muse: 'meta/muse-spark-1.3-contributor', deepseek: 'deepseek/deepseek-v4.1-flash' };

// --version N keeps only that version of a multi-version task; null keeps them all.
export function selectVersions(def, version = null) {
  const versions = def?.versions ?? [null];
  if (version == null) return versions;
  return versions.filter(v => v === Number(version));
}

export function assertEvalEffort(model, effort) {
  const allowed = EVAL_EFFORTS[model] ?? ['low', 'medium', 'high'];
  if (!allowed.includes(effort)) throw new Error(`HEAD_TO_HEAD_EFFORT_INVALID: ${model} does not take effort "${effort}" (allowed: ${allowed.join(', ')}).`);
  return effort;
}

// Build a host for one evaluation call. The constructor enforces the production rule
// (medium/high only); the evaluation effort is applied to this one instance afterwards.
export function evaluationHost(opts, effort = null) {
  const host = new OpenRouterHost({ ...opts, reasoningEffort: 'medium' });
  if (effort && effort !== 'medium') host.reasoningEffort = assertEvalEffort(opts.model, effort);
  return host;
}

const RUN_ORDER = ['sage-prompt-review', 'theo-room-prompt', 'vera-room-review', 'vera-sheet-review'];

// Estimate one task run: the packet text (~4 chars/token) plus ~1,600 tokens per attached
// image, re-sent on every tool round, plus thinking/output tokens. Deliberately conservative.
export function estimateTaskCost(taskObj, model) {
  const price = PRICE_TABLE[model] ?? { inputUsdPerM: 0.30, outputUsdPerM: 1.20 };
  let images = 0;
  try { images = [...taskAssets(taskObj).values()].filter(f => f.width && !f.durationSeconds).length; } catch {}
  const packetTokens = Math.ceil(JSON.stringify(taskObj ?? {}).length / 4);
  const rounds = images ? 4 : 3;
  const inputTokens = (packetTokens + images * 1600 + 2000) * rounds;
  const outputTokens = 2500 * rounds;
  return (inputTokens / 1_000_000) * price.inputUsdPerM + (outputTokens / 1_000_000) * price.outputUsdPerM;
}

// Worst case for one OpenRouter request, from its real body: text (~4 chars/token, data URLs
// excluded), ~1,600 tokens per image, and the full max_tokens of output.
export function worstCaseRequestUsd(body, model) {
  const price = PRICE_TABLE[model] ?? { inputUsdPerM: 0.30, outputUsdPerM: 1.20 };
  let parsed = {};
  try { parsed = typeof body === 'string' ? JSON.parse(body) : (body ?? {}); } catch {}
  const raw = typeof body === 'string' ? body : JSON.stringify(parsed);
  const images = (raw.match(/data:image\//g) ?? []).length;
  const text = raw.replace(/data:[^"]*/g, '').length;
  const maxOut = Number(parsed.max_tokens) || 16000;
  return ((text / 4 + images * 1600) / 1_000_000) * price.inputUsdPerM + (maxOut / 1_000_000) * price.outputUsdPerM;
}

// Actual cost of one response: OpenRouter usage.cost, or the token price if it's missing.
export function responseCostUsd(usage, model) {
  if (Number.isFinite(Number(usage?.cost)) && Number(usage.cost) > 0) return Number(usage.cost);
  const price = PRICE_TABLE[model] ?? { inputUsdPerM: 0.30, outputUsdPerM: 1.20 };
  return ((Number(usage?.prompt_tokens) || 0) * price.inputUsdPerM + (Number(usage?.completion_tokens) || 0) * price.outputUsdPerM) / 1_000_000;
}

export async function runHeadToHead({
  runDir,
  secretsPath,
  models = ['meta/muse-spark-1.3-contributor', 'deepseek/deepseek-v4.1-flash'],
  tasks = RUN_ORDER,
  repeat = 1,
  maxUsd = HARD_CAP_USD,
  version = null,
  efforts = {},
  confirmSpend = false,
  dryRun = false,
  outDir = null,
  fetcher = fetch,
  stateList = null,
} = {}) {
  maxUsd = Math.min(Number(maxUsd) || HARD_CAP_USD, HARD_CAP_USD);
  for (const [m, e] of Object.entries(efforts ?? {})) if (e) assertEvalEffort(m, e);
  // If stateList is provided directly (e.g. testing), use it, otherwise open runDir copy
  let saver = null, tempDir = null;
  let states = stateList;
  if (!states) {
    const runCopy = await openRunCopy(runDir);
    saver = runCopy.saver;
    tempDir = runCopy.tempDir;
    const loadedStates = [];
    for await (const s of projectStates(saver)) {
      loadedStates.push(s);
    }
    states = loadedStates;
  }

  // Build the list of task invocations
  const invocationPlan = [];
  for (const taskId of tasks) {
    const def = TASK_DEFS[taskId];
    if (!def) continue;
    const versions = selectVersions(def, version);
    if (!versions.length) { process.stderr.write(`Warning: task ${taskId} has no version ${version}\n`); continue; }
    for (const ver of versions) {
      const sourceState = await findState(states, { key: def.key, gate: def.gate, version: ver });
      if (!sourceState) {
        process.stderr.write(`Warning: state for task ${taskId} (ver: ${ver}) not found\n`);
        continue;
      }
      for (const model of models) {
        for (let r = 0; r < repeat; r++) {
          invocationPlan.push({
            taskId,
            taskDef: def,
            version: ver,
            sourceState,
            model,
            effort: efforts?.[model] ?? 'medium',
            repeatIndex: r,
            estimatedCostUsd: estimateTaskCost(taskFor(sourceState), model),
          });
        }
      }
    }
  }

  const totalEstimatedCostUsd = invocationPlan.reduce((sum, item) => sum + item.estimatedCostUsd, 0);

  // Print estimated cost table
  process.stdout.write(`=== Crew Head-to-Head Estimated Cost ===\n`);
  for (const item of invocationPlan) {
    process.stdout.write(`- ${item.taskId}${item.version ? `@v${item.version}` : ''} × ${item.model} (effort ${item.effort}): ~$${item.estimatedCostUsd.toFixed(5)}\n`);
  }
  process.stdout.write(`Total Estimated Cost: ~$${totalEstimatedCostUsd.toFixed(5)} (Max allowed: $${maxUsd.toFixed(2)})\n`);

  if (!confirmSpend && !dryRun) {
    process.stdout.write(`Spend not confirmed. Pass --confirm-spend to execute paid calls or --dry-run to test locally.\n`);
    if (saver) saver.db.close();
    return { status: 'unconfirmed', estimatedCostUsd: totalEstimatedCostUsd, capUsd: maxUsd };
  }

  if (totalEstimatedCostUsd > maxUsd && !dryRun) {
    process.stderr.write(`Estimated cost ($${totalEstimatedCostUsd.toFixed(4)}) exceeds --max-usd ($${maxUsd.toFixed(2)}). Use --tasks to narrow scope.\n`);
    if (saver) saver.db.close();
    return { status: 'cap_exceeded', estimatedCostUsd: totalEstimatedCostUsd, capUsd: maxUsd };
  }

  const results = [];
  let cumulativeActualCostUsd = 0;

  for (const item of invocationPlan) {
    if (dryRun) {
      // Dry-run: construct clone and packet, verify task building with no network
      const clone = structuredClone(item.sourceState);
      const task = taskFor(clone);
      results.push({
        taskId: item.taskId,
        version: item.version,
        model: item.model,
        effort: item.effort,
        repeatIndex: item.repeatIndex,
        wallMs: 0,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        estimatedCostUsd: item.estimatedCostUsd,
        valid: true,
        gateAccepted: true,
        dryRun: true,
      });
      continue;
    }

    if (cumulativeActualCostUsd + item.estimatedCostUsd > maxUsd) {
      results.push({
        taskId: item.taskId,
        version: item.version,
        model: item.model,
        effort: item.effort,
        repeatIndex: item.repeatIndex,
        status: 'skipped (cap)',
        costUsd: 0,
        estimatedCostUsd: item.estimatedCostUsd,
      });
      continue;
    }

    const clone = structuredClone(item.sourceState);
    let callCostUsd = 0;
    let requests = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    const turns = [];
    let validationRetries = 0;
    let invalidToolCalls = 0;

    // Hard cap: refuse any request whose worst case could push actual spend past --max-usd.
    let capStopped = false;
    const wrappedFetcher = async (url, init) => {
      const worst = worstCaseRequestUsd(init?.body, item.model);
      if (cumulativeActualCostUsd + callCostUsd + worst > maxUsd) {
        capStopped = true;
        throw Object.assign(new Error(`HEAD_TO_HEAD_CAP_REACHED: next request could cost up to $${worst.toFixed(4)}; spent $${(cumulativeActualCostUsd + callCostUsd).toFixed(4)} of $${maxUsd.toFixed(2)}.`), { stopDispatch: true });
      }
      let sent = {};
      try { sent = JSON.parse(init?.body ?? '{}'); } catch {}
      // The host's one validation repair turn is the only request sent with tool_choice "none".
      if (sent.tool_choice === 'none') validationRetries++;
      invalidToolCalls = (sent.messages ?? []).filter(m => m.role === 'tool' && String(m.content).startsWith('TOOL_ARGUMENTS_INVALID')).length;
      const t0 = Date.now();
      const resp = await fetcher(url, init);
      // ms covers the whole turn: it is set only after the full response body has been read below.
      // ttfbMs is when the response headers arrived (what ms wrongly measured before).
      const turn = { ms: 0, ttfbMs: Date.now() - t0, status: resp.status ?? null, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0, toolCalls: 0, repair: sent.tool_choice === 'none' };
      requests++;
      try {
        const cloned = typeof resp.clone === 'function' ? resp.clone() : resp;
        const data = await cloned.json();
        turn.toolCalls = data?.choices?.[0]?.message?.tool_calls?.length ?? 0;
        if (data?.usage) {
          turn.promptTokens = Number(data.usage.prompt_tokens) || 0;
          turn.completionTokens = Number(data.usage.completion_tokens) || 0;
          turn.reasoningTokens = Number(data.usage.completion_tokens_details?.reasoning_tokens) || 0;
          turn.costUsd = responseCostUsd(data.usage, item.model);
        } else {
          turn.costUsd = worst;
        }
      } catch { turn.costUsd = worst; }
      turn.ms = Date.now() - t0;
      promptTokens += turn.promptTokens;
      completionTokens += turn.completionTokens;
      reasoningTokens += turn.reasoningTokens;
      callCostUsd += turn.costUsd;
      turns.push(turn);
      return resp;
    };

    const host = evaluationHost({
      cwd: tempDir ?? outDir ?? '/tmp',
      secretsPath,
      model: item.model,
      fetcher: wrappedFetcher,
    }, item.effort);

    const capabilityVersion = await host.profile();
    const role = item.taskDef.role;
    const name = item.taskDef.name;
    const modelSlug = item.model.replace(/[^a-zA-Z0-9.-]/g, '-');

    clone.crew = {
      workers: [
        {
          workerId: `h2h:${role}:${modelSlug}`,
          name,
          role,
          modelVersion: item.model,
          capabilityVersion,
          execution: 'host',
          backend: 'openrouter',
        },
        ...Object.keys(clone.studio?.config?.agents ?? {})
          .filter(r => r !== role)
          .map(r => ({
            workerId: `dummy:${r}`,
            name: 'Dummy',
            role: r,
            modelVersion: 'dummy',
            capabilityVersion: 'dummy',
            execution: 'host',
          })),
      ],
    };

    const startTime = Date.now();
    let event = null;
    let eventValid = false;
    let gateAccepted = false;
    let gateError = null;

    try {
      const task = taskFor(clone);
      event = await runCrewTask(clone, task, host);
      eventValid = Event.safeParse(event).success;
      try {
        applyEvent(structuredClone(clone), event);
        gateAccepted = true;
      } catch (ge) {
        gateError = ge.message;
      }
    } catch (e) {
      gateError = e.message;
    }

    const wallMs = Date.now() - startTime;
    cumulativeActualCostUsd += callCostUsd;

    // Check Sol agreement if Vera task
    let agreementWithSol = null;
    if (role === 'visual-reviewer') {
      // The source state is at the review gate, so Sol's verdict lives in the newest state.
      const curArt = clone.artifacts?.findLast(a => a.key === item.taskDef.key && (item.version == null || a.version === item.version));
      const solArt = states[0]?.artifacts?.find(a => a.id === curArt?.id) ?? curArt;
      const solReview = solArt?.review;
      if (solReview && event?.review) {
        const decisionMatch = solReview.decision === event.review.decision;
        const solChecks = new Map((solReview.checks ?? []).map(c => [c.criterion, c.status]));
        const evChecks = new Map((event.review.checks ?? []).map(c => [c.criterion, c.status]));
        let checksMatch = true;
        for (const [k, v] of solChecks) {
          if (evChecks.get(k) !== v) checksMatch = false;
        }
        const recMatch = solReview.recommendation?.selection === event.review.recommendation?.selection;
        agreementWithSol = { decisionMatch, checksMatch, recMatch };
      }
    }

    // Informational checks for Theo
    let promptFlags = null;
    if (role === 'pixar-prompter') {
      const promptText = event?.content?.prompt ?? '';
      promptFlags = {
        empty: promptText.trim().length === 0,
        hasEraWording: /19[0-9]{2}|20[0-9]{2}|mid-century|vintage|retro/i.test(promptText),
      };
    }

    results.push({
      taskId: item.taskId,
      version: item.version,
      model: item.model,
      effort: item.effort,
      repeatIndex: item.repeatIndex,
      wallMs,
      requests,
      turns,
      validationRetries,
      invalidToolCalls,
      promptTokens,
      completionTokens,
      reasoningTokens,
      costUsd: callCostUsd,
      estimatedCostUsd: item.estimatedCostUsd,
      valid: eventValid,
      gateAccepted,
      gateError,
      ...(capStopped ? { status: 'stopped (cap)' } : {}),
      event,
      agreementWithSol,
      promptFlags,
    });
  }

  if (saver) saver.db.close();

  // Generate output files
  const dateStr = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const targetDir = outDir ?? fileURLToPath(new URL(`./local/head-to-head-${dateStr}`, import.meta.url));
  await mkdir(targetDir, { recursive: true });

  await writeFile(join(targetDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');

  // Generate markdown report without data: URLs or secrets
  let md = `# Crew Head-to-Head: Muse Contributor vs DeepSeek V4.1 Flash\n\n`;
  md += `| Task | Model | Effort | Wall (ms) | Requests | Repairs | Tokens in/out | Cost ($) | Est ($) | Valid? | Gate OK? | Sol Match? |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|---|\n`;

  for (const r of results) {
    if (r.status === 'skipped (cap)') {
      md += `| ${r.taskId} | ${r.model} | ${r.effort ?? '-'} | - | - | - | - | skipped (cap) | $${r.estimatedCostUsd.toFixed(4)} | - | - | - |\n`;
      continue;
    }
    const solStr = r.agreementWithSol ? `dec:${r.agreementWithSol.decisionMatch ? '✓' : '✗'}, rec:${r.agreementWithSol.recMatch ? '✓' : '✗'}` : '-';
    md += `| ${r.taskId}${r.version ? `@v${r.version}` : ''} | ${r.model} | ${r.effort ?? 'medium'} | ${r.wallMs} | ${r.requests ?? 0} | ${(r.validationRetries ?? 0) + (r.invalidToolCalls ?? 0)} | ${r.promptTokens ?? 0}/${r.completionTokens ?? 0} | $${r.costUsd.toFixed(4)} | $${r.estimatedCostUsd.toFixed(4)} | ${r.valid ? '✓' : '✗'} | ${r.gateAccepted ? '✓' : '✗'} | ${solStr} |\n`;
  }

  md += `\n## Details\n\n`;
  for (const r of results) {
    if (!r.event) continue;
    md += `<details>\n<summary><strong>${r.taskId} (${r.model})</strong></summary>\n\n`;
    md += `\`\`\`json\n${JSON.stringify(r.event, null, 2)}\n\`\`\`\n\n`;
    md += `</details>\n\n`;
  }

  // Ensure no secrets or data: URLs
  const cleanMd = md.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE_DATA_REDACTED]');
  await writeFile(join(targetDir, 'report.md'), cleanMd);

  return { status: 'completed', capUsd: maxUsd, results, targetDir, totalActualCostUsd: cumulativeActualCostUsd, totalEstimatedCostUsd };
}

// CLI entry point
if (process.argv[1]?.endsWith('crew-head-to-head.mjs')) {
  const { values } = parseArgs({
    options: {
      run: { type: 'string' },
      secrets: { type: 'string' },
      models: { type: 'string' },
      tasks: { type: 'string' },
      repeat: { type: 'string' },
      'max-usd': { type: 'string' },
      'confirm-spend': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      version: { type: 'string' },
      'effort-muse': { type: 'string' },
      'effort-deepseek': { type: 'string' },
      out: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (!values.run) {
    process.stderr.write('Error: --run <r4 dir> required\n');
    process.exit(1);
  }

  const models = values.models ? values.models.split(',') : undefined;
  const tasks = values.tasks ? values.tasks.split(',') : undefined;
  const repeat = values.repeat ? Number(values.repeat) : undefined;
  const maxUsd = values['max-usd'] ? Number(values['max-usd']) : HARD_CAP_USD;
  const efforts = {};
  for (const [flag, model] of Object.entries(EFFORT_FLAG_MODELS)) if (values[`effort-${flag}`]) efforts[model] = values[`effort-${flag}`];

  runHeadToHead({
    runDir: values.run,
    secretsPath: values.secrets,
    models,
    tasks,
    repeat,
    maxUsd,
    version: values.version ? Number(values.version) : null,
    efforts,
    confirmSpend: values['confirm-spend'],
    dryRun: values['dry-run'],
    outDir: values.out,
  }).catch(err => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
