import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openRunCopy, veraJudgments } from './r4-replay.mjs';
import { runPrescreen, estimatePrescreenCost } from '../runtime/decisions-prescreen.mjs';
import { criteriaFor } from '../runtime/workflow.mjs';

export function computePrescreenMetrics(evaluations) {
  // evaluations: array of { judgment, prescreen, latencyMs }
  let tp = 0, fp = 0, tn = 0, fn = 0, uncertain = 0;
  const perCriterion = {}; // { crit: { match: 0, total: 0 } }
  let rankMatchVera = 0;
  let rankMatchShaz = 0;
  let rankEvaluated = 0;
  const falsePasses = [];
  const latencies = [];

  for (const item of evaluations) {
    const { judgment, prescreen, latencyMs } = item;
    latencies.push(latencyMs);

    const veraDecision = judgment.decision; // 'approved' | 'provisional' | 'rejected'
    const veraPass = veraDecision === 'approved' || veraDecision === 'provisional';
    const prePass = prescreen.verdict === 'pass';
    const preFail = prescreen.verdict === 'fail';

    if (prescreen.verdict === 'uncertain') {
      uncertain++;
    } else if (veraPass && prePass) {
      tp++;
    } else if (!veraPass && prePass) {
      fp++;
      falsePasses.push(item);
    } else if (!veraPass && preFail) {
      tn++;
    } else if (veraPass && preFail) {
      fn++;
    }

    // Per-criterion agreement
    const solChecks = new Map((judgment.checks ?? []).map(c => [c.criterion, c.status]));
    for (const f of prescreen.files ?? []) {
      for (const c of f.checks ?? []) {
        const crit = c.criterion;
        if (!perCriterion[crit]) perCriterion[crit] = { match: 0, total: 0 };
        const solStatus = solChecks.get(crit);
        if (solStatus) {
          perCriterion[crit].total++;
          if (solStatus === c.status) perCriterion[crit].match++;
        }
      }
    }

    // Ranking top-1 agreement
    if (prescreen.ranking && prescreen.ranking.length > 0) {
      rankEvaluated++;
      const top1 = prescreen.ranking[0];
      if (judgment.recommendation?.selection === top1) {
        rankMatchVera++;
      }
      if (judgment.selection === top1) {
        rankMatchShaz++;
      }
    }
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0;
  const maxLat = latencies.length ? latencies[latencies.length - 1] : 0;

  return {
    total: evaluations.length,
    confusion: { tp, fp, tn, fn, uncertain },
    falsePassCount: fp,
    falsePasses,
    perCriterion,
    rankingAgreement: {
      evaluated: rankEvaluated,
      top1Vera: rankMatchVera,
      top1Shaz: rankMatchShaz,
      rateVera: rankEvaluated ? rankMatchVera / rankEvaluated : 0,
      rateShaz: rankEvaluated ? rankMatchShaz / rankEvaluated : 0,
    },
    latency: { p50, max: maxLat },
  };
}

export const replayDecisions = runDecisionsReplay;

export async function runDecisionsReplay({
  runDir,
  secretsPath,
  models = ['openai/gpt-6-luna-decisions', 'cloudflare/clef-flash'],
  configOverrides = {},
  limit = null,
  maxUsd = 0.05,
  confirmSpend = false,
  dryRun = false,
  outDir = null,
  fetcher = fetch,
  judgmentsList = null,
} = {}) {
  let saver = null, tempDir = null;
  let judgments = judgmentsList;

  if (!judgments) {
    const runCopy = await openRunCopy(runDir);
    saver = runCopy.saver;
    tempDir = runCopy.tempDir;
    // Get latest project state
    let latestProject = null;
    for await (const s of (await import('./r4-replay.mjs')).projectStates(saver)) {
      latestProject = s;
      break;
    }
    if (!latestProject) {
      throw new Error(`No project states found in ${runDir}`);
    }
    judgments = veraJudgments(latestProject);
  }

  if (limit != null) {
    judgments = judgments.slice(0, limit);
  }

  // Pre-calculate estimated cost for both models
  let totalEstimatedCostUsd = 0;
  const planItems = [];

  for (const model of models) {
    let modelEst = 0;
    for (const j of judgments) {
      const criteria = criteriaFor({ step: j.step });
      const est = estimatePrescreenCost({
        model,
        files: j.files,
        references: j.artifact.content?.references ?? [],
        contextText: j.artifact.content?.prompt ?? '',
      });
      modelEst += est;
      planItems.push({ model, judgment: j, est, criteria });
    }
    totalEstimatedCostUsd += modelEst;
  }

  process.stdout.write(`=== Decisions Replay Estimated Cost ===\n`);
  process.stdout.write(`Judgments to evaluate: ${judgments.length} per model\n`);
  for (const model of models) {
    const mEst = planItems.filter(p => p.model === model).reduce((s, p) => s + p.est, 0);
    process.stdout.write(`- ${model}: ~$${mEst.toFixed(5)}\n`);
  }
  process.stdout.write(`Total Estimated Cost: ~$${totalEstimatedCostUsd.toFixed(5)} (Default cap: $${maxUsd.toFixed(2)})\n`);

  if (!confirmSpend && !dryRun) {
    process.stdout.write(`Spend not confirmed. Pass --confirm-spend to execute paid calls or --dry-run to test locally.\n`);
    if (saver) saver.db.close();
    return { status: 'unconfirmed', estimatedCostUsd: totalEstimatedCostUsd, totalEstimatedCostUsd };
  }

  if (totalEstimatedCostUsd > maxUsd && !dryRun) {
    process.stderr.write(`Estimated cost ($${totalEstimatedCostUsd.toFixed(5)}) exceeds --max-usd ($${maxUsd.toFixed(2)}). Use --limit or a single model.\n`);
    if (saver) saver.db.close();
    return { status: 'cap_exceeded', estimatedCostUsd: totalEstimatedCostUsd };
  }

  let cumulativeActualCostUsd = 0;
  const resultsByModel = {};
  for (const model of models) resultsByModel[model] = [];

  for (const item of planItems) {
    if (dryRun) {
      resultsByModel[item.model].push({
        judgment: item.judgment,
        prescreen: {
          verdict: 'pass',
          files: item.judgment.files.map((f, i) => ({ index: i, sha256: f.sha256, verdict: 'pass', checks: [] })),
          ranking: [0, 1, 2],
          usage: { costUsd: 0, inputTokens: 100 },
        },
        latencyMs: 0,
        costUsd: 0,
        estimatedCostUsd: item.est,
        dryRun: true,
      });
      continue;
    }

    if (cumulativeActualCostUsd + item.est > maxUsd) {
      resultsByModel[item.model].push({
        judgment: item.judgment,
        status: 'skipped (cap)',
        costUsd: 0,
        estimatedCostUsd: item.est,
      });
      continue;
    }

    const t0 = Date.now();
    let prescreenResult = null;
    let cost = 0;
    try {
      prescreenResult = await runPrescreen({
        config: { model: item.model, ...configOverrides },
        secretsPath,
        fetcher,
        step: item.judgment.step,
        files: item.judgment.files,
        references: item.judgment.artifact.content?.references ?? [],
        contextText: item.judgment.artifact.content?.prompt ?? '',
        criteria: item.criteria,
      });
      cost = prescreenResult.usage?.costUsd ?? 0;
      cumulativeActualCostUsd += cost;
    } catch (e) {
      prescreenResult = {
        verdict: 'uncertain',
        files: [],
        ranking: null,
        error: e.message,
        usage: { costUsd: 0, inputTokens: 0 },
      };
    }
    const latencyMs = Date.now() - t0;

    resultsByModel[item.model].push({
      judgment: item.judgment,
      prescreen: prescreenResult,
      latencyMs,
      costUsd: cost,
      estimatedCostUsd: item.est,
    });
  }

  if (saver) saver.db.close();

  // Metrics computation per model
  const metricsByModel = {};
  for (const model of models) {
    const completed = resultsByModel[model].filter(r => r.status !== 'skipped (cap)');
    metricsByModel[model] = computePrescreenMetrics(completed);
  }

  // Write reports
  const dateStr = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const targetDir = outDir ?? join(process.cwd(), 'evaluation', 'local', `decisions-replay-${dateStr}`);
  await mkdir(targetDir, { recursive: true });

  await writeFile(
    join(targetDir, 'results.json'),
    JSON.stringify({ resultsByModel, metricsByModel, cumulativeActualCostUsd, totalEstimatedCostUsd }, null, 2) + '\n'
  );

  let md = `# Decisions Prescreen Replay Report (Vera r4 Judgments)\n\n`;
  md += `## Side-by-Side Summary\n\n`;
  md += `| Metric | ${models.join(' | ')} |\n`;
  md += `|---|${models.map(() => '---').join('|')}|\n`;
  md += `| Total Evaluated | ${models.map(m => metricsByModel[m]?.total ?? 0).join(' | ')} |\n`;
  md += `| False Passes (Safety Critical) | ${models.map(m => metricsByModel[m]?.falsePassCount ?? 0).join(' | ')} |\n`;
  md += `| Agreement (TP + TN) | ${models.map(m => `${(metricsByModel[m]?.confusion.tp ?? 0) + (metricsByModel[m]?.confusion.tn ?? 0)}`).join(' | ')} |\n`;
  md += `| Top-1 Agreement vs Vera | ${models.map(m => `${((metricsByModel[m]?.rankingAgreement.rateVera ?? 0) * 100).toFixed(1)}%`).join(' | ')} |\n`;
  md += `| Top-1 Agreement vs Shaz | ${models.map(m => `${((metricsByModel[m]?.rankingAgreement.rateShaz ?? 0) * 100).toFixed(1)}%`).join(' | ')} |\n`;
  md += `| Latency p50 / Max (ms) | ${models.map(m => `${metricsByModel[m]?.latency.p50} / ${metricsByModel[m]?.latency.max}`).join(' | ')} |\n`;
  md += `| Actual Cost (Total) | ${models.map(m => `$${resultsByModel[m].reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(5)}`).join(' | ')} |\n`;
  md += `| Estimated Cost (Total) | ${models.map(m => `$${resultsByModel[m].reduce((s, r) => s + (r.estimatedCostUsd ?? 0), 0).toFixed(5)}`).join(' | ')} |\n\n`;

  for (const model of models) {
    const met = metricsByModel[model];
    md += `## Model: ${model}\n\n`;
    md += `### Confusion Matrix\n`;
    md += `- True Positive (Both Pass): ${met.confusion.tp}\n`;
    md += `- True Negative (Both Reject): ${met.confusion.tn}\n`;
    md += `- False Positive (**False Pass - prescreen passed, Vera rejected**): ${met.confusion.fp}\n`;
    md += `- False Negative (Prescreen rejected, Vera passed): ${met.confusion.fn}\n`;
    md += `- Uncertain: ${met.confusion.uncertain}\n\n`;

    if (met.falsePasses.length > 0) {
      md += `### False Passes List\n`;
      for (const fpItem of met.falsePasses) {
        md += `- **${fpItem.judgment.key} (v${fpItem.judgment.version})**: Vera rejected (${fpItem.judgment.decision}), prescreen passed.\n`;
      }
      md += `\n`;
    }

    md += `### Per-Criterion Agreement\n`;
    md += `| Criterion | Matches | Total | Agreement |\n|---|---|---|---|\n`;
    for (const [crit, data] of Object.entries(met.perCriterion)) {
      const rate = data.total ? ((data.match / data.total) * 100).toFixed(1) : 'N/A';
      md += `| ${crit} | ${data.match} | ${data.total} | ${rate}% |\n`;
    }
    md += `\n`;
  }

  await writeFile(join(targetDir, 'report.md'), md);

  return {
    status: 'completed',
    metricsByModel,
    resultsByModel,
    targetDir,
    totalActualCostUsd: cumulativeActualCostUsd,
    totalEstimatedCostUsd,
  };
}

if (process.argv[1]?.endsWith('decisions-replay.mjs')) {
  const { values } = parseArgs({
    options: {
      run: { type: 'string' },
      secrets: { type: 'string' },
      models: { type: 'string' },
      config: { type: 'string' },
      limit: { type: 'string' },
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
  const configOverrides = values.config ? JSON.parse(values.config) : {};
  const limit = values.limit ? Number(values.limit) : undefined;
  const maxUsd = values['max-usd'] ? Number(values['max-usd']) : 0.05;

  runDecisionsReplay({
    runDir: values.run,
    secretsPath: values.secrets,
    models,
    configOverrides,
    limit,
    maxUsd,
    confirmSpend: values['confirm-spend'],
    dryRun: values['dry-run'],
    outDir: values.out,
  }).catch(err => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
