import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateAgyImage } from '../runtime/agy-image.mjs';
import { isAgyQuotaError, parseAgyQuotaReset, requestDescriptor } from '../runtime/providers.mjs';
import { executeMediaRequest } from '../runtime/providers.mjs';
import { importMedia } from '../runtime/media.mjs';
import { digest } from '../runtime/contracts.mjs';
import { keyFor } from '../runtime/gates.mjs';
import { audioProject } from './helpers.mjs';

const FAKE_SCRIPT = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('agy fake 1.3.2'); process.exit(0); }
const mode = process.env.FAKE_AGY_MODE || 'success';
const pIdx = args.indexOf('-p');
const prompt = pIdx >= 0 ? args[pIdx + 1] : '';
const nameMatch = prompt.match(/ImageName[^"]*"([^"]+)"/) || prompt.match(/"([^"]*job[^"]*)"/);
const imageName = nameMatch ? nameMatch[1] : 'out';
if (mode === 'quota-all') { console.error('Error: 429 RESOURCE_EXHAUSTED: you have exhausted your capacity, quota will reset at 9:34 PM.'); process.exit(1); }
if (mode.startsWith('quota-on-')) {
  const failSuffix = '-' + mode.slice('quota-on-'.length);
  if (imageName.endsWith(failSuffix)) { console.error('Error: 429 RESOURCE_EXHAUSTED: you have exhausted your capacity, quota will reset at 9:34 PM.'); process.exit(1); }
}
if (mode.startsWith('quota-log-on-') && imageName.endsWith('-' + mode.slice('quota-log-on-'.length))) {
  // Real agy behaviour: the image tool hits 429 RESOURCE_EXHAUSTED, agy still exits 0, the only record is its CLI log.
  const logDir = process.env.WIGGLY_AGY_LOG_DIR; fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(logDir + '/cli-20261009_000741.log', [
    'W1009 00:07:42.148717     174 mcp_auth.go:677] OAuth setup failed for buffer: registration failed with status 429: Error 1015: You are being rate limited',
    'E1009 00:08:10.463585    3062 generate_image.go:167] error generating image: failed to generate content: 429 Too Many Requests, body: {',
    '  "error": {', '    "code": 429,', '    "message": "You have exhausted your capacity on this model. Your quota will reset after 3h0m43s.",', '    "status": "RESOURCE_EXHAUSTED",',
    '    "details": [ { "reason": "QUOTA_EXHAUSTED", "metadata": { "model": "gemini-3.1-flash-image", "quotaResetDelay": "3h0m43.502788675s" } } ]', '  }', '}', ''].join('\\n'));
  console.log(JSON.stringify({ response: 'I was unable to generate the image.' }));
  process.exit(0);
}
if (mode === 'nonzero') { console.error('fake agy failure tail'); process.exit(1); }
const allOut = [...prompt.matchAll(/"([^"]+\.png)"/g)].map(m=>m[1]);
const outPath = allOut.length ? allOut[allOut.length-1] : null;
const aspect = prompt.includes('16:9') ? '16:9' : '4:3';
const dims = aspect === '4:3' ? '1200x900' : '1600x900';
const mk = (dest) => { execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s='+dims,'-frames:v','1',dest]); };
if (outPath) mk(outPath);
process.exit(0);
`;

async function makeFake(dir) {
  const bin = join(dir, 'fake-agy.mjs');
  await writeFile(bin, FAKE_SCRIPT, { mode: 0o755 });
  await chmod(bin, 0o755);
  return bin;
}

function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  return fn().finally(() => { for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });
}

async function pngBytes(dir, name = 'muse.png') {
  const p = join(dir, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', p]);
  return readFile(p);
}

function fakeMuseFetcher(bytes, seen) {
  return async (url, opts) => {
    seen.calls++;
    seen.url = url;
    seen.body = JSON.parse(opts.body);
    assert.match(url, /api\.meta\.ai\/v1\/images\//);
    return Response.json({ data: Array.from({ length: seen.body.n }, () => ({ b64_json: bytes.toString('base64') })) });
  };
}

test('isAgyQuotaError matches 429, RESOURCE_EXHAUSTED and capacity/quota phrases', () => {
  assert.equal(isAgyQuotaError('agy exited 1: Error: 429 RESOURCE_EXHAUSTED on gemini-3.1-flash-image'), true);
  assert.equal(isAgyQuotaError('agy produced no image: requested output missing and no new brain image found. agy log: E1009 generate_image.go:167] error generating image: failed to generate content: 429 Too Many Requests, body: { "error": { "code": 429, "message": "You have exhausted your capacity on this model. Your quota will reset after 3h0m43s.", "status": "RESOURCE_EXHAUSTED" } }'), true);
  // agy logs unrelated MCP OAuth 429s on normal runs; a bare 429 is not image quota exhaustion
  assert.equal(isAgyQuotaError('agy exited 1: OAuth setup failed for buffer: registration failed with status 429: Error 1015: You are being rate limited'), false);
  assert.equal(isAgyQuotaError('RESOURCE_EXHAUSTED quota exceeded'), true);
  assert.equal(isAgyQuotaError('you have exhausted your capacity, slow down'), true);
  assert.equal(isAgyQuotaError('quota will reset at midnight'), true);
  assert.equal(isAgyQuotaError('fake agy failure tail'), false);
  assert.equal(isAgyQuotaError('agy produced no image'), false);
});

test('parseAgyQuotaReset extracts reset time when present', () => {
  assert.equal(parseAgyQuotaReset('quota will reset at 9:34 PM.'), '9:34 PM');
  assert.equal(parseAgyQuotaReset('try again at 9:34 PM.'), '9:34 PM');
  assert.equal(parseAgyQuotaReset('Your quota will reset after 3h0m43s.'), '3h0m43s');
  assert.equal(parseAgyQuotaReset('nothing here'), null);
});

test('agy requestDescriptor binds a Muse fallback descriptor into the job digest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-desc-'));
  try {
    const refPath = join(dir, 'ref.png');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', refPath]);
    const ref = await importMedia(refPath, dir);
    const p = audioProject();
    p.characterId = 'alex';
    p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });
    const plan = { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, fallbackEstimatedCostUsd: 0.03, parameters: { prompt: 'rev5 sheet prompt' } };
    const req = requestDescriptor(p, plan);
    assert.equal(req.provider, 'agy');
    assert.equal(req.n, 3);
    assert.ok(req.fallback);
    assert.equal(req.fallback.provider, 'meta-muse');
    assert.equal(req.fallback.size, '1536x1152');
    assert.equal(req.fallback.unitCostUsd, 0.01);
    assert.match(req.fallback.endpoint, /images\/edits/);
    // no fallback when absent: old plans still work
    const plain = requestDescriptor(p, { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, parameters: { prompt: 'x' } });
    assert.equal(plain.fallback, undefined);
    assert.throws(() => requestDescriptor(p, { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, fallbackEstimatedCostUsd: 0.01, parameters: { prompt: 'x' } }), /fallback estimate must reserve/);
  } finally { await rm(dir, { recursive: true }); }
});

test('quota on image 2 of 3 keeps agy images and finishes remainder on Muse with same prompt/refs/size', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-mix-'));
  const brain = join(dir, 'brain');
  const bin = await makeFake(dir);
  try {
    const bytes = await pngBytes(dir);
    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: brain, FAKE_AGY_MODE: 'quota-on-2' }, async () => {
      const p = audioProject();
      p.characterId = 'alex';
      const refPath = join(dir, 'ref2.png');
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', refPath]);
      const ref = await importMedia(refPath, dir);
      p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });
      const plan = { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, fallbackEstimatedCostUsd: 0.03, parameters: { prompt: 'fallback prompt' } };
      const req = requestDescriptor(p, plan);
      const job = { id: 'job-fb-1', plan, request: req, dependencies: [], digest: digest({ plan, request: req, dependencies: [] }), key: 'candidates', status: 'submitting', authorization: { message: 't', at: new Date().toISOString() } };
      const seen = { calls: 0 };
      const result = await executeMediaRequest(job, dir, 'isolated-meta-key', fakeMuseFetcher(bytes, seen), false);
      assert.equal(result.files.length, 3);
      assert.equal(result.provider, 'mixed');
      assert.deepEqual(result.imageProviders, [
        { index: 0, provider: 'agy', costUsd: 0 },
        { index: 1, provider: 'agy', costUsd: 0 },
        { index: 2, provider: 'meta-muse', costUsd: 0.01 },
      ]);
      assert.equal(seen.calls, 1);
      assert.equal(seen.body.n, 1);
      assert.equal(seen.body.prompt, 'fallback prompt');
      assert.equal(seen.body.size, '1536x1152');
      assert.equal(seen.body.images.length, 1);
      // fallback receipts are per-index started+receipt and reusable
      const again = await executeMediaRequest(job, dir, '', () => { throw new Error('no second Muse call'); }, true);
      assert.deepEqual(again, result);
      // quota marker proves the agy subrequest produced no image
      const quota = JSON.parse(await readFile(join(dir, 'receipts', 'job-fb-1', '2.quota.json'), 'utf8'));
      assert.match(quota.diagnostic, /429|RESOURCE_EXHAUSTED/);
    });
  } finally { await rm(dir, { recursive: true }); }
});

test('no META_API_KEY gives a clear AGY_QUOTA_EXHAUSTED error with no Muse call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-nokey-'));
  const brain = join(dir, 'brain');
  const bin = await makeFake(dir);
  try {
    const bytes = await pngBytes(dir);
    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: brain, FAKE_AGY_MODE: 'quota-on-0' }, async () => {
      const p = audioProject();
      p.characterId = 'alex';
      const refPath = join(dir, 'r.png');
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', refPath]);
      const ref = await importMedia(refPath, dir);
      p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });
      const plan = { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, fallbackEstimatedCostUsd: 0.03, parameters: { prompt: 'p' } };
      const req = requestDescriptor(p, plan);
      const job = { id: 'job-fb-nokey', plan, request: req, dependencies: [], digest: 'x', key: 'candidates', status: 'submitting', authorization: { message: 't', at: new Date().toISOString() } };
      job.digest = digest({ plan, request: req, dependencies: [] });
      let calls = 0;
      await assert.rejects(executeMediaRequest(job, dir, '', async () => { calls++; return Response.json({}); }, false), /AGY_QUOTA_EXHAUSTED.*no META_API_KEY/);
      assert.equal(calls, 0);
    });
  } finally { await rm(dir, { recursive: true }); }
});

test('non-quota agy error never falls back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-nonquota-'));
  const brain = join(dir, 'brain');
  const bin = await makeFake(dir);
  try {
    const bytes = await pngBytes(dir);
    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: brain, FAKE_AGY_MODE: 'nonzero' }, async () => {
      const p = audioProject();
      p.characterId = 'alex';
      const refPath = join(dir, 'r.png');
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', refPath]);
      const ref = await importMedia(refPath, dir);
      p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });
      const plan = { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, fallbackEstimatedCostUsd: 0.03, parameters: { prompt: 'p' } };
      const req = requestDescriptor(p, plan);
      const job = { id: 'job-fb-nq', plan, request: req, dependencies: [], digest: digest({ plan, request: req, dependencies: [] }), key: 'candidates', status: 'submitting', authorization: { message: 't', at: new Date().toISOString() } };
      let calls = 0;
      await assert.rejects(executeMediaRequest(job, dir, 'k', async () => { calls++; return Response.json({}); }, false), /fake agy failure tail/);
      assert.equal(calls, 0);
    });
  } finally { await rm(dir, { recursive: true }); }
});

test('half-finished quota recovery via collect works; started without quota marker still refuses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-collect-'));
  const brain = join(dir, 'brain');
  const bin = await makeFake(dir);
  try {
    const bytes = await pngBytes(dir);
    // First: quota failure with no key leaves a quota marker but no image.
    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: brain, FAKE_AGY_MODE: 'quota-on-1' }, async () => {
      const p = audioProject();
      p.characterId = 'alex';
      const refPath = join(dir, 'r.png');
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', refPath]);
      const ref = await importMedia(refPath, dir);
      p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });
      const plan = { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, fallbackEstimatedCostUsd: 0.03, parameters: { prompt: 'collect me' } };
      const req = requestDescriptor(p, plan);
      const job = { id: 'job-fb-collect', plan, request: req, dependencies: [], digest: digest({ plan, request: req, dependencies: [] }), key: 'candidates', status: 'submitting', authorization: { message: 't', at: new Date().toISOString() } };
      await assert.rejects(executeMediaRequest(job, dir, '', async () => { throw new Error('must not call Muse without key'); }, false), /AGY_QUOTA_EXHAUSTED/);
      // collect finishes quota-marked indices on Muse, keeping the agy receipt for index 0
      const seen = { calls: 0 };
      const collected = await executeMediaRequest(job, dir, 'isolated-meta-key', fakeMuseFetcher(bytes, seen), true);
      assert.equal(collected.files.length, 3);
      assert.equal(collected.provider, 'mixed');
      assert.equal(seen.body.n, 2);
    });
    // Started without a quota marker still refuses collection.
    {
      const p = audioProject();
      p.characterId = 'alex';
      const refPath = join(dir, 'r2.png');
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', refPath]);
      const ref = await importMedia(refPath, dir);
      p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });
      const plan = { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, fallbackEstimatedCostUsd: 0.03, parameters: { prompt: 'p' } };
      const req = requestDescriptor(p, plan);
      const job = { id: 'job-fb-uncertain', plan, request: req, dependencies: [], digest: digest({ plan, request: req, dependencies: [] }), key: 'candidates', status: 'submitting', authorization: { message: 't', at: new Date().toISOString() } };
      await mkdir(join(dir, 'receipts', 'job-fb-uncertain'), { recursive: true });
      await writeFile(join(dir, 'receipts', 'job-fb-uncertain', '0.started'), JSON.stringify({ jobId: 'job-fb-uncertain' }));
      await assert.rejects(executeMediaRequest(job, dir, 'k', async () => Response.json({ data: [] }), true), /UNCERTAIN_SUBREQUEST/);
    }
  } finally { await rm(dir, { recursive: true }); }
});

async function refProject(dir, name) {
  const p = audioProject();
  p.characterId = 'alex';
  const refPath = join(dir, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', refPath]);
  const ref = await importMedia(refPath, dir);
  p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });
  return p;
}

test('real agy quota (exit 0, 429 RESOURCE_EXHAUSTED only in the agy CLI log) keeps agy images and finishes on Muse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-reallog-'));
  const bin = await makeFake(dir);
  try {
    const bytes = await pngBytes(dir);
    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: join(dir, 'brain'), WIGGLY_AGY_LOG_DIR: join(dir, 'log'), FAKE_AGY_MODE: 'quota-log-on-1' }, async () => {
      const p = await refProject(dir, 'ref.png');
      const plan = { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, fallbackEstimatedCostUsd: 0.03, parameters: { prompt: 'real log prompt' } };
      const req = requestDescriptor(p, plan);
      const job = { id: 'job-fb-log', plan, request: req, dependencies: [], digest: digest({ plan, request: req, dependencies: [] }), key: 'candidates', status: 'submitting', authorization: { message: 't', at: new Date().toISOString() } };
      const seen = { calls: 0 };
      const result = await executeMediaRequest(job, dir, 'isolated-meta-key', fakeMuseFetcher(bytes, seen), false);
      assert.equal(result.provider, 'mixed');
      assert.deepEqual(result.imageProviders.map(x => x.provider), ['agy', 'meta-muse', 'meta-muse']);
      assert.equal(seen.calls, 1);
      assert.equal(seen.body.n, 2);
      assert.equal(seen.body.prompt, 'real log prompt');
      const quota = JSON.parse(await readFile(join(dir, 'receipts', 'job-fb-log', '1.quota.json'), 'utf8'));
      assert.match(quota.diagnostic, /RESOURCE_EXHAUSTED/);
      assert.match(quota.diagnostic, /gemini-3\.1-flash-image/);
      assert.equal(quota.reset, '3h0m43s');
    });
  } finally { await rm(dir, { recursive: true }); }
});

test('a Muse fallback that started without a receipt is never sent again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-once-'));
  const bin = await makeFake(dir);
  try {
    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: join(dir, 'brain'), FAKE_AGY_MODE: 'quota-on-2' }, async () => {
      const p = await refProject(dir, 'ref.png');
      const plan = { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, fallbackEstimatedCostUsd: 0.03, parameters: { prompt: 'once' } };
      const req = requestDescriptor(p, plan);
      const job = { id: 'job-fb-once', plan, request: req, dependencies: [], digest: digest({ plan, request: req, dependencies: [] }), key: 'candidates', status: 'submitting', authorization: { message: 't', at: new Date().toISOString() } };
      let calls = 0;
      // The Muse request leaves without a usable answer (network drop): it may still have been billed.
      await assert.rejects(executeMediaRequest(job, dir, 'isolated-meta-key', async () => { calls++; throw new Error('socket hang up'); }, false), /socket hang up/);
      assert.equal(calls, 1);
      // Neither collect nor generate may repeat it, even though image 2 carries a quota marker.
      await assert.rejects(executeMediaRequest(job, dir, 'isolated-meta-key', async () => { calls++; return Response.json({}); }, true), /UNCERTAIN_SUBREQUEST/);
      await assert.rejects(executeMediaRequest(job, dir, 'isolated-meta-key', async () => { calls++; return Response.json({}); }, false), /UNCERTAIN_SUBREQUEST/);
      assert.equal(calls, 1);
    });
  } finally { await rm(dir, { recursive: true }); }
});
