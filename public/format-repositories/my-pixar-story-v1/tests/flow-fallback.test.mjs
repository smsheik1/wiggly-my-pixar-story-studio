import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { classifyFlowMessage, FlowError, isFlowFallbackError, FLOW_MODEL } from '../runtime/flow-image.mjs';
import { requestDescriptor, executeMediaRequest } from '../runtime/providers.mjs';
import { importMedia } from '../runtime/media.mjs';
import { digest } from '../runtime/contracts.mjs';
import { audioProject } from './helpers.mjs';

const img = (path, size = '1200x900') => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=blue:s=${size}`, '-frames:v', '1', path]);

async function setup(withFallback = true) {
  const dir = await mkdtemp(join(tmpdir(), 'flow-job-'));
  const p = audioProject(); p.characterId = 'alex';
  const refPath = join(dir, 'ref.png'); img(refPath, '32x32');
  const ref = await importMedia(refPath, dir);
  p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });
  const plan = { provider: 'google-flow', operation: 'candidates', estimatedCostUsd: 0, ...(withFallback ? { fallbackEstimatedCostUsd: 0.03 } : {}), parameters: { prompt: 'sheet prompt' } };
  const request = requestDescriptor(p, plan);
  const job = { id: `job-flow-${withFallback}`, plan, request, dependencies: [], key: 'candidates', status: 'submitting', authorization: { message: 't', at: new Date().toISOString() } };
  job.digest = digest({ plan, request, dependencies: [] });
  return { dir, job };
}
const museFetcher = (dir, calls) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  const n = JSON.parse(init.body).n; const w = join(dir, 'muse.png'); img(w);
  const b64 = (await readFile(w)).toString('base64');
  return { ok: true, json: async () => ({ data: Array.from({ length: n }, () => ({ b64_json: b64 })) }) };
};

test('classifyFlowMessage maps Flow UI messages to typed codes', () => {
  assert.equal(classifyFlowMessage('Failed to upload ref.jpg', 'upload'), 'FLOW_UPLOAD_REJECTED');
  assert.equal(classifyFlowMessage('Failed to upload ref.jpg'), 'FLOW_UPLOAD_REJECTED');
  assert.equal(classifyFlowMessage('This prompt might violate our policies'), 'FLOW_POLICY_REFUSED');
  assert.equal(classifyFlowMessage('Something went wrong'), 'FLOW_UI_ERROR');
  assert.ok(isFlowFallbackError(new FlowError('FLOW_UI_ERROR', 'x')));
  assert.ok(!isFlowFallbackError(new Error('ENOSPC')));
});

test('google-flow is the studio default image provider and plans bind a Muse fallback', async () => {
  const studio = JSON.parse(await readFile(new URL('../studio.json', import.meta.url), 'utf8'));
  assert.equal(studio.generation.image.provider, 'google-flow');
  const { dir, job } = await setup();
  try {
    assert.equal(job.request.provider, 'google-flow');
    assert.equal(job.request.model, FLOW_MODEL);
    assert.equal(job.request.aspectRatio, '4:3');
    assert.equal(job.request.fallback.provider, 'meta-muse');
    assert.equal(job.request.fallback.model, 'muse-image-1.0');
  } finally { await rm(dir, { recursive: true }); }
});

test('Flow success records google-flow per image and never calls Muse', async () => {
  const { dir, job } = await setup(); const calls = [];
  try {
    let n = 0;
    const flowGenerator = async ({ outputPath, imagePaths, aspectRatio }) => { n++; assert.equal(aspectRatio, '4:3'); assert.equal(imagePaths.length, 1); img(outputPath); return { outputPath }; };
    const r = await executeMediaRequest(job, dir, 'k', museFetcher(dir, calls), false, undefined, { flowGenerator });
    assert.equal(n, 3); assert.equal(calls.length, 0);
    assert.equal(r.provider, 'google-flow');
    assert.deepEqual(r.imageProviders.map(x => x.provider), ['google-flow', 'google-flow', 'google-flow']);
    assert.equal(JSON.parse(await readFile(join(dir, 'receipts', job.id, '0.json'), 'utf8')).model, FLOW_MODEL);
  } finally { await rm(dir, { recursive: true }); }
});

for (const code of ['FLOW_UPLOAD_REJECTED', 'FLOW_POLICY_REFUSED', 'FLOW_UI_ERROR']) {
  test(`${code} falls back to Muse for the remaining images and records the backend`, async () => {
    const { dir, job } = await setup(); const calls = [];
    try {
      let n = 0;
      const flowGenerator = async ({ outputPath }) => { n++; if (n === 2) throw new FlowError(code, 'mock'); img(outputPath); return { outputPath }; };
      const r = await executeMediaRequest(job, dir, 'k', museFetcher(dir, calls), false, undefined, { flowGenerator });
      assert.equal(n, 2); assert.equal(calls.length, 1); assert.equal(calls[0].body.n, 2);
      assert.match(calls[0].url, /api\.meta\.ai\/v1\/images\/edits/);
      assert.equal(r.provider, 'mixed');
      assert.deepEqual(r.imageProviders.map(x => x.provider), ['google-flow', 'meta-muse', 'meta-muse']);
      assert.equal(JSON.parse(await readFile(join(dir, 'receipts', job.id, '1.quota.json'), 'utf8')).reason, code);
    } finally { await rm(dir, { recursive: true }); }
  });
}

test('Flow refusal without a bound fallback stops; non-Flow errors never fall back', async () => {
  const a = await setup(false); const calls = [];
  try {
    await assert.rejects(executeMediaRequest(a.job, a.dir, 'k', museFetcher(a.dir, calls), false, undefined, { flowGenerator: async () => { throw new FlowError('FLOW_UPLOAD_REJECTED', 'Failed to upload ref.jpg'); } }), /FLOW_UPLOAD_REJECTED.*no Muse fallback/);
    assert.equal(calls.length, 0);
  } finally { await rm(a.dir, { recursive: true }); }
  const b = await setup(true);
  try {
    await assert.rejects(executeMediaRequest(b.job, b.dir, 'k', museFetcher(b.dir, calls), false, undefined, { flowGenerator: async () => { throw new Error('disk full'); } }), /disk full/);
    assert.equal(calls.length, 0);
  } finally { await rm(b.dir, { recursive: true }); }
});

test('flow:login launches plain system Chrome: only the profile and the Flow URL', async () => {
  const { loginArgs, FLOW_URL } = await import('../runtime/flow-image.mjs');
  const args = loginArgs('/tmp/prof');
  assert.deepEqual(args, ['--user-data-dir=/tmp/prof', FLOW_URL]);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['flow:login'], 'node runtime/flow-image.mjs login');
});

test('generation Chrome args carry no automation or sandbox flags', async () => {
  const { generationArgs } = await import('../runtime/flow-image.mjs');
  const args = generationArgs('/tmp/prof', 9333);
  assert.ok(args.includes('--user-data-dir=/tmp/prof') && args.includes('--remote-debugging-port=9333'));
  for (const bad of ['--no-sandbox', '--enable-automation', '--headless', '--disable-blink-features']) assert.ok(!args.some(a => a.startsWith(bad)), bad);
});
