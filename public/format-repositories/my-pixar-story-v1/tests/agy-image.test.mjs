import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateAgyImage, verifyAgyImage, buildAgyPrompt } from '../runtime/agy-image.mjs';
import { requestDescriptor, loadKey, checkProvider, executeMediaRequest } from '../runtime/providers.mjs';
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
if (mode === 'nonzero') { console.error('fake agy failure tail'); process.exit(1); }
if (mode === 'hang') { await new Promise(r => setTimeout(r, 8000)); process.exit(0); }
const pIdx = args.indexOf('-p');
const prompt = pIdx >= 0 ? args[pIdx + 1] : '';
const addIdx = args.indexOf('--add-dir');
const countPath = process.env.FAKE_AGY_COUNT_PATH;
if (countPath) fs.appendFileSync(countPath, '1\\n');
const allOut = [...prompt.matchAll(/"([^\"]+\.png)"/g)].map(m=>m[1]);
const outMatch = allOut.length ? [allOut[allOut.length-1], allOut[allOut.length-1]] : null;
const outPath = outMatch ? outMatch[1] : null;
const aspect = prompt.includes('16:9') ? '16:9' : '4:3';
const nameMatch = prompt.match(/ImageName[^"]*"([^"]+)"/) || prompt.match(/"([^"]*job[^"]*)"/);
const imageName = nameMatch ? nameMatch[1] : 'out';
const brainDir = process.env.WIGGLY_AGY_BRAIN_DIR || '';
const dims = mode === 'wrong-aspect' ? (aspect === '4:3' ? '1600x900' : '1200x900') : (aspect === '4:3' ? '1200x900' : '1600x900');
if (mode === 'no-image') process.exit(0);
const mk = (dest) => { execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s='+dims,'-frames:v','1',dest]); };
if (mode === 'brain-only') {
  const dest = brainDir + '/fake-uuid-' + Date.now() + '-' + imageName + '.png';
  fs.mkdirSync(brainDir + '/fake-uuid-' + Date.now(), { recursive: true });
  // write into a stable subdir for walk
  const { join } = await import('node:path');
  const dir = process.env.WIGGLY_AGY_BRAIN_DIR + '/fallback-' + process.pid;
  fs.mkdirSync(dir, { recursive: true });
  mk(dir + '/' + imageName + '.png');
  process.exit(0);
}
if (mode === 'real-shape') {
  // Shape observed from the real agy 1.3.2: a JPEG named <ImageName with '_'>_<ms>.jpg in a
  // brain conversation dir, plus the same bytes copied to the requested (.png) path.
  const dir = process.env.WIGGLY_AGY_BRAIN_DIR + '/conv-' + process.pid;
  fs.mkdirSync(dir, { recursive: true });
  const brainFile = dir + '/' + imageName.replace(/[^A-Za-z0-9]+/g, '_') + '_' + Date.now() + '.jpg';
  execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=red:s=1200x896','-frames:v','1',brainFile]);
  // An unrelated newer brain image from another conversation must never be deleted.
  fs.writeFileSync(dir + '/someone_else_' + Date.now() + '.png', 'not ours');
  if (outPath) fs.copyFileSync(brainFile, outPath);
  process.exit(0);
}
if (outPath) { mk(outPath); }
// also leave a brain copy for output-path mode when requested
if (process.env.FAKE_AGY_ALSO_BRAIN === '1' && outPath) {
  const dir = process.env.WIGGLY_AGY_BRAIN_DIR + '/fallback-' + process.pid;
  fs.mkdirSync(dir, { recursive: true });
  mk(dir + '/' + imageName + '.png');
}
process.exit(0);
`;

async function makeFake(dir, brainDir) {
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

test('agy prompt instructs generate_image with Prompt/AspectRatio/ImageName/ImagePaths and explicit output path', () => {
  const s = buildAgyPrompt({ prompt: 'sheet prompt', aspectRatio: '4:3', imageName: 'job-1-0', imagePaths: ['/a.png'], outputPath: '/tmp/out.png' });
  assert.match(s, /generate_image/);
  assert.match(s, /4:3/);
  assert.match(s, /job-1-0/);
  assert.match(s, /\/a\.png/);
  assert.match(s, /\/tmp\/out\.png/);
});

test('agy success via requested output path imports with correct sha and deletes nothing outside brain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-out-'));
  const brain = join(dir, 'brain');
  const bin = await makeFake(dir, brain);
  try {
    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: brain, FAKE_AGY_MODE: 'success' }, async () => {
      const out = join(dir, 'wanted.png');
      const { outputPath } = await generateAgyImage({ prompt: 'p', aspectRatio: '4:3', imageName: 'job-1-0', imagePaths: [], outputPath: out });
      assert.equal(outputPath, resolve(out));
      const buf = await readFile(out);
      const v = verifyAgyImage(buf, '4:3');
      assert.equal(v.width, 1200); assert.equal(v.height, 900);
    });
  } finally { await rm(dir, { recursive: true }); }
});

test('agy brain fallback copies newest post-start image, verifies, and deletes only that brain copy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-brain-'));
  const brain = join(dir, 'brain');
  const bin = await makeFake(dir, brain);
  try {
    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: brain, FAKE_AGY_MODE: 'brain-only' }, async () => {
      const out = join(dir, 'wanted.png');
      const { outputPath, brainCleaned } = await generateAgyImage({ prompt: 'p 4:3', aspectRatio: '4:3', imageName: 'myjob-2', imagePaths: [], outputPath: out });
      assert.equal(outputPath, resolve(out));
      assert.ok(brainCleaned);
      try { await stat(brainCleaned); assert.fail('brain copy should be deleted'); } catch (e) { assert.equal(e.code, 'ENOENT'); }
      const buf = await readFile(out);
      verifyAgyImage(buf, '4:3');
    });
  } finally { await rm(dir, { recursive: true }); }
});

test('agy rejects wrong aspect, missing image, non-zero exit and timeout without retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-fail-'));
  const brain = join(dir, 'brain');
  const bin = await makeFake(dir, brain);
  try {
    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: brain, FAKE_AGY_MODE: 'wrong-aspect' }, async () => {
      await assert.rejects(generateAgyImage({ prompt: 'p 4:3', aspectRatio: '4:3', imageName: 'x', imagePaths: [], outputPath: join(dir, 'a.png') }), /aspect.*>5%/);
    });
    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: brain, FAKE_AGY_MODE: 'no-image' }, async () => {
      await assert.rejects(generateAgyImage({ prompt: 'p', aspectRatio: '4:3', imageName: 'x', imagePaths: [], outputPath: join(dir, 'b.png') }), /no image/);
    });
    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: brain, FAKE_AGY_MODE: 'nonzero' }, async () => {
      await assert.rejects(generateAgyImage({ prompt: 'p', aspectRatio: '4:3', imageName: 'x', imagePaths: [], outputPath: join(dir, 'c.png') }), /exited 1.*fake agy failure tail/);
    });
    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: brain, FAKE_AGY_MODE: 'hang', WIGGLY_AGY_TIMEOUT_MS: '400' }, async () => {
      await assert.rejects(generateAgyImage({ prompt: 'p', aspectRatio: '4:3', imageName: 'x', imagePaths: [], outputPath: join(dir, 'd.png'), timeoutMs: 400 }), /timed out/);
    });
    await withEnv({ WIGGLY_AGY_BIN: '/nonexistent-agy-binary-xyz' }, async () => {
      await assert.rejects(generateAgyImage({ prompt: 'p', aspectRatio: '4:3', imageName: 'x', imagePaths: [], outputPath: join(dir, 'e.png') }), /not found/);
    });
  } finally { await rm(dir, { recursive: true }); }
});

test('agy requestDescriptor uses 4:3/16:9, costs $0, and executeMediaRequest keeps durable per-index receipts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-job-'));
  const brain = join(dir, 'brain');
  const bin = await makeFake(dir, brain);
  const countPath = join(dir, 'count.txt');
  await writeFile(countPath, '');
  try {
    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: brain, FAKE_AGY_MODE: 'success', FAKE_AGY_COUNT_PATH: countPath }, async () => {
      const p = audioProject();
      p.characterId = 'alex';
      const refPath = join(dir, 'ref.png');
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', refPath]);
      const ref = await importMedia(refPath, dir);
      p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });
      const plan = { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, parameters: { prompt: 'rev5 sheet prompt' } };
      const req = requestDescriptor(p, plan);
      assert.equal(req.aspectRatio, '4:3');
      assert.equal(req.n, 3);
      assert.equal(req.provider, 'agy');
      const job = { id: 'job-agy-1', plan, request: req, dependencies: [], digest: 'x', key: 'candidates', status: 'submitting', authorization: { message: 't', at: new Date().toISOString() } };
      job.digest = digest({ plan, request: req, dependencies: [] });
      p.step = 'candidates'; p.gate = 'collect'; p.jobs = [job];
      const result = await executeMediaRequest(job, dir, '', () => { throw new Error('no network for agy'); }, false);
      assert.equal(result.files.length, 3);
      assert.equal(result.provider, 'agy');
      for (const f of result.files) { assert.equal(f.width, 1200); assert.equal(f.height, 900); }
      const calls = (await readFile(countPath, 'utf8')).trim().split('\n').filter(Boolean).length;
      assert.equal(calls, 3);
      // second execution reuses receipts, no new agy calls; uncertain marker blocks duplicates
      const again = await executeMediaRequest(job, dir, '', () => { throw new Error('no network'); }, true);
      assert.deepEqual(again, result);
      const calls2 = (await readFile(countPath, 'utf8')).trim().split('\n').filter(Boolean).length;
      assert.equal(calls2, 3);
      // started marker without receipt blocks resubmit
      const p2 = audioProject(); p2.characterId = 'alex';
      p2.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });
      const job2 = { id: 'job-agy-2', plan, request: req, dependencies: [], digest: digest({ plan, request: req, dependencies: [] }), key: 'candidates', status: 'submitting', authorization: { message: 't', at: new Date().toISOString() } };
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(dir, 'receipts', 'job-agy-2'), { recursive: true });
      await writeFile(join(dir, 'receipts', 'job-agy-2', '0.started'), JSON.stringify({ jobId: 'job-agy-2' }));
      await assert.rejects(executeMediaRequest(job2, dir, '', () => { throw new Error('no network'); }, false), /UNCERTAIN_SUBREQUEST/);
    });
    await assert.rejects(loadKey('agy', join(dir, 'secrets')), /no API key/);
    const ok = await withEnv({ WIGGLY_AGY_BIN: bin }, async () => checkProvider('agy', join(dir, 'secrets'), fetch, (b, a) => ({ status: 0, stdout: 'agy 1.3.2', stderr: '' })));
    assert.equal(ok.provider, 'agy');
  } finally { await rm(dir, { recursive: true }); }
});

test('meta-muse keeps 4:3 size mapping and 16:9 for backgrounds/keyframes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-sizes-'));
  try {
    const refPath = join(dir, 'ref.png');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', refPath]);
    const ref = await importMedia(refPath, dir);
    const p = audioProject(); p.characterId = 'alex';
    p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });
    const cand = requestDescriptor(p, { provider: 'meta-muse', operation: 'candidates', estimatedCostUsd: 0.03, parameters: { prompt: 'x' } });
    assert.equal(cand.aspectRatio, '4:3'); assert.equal(cand.size, '1536x1152'); assert.equal(cand.n, 3);
    const { readyForMaster } = await import('./background-helpers.mjs');
    const { current } = await import('../runtime/workflow.mjs');
    const b = readyForMaster();
    const master = requestDescriptor(b, { provider: 'meta-muse', operation: b.step, estimatedCostUsd: 0.03, parameters: { prompt: current(b, 'backgroundPrompt:home').content.prompt } });
    assert.equal(master.aspectRatio, '16:9'); assert.equal(master.size, '1536x864');
    const agyMaster = requestDescriptor(b, { provider: 'agy', operation: b.step, estimatedCostUsd: 0, parameters: { prompt: current(b, 'backgroundPrompt:home').content.prompt } });
    assert.equal(agyMaster.aspectRatio, '16:9');
  } finally { await rm(dir, { recursive: true }); }
});

test('real agy shape: JPEG bytes at a .png path are renamed .jpg and only the named brain copy is deleted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-real-shape-'));
  const brain = join(dir, 'brain');
  const bin = await makeFake(dir, brain);
  try {
    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: brain, FAKE_AGY_MODE: 'real-shape' }, async () => {
      const out = join(dir, 'job-7-0.png');
      const { outputPath, brainCleaned } = await generateAgyImage({ prompt: 'p', aspectRatio: '4:3', imageName: 'job-7-0', imagePaths: [], outputPath: out });
      assert.equal(outputPath, resolve(join(dir, 'job-7-0.jpg')));
      assert.equal(verifyAgyImage(await readFile(outputPath), '4:3').format, 'jpeg');
      await assert.rejects(stat(out), /ENOENT/);
      assert.match(brainCleaned, /job_7_0_\d+\.jpg$/);
      await assert.rejects(stat(brainCleaned), /ENOENT/);
      const { readdirSync } = await import('node:fs');
      const left = readdirSync(join(brain, readdirSync(brain)[0]));
      assert.deepEqual(left.filter(n => n.startsWith('someone_else_')).length, 1);
    });
  } finally { await rm(dir, { recursive: true }); }
});
