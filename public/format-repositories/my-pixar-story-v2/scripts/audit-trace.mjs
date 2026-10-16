#!/usr/bin/env node
// Trace audit report: fetch a run's LangSmith trace and write runs/<id>/audit.md + an HTML section in
// runs/<id>/report.html and the progress tracker. Read-only against LangSmith; no model calls.
// Usage: node scripts/audit-trace.mjs [--run-id <id>] [--trace-id <uuid>] [--from-file <trace.json>] [--save-trace <file>] [--secrets <env>] [--no-tracker]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUNS_ROOT } from '../graph/deep-agent-node.mjs';
import { loadSecrets, defaultSecretsPath } from './lib/secrets.mjs';
import { V2_PROJECT } from './lib/tracing.mjs';
import { defaultTrackerPath } from './lib/report.mjs';
import { auditTrace, auditMarkdown, auditHtml, upsertSection, slimRun } from './lib/audit.mjs';

const ROOT_NAME = 'wiggly-v2 rehearsal';
/** Trace id recorded in runs/<id>/report.html (the run that actually produced the outputs), if any. */
export function traceIdFromReport(runsRoot, runId) {
  const f = join(runsRoot, runId, 'report.html');
  if (!existsSync(f)) return null;
  return /trace_id=([0-9a-f-]{36})/.exec(readFileSync(f, 'utf8'))?.[1] ?? null;
}

export async function langsmithClient(sec) {
  const { Client } = await import('langsmith');
  return new Client({ apiKey: sec.LANGSMITH_API_KEY, ...(sec.LANGSMITH_ENDPOINT ? { apiUrl: sec.LANGSMITH_ENDPOINT } : {}), callerOptions: { maxRetries: 2 } });
}

/** Resolve the root run: explicit trace id > trace id in report.html > latest root tagged runId:<id> > latest root. */
export async function findRoot(client, { projectName, runId, traceId, runsRoot = RUNS_ROOT }) {
  const tid = traceId ?? (runId ? traceIdFromReport(runsRoot, runId) : null);
  if (tid) return client.readRun(tid);
  const filter = runId ? `has(tags, "runId:${runId.replace(/"/g, '')}")` : undefined;
  for await (const r of client.listRuns({ projectName, isRoot: true, limit: 1, ...(filter ? { filter } : {}) })) if (r.name === ROOT_NAME || !runId) return r;
  throw new Error(runId ? `no LangSmith trace tagged runId:${runId} in ${projectName}` : `no traces in ${projectName}`);
}

export async function fetchTraceRuns(client, traceId) {
  const out = [];
  for await (const r of client.listRuns({ traceId })) out.push(slimRun(r));
  return out;
}

const upsertFile = (path, section) => { if (!existsSync(path)) return false; const next = upsertSection(readFileSync(path, 'utf8'), section); writeFileSync(`${path}.tmp`, next); renameSync(`${path}.tmp`, path); return true; };

/** Audit one run and write the outputs. Returns { model, md, mdPath }. */
export async function auditRun({ runId, traceId, runs, runsRoot = RUNS_ROOT, secrets, secretsPath = defaultSecretsPath(), trackerPath = defaultTrackerPath(), client, saveTrace, log = console.log } = {}) {
  if (!runs) {
    const sec = secrets ?? loadSecrets(secretsPath);
    if (!client && !sec.LANGSMITH_API_KEY) throw new Error('LANGSMITH_API_KEY not found; cannot fetch the trace');
    client ??= await langsmithClient(sec);
    const root = await findRoot(client, { projectName: sec.LANGSMITH_PROJECT || V2_PROJECT, runId, traceId, runsRoot });
    runs = await fetchTraceRuns(client, root.trace_id ?? root.id);
    if (saveTrace) await writeFile(saveTrace, JSON.stringify(runs));
  }
  const id0 = runId ?? (runs.find((r) => !r.parent_run_id)?.tags ?? []).find((t) => t.startsWith('runId:'))?.slice(6);
  const stateFile = id0 ? join(runsRoot, id0, 'outputs', 'state.json') : null;
  let validationErrors = [];
  if (stateFile && existsSync(stateFile)) { try { validationErrors = JSON.parse(readFileSync(stateFile, 'utf8')).validationErrors ?? []; } catch { /* optional */ } }
  const model = auditTrace(runs, { validationErrors });
  const id = id0 ?? model.runId ?? model.traceId;
  const dir = join(runsRoot, id); await mkdir(dir, { recursive: true });
  const md = auditMarkdown(model), html = auditHtml(model);
  const mdPath = join(dir, 'audit.md');
  await writeFile(mdPath, md); await writeFile(join(dir, 'audit.html'), html);
  upsertFile(join(dir, 'report.html'), html);
  if (trackerPath) { try { upsertFile(trackerPath, html); } catch { /* tracker optional */ } }
  log(`audit: ${mdPath} (${model.tokens} tokens, $${model.cost.toFixed(4)}, ${model.rejected.length} rejected attempts)`);
  return { model, md, mdPath };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  (async () => {
    const runs = arg('--from-file') ? JSON.parse(await readFile(arg('--from-file'), 'utf8')) : undefined;
    const { md } = await auditRun({ runId: arg('--run-id'), traceId: arg('--trace-id'), runs, saveTrace: arg('--save-trace'),
      ...(arg('--secrets') ? { secretsPath: arg('--secrets') } : {}), ...(process.argv.includes('--no-tracker') ? { trackerPath: null } : {}) });
    console.log(md);
  })().catch((e) => { console.error(`audit failed: ${e.message}`); process.exitCode = 1; });
}
