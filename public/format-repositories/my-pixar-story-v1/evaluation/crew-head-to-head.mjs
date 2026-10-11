import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openRunCopy, projectStates, findState } from './r4-replay.mjs';
import { OpenRouterHost } from '../runtime/openrouter-host.mjs';
import { runCrewTask } from '../runtime/crew.mjs';
import { taskFor, applyEvent } from '../runtime/workflow.mjs';
import { Event } from '../runtime/contracts.mjs';

const PRICE_TABLE = {
  'meta/muse-spark-1.3-contributor': { inputUsdPerM: 0.10, outputUsdPerM: 0.20 },
  'deepseek/deepseek-v4.1-flash': { inputUsdPerM: 0.30, outputUsdPerM: 1.20 },
};

const TASK_DEFS = {
  'theo-room-prompt': { role: 'pixar-prompter', name: 'Theo', key: 'backgroundPrompt:childhood-room', gate: 'author' },
  'sage-prompt-review': { role: 'text-reviewer', name: 'Sage', key: 'backgroundPrompt:childhood-room', gate: 'review' },
  'vera-sheet-review': { role: 'visual-reviewer', name: 'Vera', key: 'candidates:shaz-late-teen', gate: 'review', versions: [1, 2] },
  'vera-room-review': { role: 'visual-reviewer', name: 'Vera', key: 'backgroundCandidates:childhood-room', gate: 'review', versions: [1, 2] },
  'leo-script': { role: 'script-writer', name: 'Leo', key: 'script', gate: 'author' },
};

const RUN_ORDER = ['sage-prompt-review', 'theo-room-prompt', 'vera-room-review', 'vera-sheet-review'];

export function estimateTaskCost(taskObj, model) {
  const price = PRICE_TABLE[model] ?? { inputUsdPerM: 0.30, outputUsdPerM: 1.20 };
  const approxTokens = 4000; // average task packet + context
  return (approxTokens / 1_000_000) * price.inputUsdPerM + (500 / 1_000_000) * price.outputUsdPerM;
}

export async function runHeadToHead({
  runDir,
  secretsPath,
  models = ['meta/muse-spark-1.3-contributor', 'deepseek/deepseek-v4.1-flash'],
  tasks = RUN_ORDER,
  repeat = 1,
  maxUsd = 0.10,
  confirmSpend = false,
  dryRun = false,
  outDir = null,
  fetcher = fetch,
  stateList = null,
} = {}) {
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
    const versions = def.versions ?? [null];
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
    process.stdout.write(`- ${item.taskId}${item.version ? `@v${item.version}` : ''} × ${item.model}: ~$${item.estimatedCostUsd.toFixed(5)}\n`);
  }
  process.stdout.write(`Total Estimated Cost: ~$${totalEstimatedCostUsd.toFixed(5)} (Max allowed: $${maxUsd.toFixed(2)})\n`);

  if (!confirmSpend && !dryRun) {
    process.stdout.write(`Spend not confirmed. Pass --confirm-spend to execute paid calls or --dry-run to test locally.\n`);
    if (saver) saver.db.close();
    return { status: 'unconfirmed', estimatedCostUsd: totalEstimatedCostUsd };
  }

  if (totalEstimatedCostUsd > maxUsd && !dryRun) {
    process.stderr.write(`Estimated cost ($${totalEstimatedCostUsd.toFixed(4)}) exceeds --max-usd ($${maxUsd.toFixed(2)}). Use --tasks to narrow scope.\n`);
    if (saver) saver.db.close();
    return { status: 'cap_exceeded', estimatedCostUsd: totalEstimatedCostUsd };
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

    const wrappedFetcher = async (url, init) => {
      const resp = await fetcher(url, init);
      try {
        const cloned = resp.clone();
        const data = await cloned.json();
        if (data?.usage) {
          requests++;
          promptTokens += Number(data.usage.prompt_tokens) || 0;
          completionTokens += Number(data.usage.completion_tokens) || 0;
          callCostUsd += Number(data.usage.cost) || 0;
        }
      } catch {}
      return resp;
    };

    const host = new OpenRouterHost({
      cwd: tempDir ?? outDir ?? '/tmp',
      secretsPath,
      model: item.model,
      fetcher: wrappedFetcher,
    });

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
      const curArt = clone.artifacts?.findLast(a => a.key === item.taskDef.key && (item.version == null || a.version === item.version));
      const solReview = curArt?.review;
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
      repeatIndex: item.repeatIndex,
      wallMs,
      requests,
      promptTokens,
      completionTokens,
      costUsd: callCostUsd,
      estimatedCostUsd: item.estimatedCostUsd,
      valid: eventValid,
      gateAccepted,
      gateError,
      event,
      agreementWithSol,
      promptFlags,
    });
  }

  if (saver) saver.db.close();

  // Generate output files
  const dateStr = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const targetDir = outDir ?? join(process.cwd(), 'evaluation', 'local', `head-to-head-${dateStr}`);
  await mkdir(targetDir, { recursive: true });

  await writeFile(join(targetDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');

  // Generate markdown report without data: URLs or secrets
  let md = `# Crew Head-to-Head: Muse Contributor vs DeepSeek V4.1 Flash\n\n`;
  md += `| Task | Model | Wall (ms) | Cost ($) | Est ($) | Valid? | Gate OK? | Sol Match? |\n`;
  md += `|---|---|---|---|---|---|---|---|\n`;

  for (const r of results) {
    if (r.status === 'skipped (cap)') {
      md += `| ${r.taskId} | ${r.model} | - | skipped (cap) | $${r.estimatedCostUsd.toFixed(4)} | - | - | - |\n`;
      continue;
    }
    const solStr = r.agreementWithSol ? `dec:${r.agreementWithSol.decisionMatch ? '✓' : '✗'}, rec:${r.agreementWithSol.recMatch ? '✓' : '✗'}` : '-';
    md += `| ${r.taskId}${r.version ? `@v${r.version}` : ''} | ${r.model} | ${r.wallMs} | $${r.costUsd.toFixed(4)} | $${r.estimatedCostUsd.toFixed(4)} | ${r.valid ? '✓' : '✗'} | ${r.gateAccepted ? '✓' : '✗'} | ${solStr} |\n`;
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

  return { status: 'completed', results, targetDir, totalActualCostUsd: cumulativeActualCostUsd, totalEstimatedCostUsd };
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
  const maxUsd = values['max-usd'] ? Number(values['max-usd']) : 0.10;

  runHeadToHead({
    runDir: values.run,
    secretsPath: values.secrets,
    models,
    tasks,
    repeat,
    maxUsd,
    confirmSpend: values['confirm-spend'],
    dryRun: values['dry-run'],
    outDir: values.out,
  }).catch(err => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
