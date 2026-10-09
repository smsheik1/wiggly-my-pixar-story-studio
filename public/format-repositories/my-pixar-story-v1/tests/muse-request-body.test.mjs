import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { requestDescriptor, executeJob, executeMediaRequest } from '../runtime/providers.mjs';
import { importMedia } from '../runtime/media.mjs';
import { digest } from '../runtime/contracts.mjs';
import { keyFor } from '../runtime/gates.mjs';
import { audioProject } from './helpers.mjs';

function bind(p, j) { p.step = j.plan.operation; p.gate = 'collect'; j.key = keyFor(p); j.dependencies = []; j.digest = digest({ plan: j.plan, request: j.request, dependencies: j.dependencies }); j.status = 'submitting'; j.authorization = { message: 'ISOLATED TEST authorized HTTP mock', at: new Date().toISOString() }; p.jobs = [j]; return j; }

async function pngBytes(dir, name = 'muse.png') {
  const p = join(dir, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', p]);
  return readFile(p);
}

function fakeMuseFetcher(bytes, seen) {
  return async (url, opts) => {
    seen.calls = (seen.calls ?? 0) + 1;
    seen.url = url;
    seen.body = JSON.parse(opts.body);
    assert.match(url, /api\.meta\.ai\/v1\/images\//);
    return Response.json({ data: Array.from({ length: seen.body.n }, () => ({ b64_json: bytes.toString('base64') })) });
  };
}

function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  return fn().finally(() => { for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });
}

const FAKE_SCRIPT = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('agy fake 1.3.2'); process.exit(0); }
const mode = process.env.FAKE_AGY_MODE || 'success';
if (mode === 'quota-all') { console.error('Error: 429 RESOURCE_EXHAUSTED: you have exhausted your capacity, quota will reset at 9:34 PM.'); process.exit(1); }
const pIdx = args.indexOf('-p');
const prompt = pIdx >= 0 ? args[pIdx + 1] : '';
if (process.env.FAKE_AGY_LOG) { const fs = await import('node:fs'); fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(prompt) + '\\n'); }
const allOut = [...prompt.matchAll(/"([^"]+\\.png)"/g)].map(m=>m[1]);
const outPath = allOut.length ? allOut[allOut.length-1] : null;
const aspect = prompt.includes('16:9') ? '16:9' : '4:3';
const dims = aspect === '4:3' ? '1200x900' : '1600x900';
if (outPath) execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s='+dims,'-frames:v','1',outPath]);
process.exit(0);
`;

async function makeFake(dir) {
  const bin = join(dir, 'fake-agy.mjs');
  await writeFile(bin, FAKE_SCRIPT, { mode: 0o755 });
  await chmod(bin, 0o755);
  return bin;
}

async function refImage(dir, name) {
  const refPath = join(dir, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', refPath]);
  return importMedia(refPath, dir);
}

test('meta-muse edits body is allowlisted (no aspectRatio)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-body-edits-'));
  try {
    const ref = await refImage(dir, 'ref.png');
    const bytes = await pngBytes(dir);
    const p = audioProject();
    p.characterId = 'alex';
    p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });
    const plan = { provider: 'meta-muse', operation: 'candidates', estimatedCostUsd: 0.03, parameters: { prompt: 'isolated muse edits' } };
    const j = { id: 'job-muse-edits', plan, request: requestDescriptor(p, plan), digest: 'isolated' };
    bind(p, j);
    const seen = {};
    const result = await executeJob(p, j, dir, 'isolated-test-key', fakeMuseFetcher(bytes, seen));
    assert.equal(result.files.length, 3);
    assert.equal(seen.url, 'https://api.meta.ai/v1/images/edits');
    assert.deepEqual(Object.keys(seen.body).sort(), ['images', 'model', 'n', 'output_format', 'prompt', 'response_format', 'size', 'tool_enablement']);
    assert.ok(!('aspectRatio' in seen.body));
    assert.equal(seen.body.aspectRatio, undefined);
    assert.equal(seen.body.size, '1536x1152');
  } finally { await rm(dir, { recursive: true }); }
});

test('meta-muse generations body is allowlisted (no images, no aspectRatio)', async () => {
  const { readyForMaster } = await import('./background-helpers.mjs');
  const { current } = await import('../runtime/workflow.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'muse-body-gen-'));
  try {
    const bytes = await pngBytes(dir);
    const p = readyForMaster();
    const masterPlan = { provider: 'meta-muse', operation: p.step, estimatedCostUsd: 0.03, parameters: { prompt: current(p, 'backgroundPrompt:home').content.prompt } };
    const j = { id: 'background-master', plan: masterPlan, request: requestDescriptor(p, masterPlan), digest: 'isolated' };
    bind(p, j);
    const seen = {};
    const result = await executeJob(p, j, dir, 'isolated', fakeMuseFetcher(bytes, seen));
    assert.equal(result.files.length, 3);
    assert.equal(seen.url, 'https://api.meta.ai/v1/images/generations');
    assert.deepEqual(Object.keys(seen.body).sort(), ['model', 'n', 'output_format', 'prompt', 'response_format', 'size', 'tool_enablement']);
    assert.ok(!('aspectRatio' in seen.body));
    assert.equal(seen.body.size, '1536x864');
  } finally { await rm(dir, { recursive: true }); }
});

test('agy quota fallback Muse body is allowlisted (no aspectRatio)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-body-fb-'));
  const brain = join(dir, 'brain');
  const bin = await makeFake(dir);
  try {
    const bytes = await pngBytes(dir);
    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: brain, FAKE_AGY_MODE: 'quota-all' }, async () => {
      const p = audioProject();
      p.characterId = 'alex';
      const ref = await refImage(dir, 'ref-fb.png');
      p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });
      const plan = { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, fallbackEstimatedCostUsd: 0.03, parameters: { prompt: 'fallback prompt' } };
      const req = requestDescriptor(p, plan);
      const job = { id: 'job-muse-fb', plan, request: req, dependencies: [], digest: digest({ plan, request: req, dependencies: [] }) };
      const seen = {};
      const result = await executeMediaRequest(job, dir, 'isolated-meta-key', fakeMuseFetcher(bytes, seen), false);
      assert.equal(result.files.length, 3);
      assert.equal(seen.url, 'https://api.meta.ai/v1/images/edits');
      assert.deepEqual(Object.keys(seen.body).sort(), ['images', 'model', 'n', 'output_format', 'prompt', 'response_format', 'size', 'tool_enablement']);
      assert.ok(!('aspectRatio' in seen.body));
      assert.equal(seen.body.size, '1536x1152');
      assert.equal(seen.body.prompt, 'fallback prompt');
    });
  } finally { await rm(dir, { recursive: true }); }
});

test('agy path still sends aspectRatio to the agy CLI (and never calls Muse)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-body-agy-'));
  const brain = join(dir, 'brain');
  const bin = await makeFake(dir);
  const log = join(dir, 'agy-prompts.log');
  try {
    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: brain, FAKE_AGY_MODE: 'success', FAKE_AGY_LOG: log }, async () => {
      const ref = await refImage(dir, 'ref-agy.png');
      const p = audioProject();
      p.characterId = 'alex';
      p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });
      const plan = { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, fallbackEstimatedCostUsd: 0.03, parameters: { prompt: 'agy prompt' } };
      const req = requestDescriptor(p, plan);
      assert.equal(req.aspectRatio, '4:3');
      assert.equal(req.fallback.aspectRatio, '4:3');
      const job = { id: 'job-agy-aspect', plan, request: req, dependencies: [], digest: digest({ plan, request: req, dependencies: [] }) };
      const result = await executeMediaRequest(job, dir, 'isolated-meta-key', () => { throw new Error('Muse must not be called when agy succeeds'); }, false);
      assert.equal(result.files.length, 3);
      assert.equal(result.provider, 'agy');
      const prompts = (await readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
      assert.equal(prompts.length, 3);
      for (const pr of prompts) assert.ok(pr.includes('AspectRatio="4:3"'), 'agy CLI prompt must carry AspectRatio="4:3"');
    });
  } finally { await rm(dir, { recursive: true }); }
});
