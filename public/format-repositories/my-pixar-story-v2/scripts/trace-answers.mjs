#!/usr/bin/env node
// Answer tracing: what every agent did with each concrete fact in the answers.
// Usage: node scripts/trace-answers.mjs --run <runId|runs/<id>> [--answers <project.json|inputs.json>] [--cache-dir .cache/answer-facts] [--dry-run]
// All model calls go through the OpenCode CLI (scripts/lib/muse-opencode.mjs).
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadOutputs } from './benchmark.mjs';
import { upsertSection } from './lib/audit.mjs';
import { defaultTrackerPath } from './lib/report.mjs';
import { museCall } from './lib/muse-opencode.mjs';
import { loadAnswersFile, traceRun, TRACE_START, TRACE_END } from './lib/answer-trace.mjs';

const arg = (k) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && i < process.argv.length - 1 ? process.argv[i + 1] : undefined;
};

export async function main({
  runArg,
  answersPath,
  cacheDir = '.cache/answer-facts',
  dryRun = false,
  trackerPath = defaultTrackerPath(),
  log = console.error,
  call = museCall,
} = {}) {
  if (!runArg) throw new Error('Usage: node scripts/trace-answers.mjs --run <runId|runs/<id>> [--answers <file>] [--cache-dir <dir>] [--dry-run]');
  const runDir = existsSync(runArg) ? runArg : join('runs', runArg);
  if (!existsSync(runDir)) throw new Error(`run directory not found: ${runArg}`);
  const answers = await loadAnswersFile(answersPath ?? 'benchmarks/r4-dry6/inputs.json');
  const outputs = await loadOutputs(join(runDir, 'outputs'));

  const timedCall = async (prompt) => {
    const t0 = Date.now();
    try {
      const text = await call(prompt);
      log(`muse call: ${Date.now() - t0}ms, prompt ${prompt.length} chars`);
      return text;
    } catch (e) {
      log(`muse call failed after ${Date.now() - t0}ms: ${e.message}`);
      throw e;
    }
  };

  const result = await traceRun({ answers, outputs, cacheDir, museCall: timedCall, dryRun, log });
  if (result.dryRun) {
    const total = result.calls.reduce((n, c) => n + c.chars, 0);
    console.log(`dry-run: ${result.calls.length} muse call(s), ${total} prompt chars (~${Math.ceil(total / 4)} tokens)`);
    for (const c of result.calls) console.log(`  ${c.label}: ${c.chars} chars (~${c.tokens} tokens)`);
    return result;
  }

  await writeFile(join(runDir, 'answer-trace.json'), JSON.stringify(result.model, null, 2), 'utf8');
  await writeFile(join(runDir, 'answer-trace.md'), result.markdown, 'utf8');

  const reportPath = join(runDir, 'report.html');
  if (existsSync(reportPath)) {
    const html = await readFile(reportPath, 'utf8');
    await writeFile(reportPath, upsertSection(html, result.html, { start: TRACE_START, end: TRACE_END }), 'utf8');
  } else {
    log(`note: ${reportPath} missing, skipped report.html upsert`);
  }
  if (trackerPath && existsSync(trackerPath)) {
    const tracker = await readFile(trackerPath, 'utf8');
    await writeFile(trackerPath, upsertSection(tracker, result.html, { start: TRACE_START, end: TRACE_END }), 'utf8');
  } else {
    log(`note: tracker ${trackerPath} missing, skipped tracker upsert`);
  }
  console.log(`answer trace written: ${join(runDir, 'answer-trace.md')} (storyFaithfulness ${result.model.storyFaithfulness ?? 'n/a'})`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const has = (k) => process.argv.includes(k);
  main({
    runArg: arg('--run'),
    answersPath: arg('--answers'),
    ...(arg('--cache-dir') ? { cacheDir: arg('--cache-dir') } : {}),
    dryRun: has('--dry-run'),
  }).catch((e) => {
    console.error(`trace-answers failed: ${e.message}`);
    process.exit(1);
  });
}
