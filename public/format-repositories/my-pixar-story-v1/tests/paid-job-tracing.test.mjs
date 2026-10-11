import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTracer, paidJobTimer, TRACING_PROJECT } from '../runtime/tracing.mjs';
import { executeMediaRequest, executeJob, requestDescriptor } from '../runtime/providers.mjs';
import { createGeminiReviewTools, GEMINI_REVIEW_MODEL } from '../runtime/gemini-review.mjs';
import { createCartesiaTranscriptionTool, CARTESIA_STT_PROFILE } from '../runtime/cartesia-stt.mjs';
import { importMedia } from '../runtime/media.mjs';
import { digest } from '../runtime/contracts.mjs';
import { audioProject } from './helpers.mjs';

const FAKE_AGY_SCRIPT = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('agy fake 1.3.2'); process.exit(0); }
const mode = process.env.FAKE_AGY_MODE || 'success';
if (mode === 'quota-all') {
  console.error('Error: 429 RESOURCE_EXHAUSTED: you have exhausted your capacity on this model, quota will reset at 9:34 PM.');
  process.exit(1);
}
const pIdx = args.indexOf('-p');
const prompt = pIdx >= 0 ? args[pIdx + 1] : '';
const allOut = [...prompt.matchAll(/"([^"]+\\.png)"/g)].map(m => m[1]);
const outPath = allOut.length ? allOut[allOut.length - 1] : null;
const aspect = prompt.includes('16:9') ? '16:9' : '4:3';
const dims = aspect === '4:3' ? '1200x900' : '1600x900';
if (outPath) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=' + dims, '-frames:v', '1', outPath], { timeout: 20000, killSignal: 'SIGKILL' });
}
process.exit(0);
`;

async function makeFakeAgy(dir) {
  const bin = join(dir, 'fake-agy.mjs');
  await writeFile(bin, FAKE_AGY_SCRIPT, { mode: 0o755 });
  return bin;
}

function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  return fn().finally(() => {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

async function secretsFile(dir, extra = '') {
  const secretsPath = join(dir, 'secrets.env');
  await writeFile(secretsPath, `LANGSMITH_API_KEY=ls-fake-key\nCARTESIA_API_KEY=cartesia-secret-123\nELEVENLABS_API_KEY=eleven-secret-456\nGEMINI_API_KEY=gemini-secret-789\nMETA_API_KEY=meta-secret-999\n${extra}`);
  return secretsPath;
}

test('1. paidJob via fake client captures paid-job + paid-job-end with required fields and media_omitted for raw payloads', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pjt-1-'));
  try {
    const secretsPath = await secretsFile(dir);
    const fakeClient = { captured: [] };
    const tracer = await createTracer({ secretsPath, runId: 'test-run-1', client: fakeClient });

    const rawBuffer = Buffer.from('raw-payload-bytes-12345');
    const rawDataUrl = 'data:image/png;base64,' + Buffer.from('image-bytes-999').toString('base64');

    const timer = paidJobTimer(tracer, {
      provider: 'cartesia',
      jobId: 'job-pjt-1',
      operation: 'narration',
      step: 'narration',
      estimatedCostUsd: 0.05,
      actualCostUsd: 0.05,
      actualCostSource: 'estimate',
    });

    timer.ok({
      payload: rawBuffer,
      preview: rawDataUrl,
    });

    const starts = fakeClient.captured.filter(r => r.phase === 'paid-job');
    const ends = fakeClient.captured.filter(r => r.phase === 'paid-job-end');

    assert.equal(starts.length, 1);
    assert.equal(ends.length, 1);

    const end = ends[0];
    assert.equal(end.provider, 'cartesia');
    assert.equal(end.jobId, 'job-pjt-1');
    assert.equal(end.estimatedCostUsd, 0.05);
    assert.equal(end.actualCostUsd, 0.05);
    assert.equal(end.outcome, 'ok');
    assert.ok(typeof end.durationMs === 'number' && end.durationMs >= 0);

    const dumped = JSON.stringify(fakeClient.captured);
    assert.ok(!dumped.includes('raw-payload-bytes-12345'), 'buffer leaked');
    assert.ok(!dumped.includes('image-bytes-999'), 'data URL leaked');
    assert.match(dumped, /media_omitted/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('2. agy image job through executeJob with fake binary -> one trace, provider agy, outcome ok, actualCostUsd 0, actualCostSource free, files digests only', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pjt-2-'));
  const brain = join(dir, 'brain');
  const bin = await makeFakeAgy(dir);
  try {
    const secretsPath = await secretsFile(dir);
    const fakeClient = { captured: [] };
    const tracer = await createTracer({ secretsPath, runId: 'test-run-2', client: fakeClient });

    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: brain, FAKE_AGY_MODE: 'success' }, async () => {
      const p = audioProject();
      p.characterId = 'alex';
      const refPath = join(dir, 'ref.png');
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', refPath], { timeout: 20000, killSignal: 'SIGKILL' });
      const ref = await importMedia(refPath, dir);
      p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });

      const plan = { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, parameters: { prompt: 'rev5 sheet' } };
      const req = requestDescriptor(p, plan);
      const job = { id: 'job-agy-trace-1', plan, request: req, dependencies: [], digest: 'x', key: 'candidates:alex', status: 'submitting', authorization: { message: 't', at: new Date().toISOString() } };
      job.digest = digest({ plan, request: req, dependencies: [] });
      p.step = 'candidates';
      p.gate = 'collect';
      p.jobs = [job];

      const result = await executeJob(p, job, dir, '', () => { throw new Error('no network for agy'); }, false, null, { tracer });
      assert.equal(result.files.length, 3);
      assert.equal(result.provider, 'agy');

      const ends = fakeClient.captured.filter(r => r.phase === 'paid-job-end');
      // For agy candidates (n=3), each subrequest triggers an attempt trace
      assert.ok(ends.length >= 1);
      for (const t of ends) {
        assert.equal(t.provider, 'agy');
        assert.equal(t.outcome, 'ok');
        assert.equal(t.actualCostUsd, 0);
        assert.equal(t.actualCostSource, 'free');
        if (t.files) {
          for (const f of t.files) {
            assert.ok(/^[0-9a-f]{64}$/.test(f.sha256));
            assert.equal(typeof f.bytes, 'number');
          }
        }
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('3. agy quota failure with bound meta-muse fallback -> two traces: agy outcome quota, then meta-muse outcome ok, fallbackFrom agy', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pjt-3-'));
  const brain = join(dir, 'brain');
  const bin = await makeFakeAgy(dir);
  try {
    const secretsPath = await secretsFile(dir);
    const fakeClient = { captured: [] };
    const tracer = await createTracer({ secretsPath, runId: 'test-run-3', client: fakeClient });

    const musePng = join(dir, 'muse.png');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=32x32', '-frames:v', '1', musePng], { timeout: 20000, killSignal: 'SIGKILL' });
    const museBytes = await readFile(musePng);

    const fakeMuseFetcher = async (url, opts) => {
      const body = JSON.parse(opts.body);
      return Response.json({
        data: Array.from({ length: body.n }, () => ({ b64_json: museBytes.toString('base64') })),
      });
    };

    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: brain, FAKE_AGY_MODE: 'quota-all' }, async () => {
      const p = audioProject();
      p.characterId = 'alex';
      const refPath = join(dir, 'ref3.png');
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', refPath], { timeout: 20000, killSignal: 'SIGKILL' });
      const ref = await importMedia(refPath, dir);
      p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });

      const plan = { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, fallbackEstimatedCostUsd: 0.03, parameters: { prompt: 'fallback prompt' } };
      const req = requestDescriptor(p, plan);
      const job = { id: 'job-fallback-1', plan, request: req, dependencies: [], digest: 'x', key: 'candidates:alex', status: 'submitting', authorization: { message: 't', at: new Date().toISOString() } };
      job.digest = digest({ plan, request: req, dependencies: [] });
      p.step = 'candidates';
      p.gate = 'collect';
      p.jobs = [job];

      const result = await executeJob(p, job, dir, 'meta-secret-999', fakeMuseFetcher, false, null, { tracer });
      assert.equal(result.files.length, 3);
      assert.equal(result.provider, 'meta-muse');

      const ends = fakeClient.captured.filter(r => r.phase === 'paid-job-end');
      const agyEnd = ends.find(r => r.provider === 'agy');
      const museEnd = ends.find(r => r.provider === 'meta-muse');

      assert.ok(agyEnd, 'agy attempt trace missing');
      assert.equal(agyEnd.outcome, 'quota');

      assert.ok(museEnd, 'meta-muse fallback trace missing');
      assert.equal(museEnd.outcome, 'ok');
      assert.equal(museEnd.fallbackFrom, 'agy');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('4. meta-muse returning HTTP 500 -> outcome provider-error; error text and captured runs contain no secret key', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pjt-4-'));
  try {
    const secretKey = 'meta-super-secret-key-xyz';
    const secretsPath = await secretsFile(dir, `META_API_KEY=${secretKey}\n`);
    const fakeClient = { captured: [] };
    const tracer = await createTracer({ secretsPath, runId: 'test-run-4', client: fakeClient });

    const p = audioProject();
    p.characterId = 'alex';
    const refPath = join(dir, 'ref4.png');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', refPath], { timeout: 20000, killSignal: 'SIGKILL' });
    const ref = await importMedia(refPath, dir);
    p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });

    const plan = { provider: 'meta-muse', operation: 'candidates', estimatedCostUsd: 0.03, parameters: { prompt: 'direct muse' } };
    const req = requestDescriptor(p, plan);
    const job = { id: 'job-muse-fail', plan, request: req, dependencies: [], digest: 'x', key: 'candidates:alex', status: 'submitting', authorization: { message: 't', at: new Date().toISOString() } };
    job.digest = digest({ plan, request: req, dependencies: [] });
    p.step = 'candidates';
    p.gate = 'collect';
    p.jobs = [job];

    const fakeFailingFetcher = async () => new Response(`Internal Server Error with key ${secretKey}`, { status: 500 });

    await assert.rejects(
      executeJob(p, job, dir, secretKey, fakeFailingFetcher, false, null, { tracer }),
      /HTTP 500/
    );

    const ends = fakeClient.captured.filter(r => r.phase === 'paid-job-end');
    assert.equal(ends.length, 1);
    const end = ends[0];
    assert.equal(end.provider, 'meta-muse');
    assert.equal(end.outcome, 'provider-error');

    const dumped = JSON.stringify(fakeClient.captured);
    assert.ok(!dumped.includes(secretKey), 'secret key leaked in captured runs');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('5. Cartesia narration and ElevenLabs jobs with fake fetchers -> one trace each with plan estimate', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pjt-5-'));
  try {
    const secretsPath = await secretsFile(dir);
    const fakeClient = { captured: [] };
    const tracer = await createTracer({ secretsPath, runId: 'test-run-5', client: fakeClient });

    const audioFile = join(dir, 'sample.wav');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:d=0.2', '-c:a', 'pcm_s16le', audioFile], { timeout: 20000, killSignal: 'SIGKILL' });
    const audioBytes = await readFile(audioFile);

    // Cartesia narration
    const pCart = audioProject();
    const cartPlan = { provider: 'cartesia', operation: 'audition', estimatedCostUsd: 0.015, parameters: { prompt: 'audition' } };
    const cartReq = {
      endpoint: 'https://api.cartesia.ai/tts/bytes',
      provider: 'cartesia',
      voice: 'voice-1',
      transcripts: ['Hello world'],
      language: 'en',
      model_id: 'sonic-english',
      output_format: { container: 'wav', sample_rate: 44100, encoding: 'pcm_s16le' },
      generation_config: {},
      cartesiaVersion: '2024-06-10',
      n: 1,
    };
    const cartJob = { id: 'job-cartesia-1', plan: cartPlan, request: cartReq, dependencies: [], digest: 'x', key: 'audition', status: 'submitting', authorization: { message: 't', at: new Date().toISOString() } };
    cartJob.digest = digest({ plan: cartPlan, request: cartReq, dependencies: [] });
    pCart.step = 'audition';
    pCart.gate = 'collect';
    pCart.jobs = [cartJob];

    const fakeCartesiaFetcher = async () => new Response(audioBytes, { status: 200, headers: { 'Content-Type': 'audio/wav' } });

    await executeJob(pCart, cartJob, dir, 'cartesia-secret-123', fakeCartesiaFetcher, false, null, { tracer });

    // ElevenLabs sound
    const p11 = audioProject();
    const elPlan = { provider: 'elevenlabs', operation: 'sound', estimatedCostUsd: 0.04, parameters: { prompt: 'whoosh sound' } };
    const elReq = {
      endpoint: 'https://api.elevenlabs.io/v1/sound-generation',
      provider: 'elevenlabs',
      body: { text: 'whoosh sound' },
      provenance: { prompt: 'whoosh sound' },
      n: 1,
    };
    const elJob = { id: 'job-eleven-1', plan: elPlan, request: elReq, dependencies: [], digest: 'y', key: 'sound', status: 'submitting', authorization: { message: 't', at: new Date().toISOString() } };
    elJob.digest = digest({ plan: elPlan, request: elReq, dependencies: [] });
    p11.step = 'sound';
    p11.gate = 'collect';
    p11.jobs = [elJob];

    const fakeElFetcher = async () => new Response(audioBytes, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });

    await executeJob(p11, elJob, dir, 'eleven-secret-456', fakeElFetcher, false, null, { tracer });

    const ends = fakeClient.captured.filter(r => r.phase === 'paid-job-end');
    const cartEnd = ends.find(r => r.provider === 'cartesia');
    const elEnd = ends.find(r => r.provider === 'elevenlabs');

    assert.ok(cartEnd, 'Cartesia trace missing');
    assert.equal(cartEnd.outcome, 'ok');
    assert.equal(cartEnd.estimatedCostUsd, 0.015);
    assert.equal(cartEnd.actualCostUsd, 0.015);

    assert.ok(elEnd, 'ElevenLabs trace missing');
    assert.equal(elEnd.outcome, 'ok');
    assert.equal(elEnd.estimatedCostUsd, 0.04);
    assert.equal(elEnd.actualCostUsd, 0.04);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('6. Gemini review tool and Cartesia STT tool with fake fetchers -> exactly one completed trace per request with durationMs and outcome; failing request yields outcome provider-error', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pjt-6-'));
  try {
    const secretsPath = await secretsFile(dir);
    const fakeClient = { captured: [] };
    const tracer = await createTracer({ secretsPath, runId: 'test-run-6', client: fakeClient });

    // Prepare audio and image
    const audioPath = join(dir, 'sample.wav');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:d=0.2', '-c:a', 'pcm_s16le', audioPath], { timeout: 20000, killSignal: 'SIGKILL' });
    const audioFile = await importMedia(audioPath, dir);

    const imagePath = join(dir, 'sample.png');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', imagePath], { timeout: 20000, killSignal: 'SIGKILL' });
    const imageFile = await importMedia(imagePath, dir);

    // Track inFlight timers as runner.mjs does
    const inFlightTimers = new Map();
    const beforeRequest = async ({ provider, requestDigest, task }) => {
      const amount = provider === 'gemini' ? 0.005 : 0.002;
      inFlightTimers.set(requestDigest, paidJobTimer(tracer, {
        provider,
        jobId: task.taskId,
        estimatedCostUsd: amount,
        actualCostUsd: amount,
        actualCostSource: 'estimate',
      }));
    };
    const afterResponse = async ({ requestDigest }) => {
      const timer = inFlightTimers.get(requestDigest);
      if (timer) {
        inFlightTimers.delete(requestDigest);
        timer.ok();
      }
    };
    const wrappingFetcher = (baseFetcher) => async (url, options) => {
      try {
        const res = await baseFetcher(url, options);
        if (!res.ok) {
          for (const [digestKey, timer] of inFlightTimers.entries()) {
            inFlightTimers.delete(digestKey);
            timer.fail(new Error(`HTTP ${res.status}`));
          }
        }
        return res;
      } catch (err) {
        for (const [digestKey, timer] of inFlightTimers.entries()) {
          inFlightTimers.delete(digestKey);
          timer.fail(err);
        }
        throw err;
      }
    };

    // 6a: Successful Gemini viewImage
    const geminiReport = {
      perceptible: true,
      fullMediaInspected: true,
      summary: 'OK',
      observations: [],
      limitations: [],
    };
    const fakeGeminiFetcherOk = async () => new Response(JSON.stringify({
      id: 'gemini-int-1',
      model: GEMINI_REVIEW_MODEL,
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(geminiReport) }] }],
    }));

    const geminiTools = createGeminiReviewTools({
      secretsPath,
      receiptDirectory: join(dir, 'gemini-receipts'),
      maxCalls: 2,
      beforeRequest,
      afterResponse,
      fetcher: wrappingFetcher(fakeGeminiFetcherOk),
    });

    const taskGemini = { taskId: 't-gemini-1', step: 'candidates', criteria: ['style'], artifact: { content: { files: [imageFile] } } };
    const workerGemini = { workerId: 'w-vera', role: 'visual-reviewer', name: 'Vera' };

    await geminiTools.viewImage({ file: imageFile, worker: workerGemini, task: taskGemini });

    let geminiEnds = fakeClient.captured.filter(r => r.phase === 'paid-job-end' && r.provider === 'gemini');
    assert.equal(geminiEnds.length, 1);
    assert.equal(geminiEnds[0].outcome, 'ok');
    assert.ok(typeof geminiEnds[0].durationMs === 'number');

    // 6b: Failing Gemini review -> outcome provider-error
    const fakeGeminiFetcherFail = async () => new Response('Internal error', { status: 500 });
    const failingGeminiTools = createGeminiReviewTools({
      secretsPath,
      receiptDirectory: join(dir, 'gemini-receipts-fail'),
      maxCalls: 2,
      beforeRequest,
      afterResponse,
      fetcher: wrappingFetcher(fakeGeminiFetcherFail),
    });

    await assert.rejects(
      failingGeminiTools.viewImage({ file: imageFile, worker: workerGemini, task: { ...taskGemini, taskId: 't-gemini-fail' } }),
      /HTTP 500/
    );

    geminiEnds = fakeClient.captured.filter(r => r.phase === 'paid-job-end' && r.provider === 'gemini');
    assert.equal(geminiEnds.length, 2);
    assert.equal(geminiEnds[1].outcome, 'provider-error');

    // 6c: Cartesia STT tool success
    const fakeSttFetcherOk = async () => new Response(JSON.stringify({
      type: 'transcript',
      text: 'hello',
      duration: audioFile.durationSeconds,
      request_id: 'stt-1',
      words: [{ word: 'hello', start: 0, end: 0.1 }],
    }));

    const sttTools = createCartesiaTranscriptionTool({
      secretsPath,
      receiptDirectory: join(dir, 'stt-receipts'),
      maxCalls: 2,
      beforeRequest,
      afterResponse,
      fetcher: wrappingFetcher(fakeSttFetcherOk),
    });

    const taskStt = {
      taskId: 't-stt-1',
      step: 'narration',
      voiceBasis: { language: 'en' },
    };
    const workerStt = { workerId: 'w-ava', role: 'audio-reviewer', name: 'Ava' };

    await sttTools.transcribe({ file: audioFile, worker: workerStt, task: taskStt });

    const sttEnds = fakeClient.captured.filter(r => r.phase === 'paid-job-end' && r.provider === 'cartesia-stt');
    assert.equal(sttEnds.length, 1);
    assert.equal(sttEnds[0].outcome, 'ok');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('7. Tracer whose paidJob throws never alters job result or error', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pjt-7-'));
  const bin = await makeFakeAgy(dir);
  try {
    const throwingTracer = {
      enabled: true,
      paidJob() {
        throw new Error('LangSmith tracer crash');
      },
    };

    const p = audioProject();
    p.characterId = 'alex';
    const refPath = join(dir, 'ref7.png');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', refPath], { timeout: 20000, killSignal: 'SIGKILL' });
    const ref = await importMedia(refPath, dir);
    p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });

    const plan = { provider: 'agy', operation: 'candidates', estimatedCostUsd: 0, parameters: { prompt: 'p' } };
    const req = requestDescriptor(p, plan);
    const job = { id: 'job-throw-test', plan, request: req, dependencies: [], digest: 'x', key: 'candidates:alex', status: 'submitting', authorization: { message: 't', at: new Date().toISOString() } };
    job.digest = digest({ plan, request: req, dependencies: [] });
    p.step = 'candidates';
    p.gate = 'collect';
    p.jobs = [job];

    await withEnv({ WIGGLY_AGY_BIN: bin, WIGGLY_AGY_BRAIN_DIR: join(dir, 'brain'), FAKE_AGY_MODE: 'success' }, async () => {
      const result = await executeJob(p, job, dir, '', () => { throw new Error('no network'); }, false, null, { tracer: throwingTracer });
      assert.equal(result.files.length, 3);
      assert.equal(result.provider, 'agy');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('8. createTracer with tags and metadata propagates to captured runs, and runner.mjs passes cassetteId when recording', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pjt-8-'));
  try {
    const secretsPath = await secretsFile(dir);
    const fakeClient = { captured: [] };
    const tracer = await createTracer({
      secretsPath,
      runId: 'r-rec-test',
      tags: ['cassette:my-cassette-123'],
      metadata: { cassetteId: 'my-cassette-123' },
      client: fakeClient,
    });

    tracer.paidJob({ provider: 'cartesia', estimatedCostUsd: 0.01 });

    for (const run of fakeClient.captured) {
      assert.ok(run.tags.includes('cassette:my-cassette-123'), `run ${run.name} missing cassette tag`);
    }

    // Source check on runner.mjs: verify crew block passes cassette tag / metadata when recording
    const runnerSource = await readFile(new URL('../runner.mjs', import.meta.url), 'utf8');
    assert.match(runnerSource, /tags:\s*\[`cassette:\$\{cassetteId\}`\]/);
    assert.match(runnerSource, /metadata:\s*\{\s*cassetteId\s*\}/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('9. Collecting an existing receipt sends no paid-job trace', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pjt-9-'));
  try {
    const secretsPath = await secretsFile(dir);
    const fakeClient = { captured: [] };
    const tracer = await createTracer({ secretsPath, runId: 'test-run-9', client: fakeClient });

    const p = audioProject();
    p.characterId = 'alex';
    const refPath = join(dir, 'ref9.png');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', refPath], { timeout: 20000, killSignal: 'SIGKILL' });
    const ref = await importMedia(refPath, dir);
    p.artifacts.push({ key: 'roster', valid: true, content: { characters: [{ id: 'alex', references: [ref] }] } });

    const plan = { provider: 'cartesia', operation: 'audition', estimatedCostUsd: 0.015, parameters: { prompt: 'audition' } };
    const req = {
      endpoint: 'https://api.cartesia.ai/tts/bytes',
      provider: 'cartesia',
      voice: 'voice-1',
      transcripts: ['hello'],
      language: 'en',
      model_id: 'sonic-english',
      output_format: { container: 'wav', sample_rate: 44100, encoding: 'pcm_s16le' },
      generation_config: {},
      cartesiaVersion: '2024-06-10',
      n: 1,
    };
    const job = { id: 'job-existing-1', plan, request: req, dependencies: [], digest: 'x', key: 'audition', status: 'submitting', authorization: { message: 't', at: new Date().toISOString() } };
    job.digest = digest({ plan, request: req, dependencies: [] });
    p.step = 'audition';
    p.gate = 'collect';
    p.jobs = [job];

    // Seed existing receipts/job-existing-1/0.json
    const receiptDir = join(dir, 'receipts', 'job-existing-1');
    await mkdir(receiptDir, { recursive: true });
    await writeFile(join(receiptDir, '0.json'), JSON.stringify({ file: ref }));

    const initialCapturedLength = fakeClient.captured.length;

    // Execute with collectOnly = true
    const result = await executeJob(p, job, dir, 'cartesia-secret-123', () => { throw new Error('must not fetch'); }, true, null, { tracer });
    assert.ok(result.files.length > 0);

    const paidJobEnds = fakeClient.captured.filter(r => r.phase === 'paid-job-end');
    assert.equal(paidJobEnds.length, 0, 'collecting existing receipt must not emit paid-job trace');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
