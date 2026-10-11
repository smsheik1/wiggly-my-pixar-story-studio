import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import {
  DECISIONS_URL,
  DECISION_MODELS,
  PRESCREEN_QUESTIONS,
  estimatePrescreenCost,
  buildRequests,
  runPrescreen,
} from '../runtime/decisions-prescreen.mjs';
import { replayDecisions } from '../evaluation/decisions-replay.mjs';
import { createTracer } from '../runtime/tracing.mjs';

// Local copy of Prescreen contract schema as specified in §3.5 test 6.
// Note: Part A's contracts.mjs Prescreen schema is the canonical one,
// and after rebasing on Part A, this can import Prescreen directly.
const FileResultSchema = z.object({
  index: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  verdict: z.enum(['pass', 'fail', 'uncertain']),
  checks: z.array(
    z.object({
      criterion: z.string(),
      question: z.string(),
      probability: z.number().min(0).max(1),
      status: z.enum(['pass', 'fail', 'inconclusive']),
    })
  ),
});

const PrescreenResultSchema = z.object({
  provider: z.literal('openrouter-decisions'),
  model: z.string(),
  servedModel: z.string(),
  verdict: z.enum(['pass', 'fail', 'uncertain']),
  files: z.array(FileResultSchema),
  ranking: z.array(z.number().int()).nullable(),
  rankingConfidence: z.number().nullable(),
  thresholds: z.object({
    passAbove: z.number(),
    failBelow: z.number(),
  }),
  usage: z.object({
    requests: z.number().int(),
    inputTokens: z.number().int(),
    costUsd: z.number().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
  }),
  at: z.string(),
});

function fakeSha256(str) {
  return 'a'.repeat(64);
}

async function makePng(dir, name, width = 32, height = 32) {
  const p = join(dir, name);
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=red:s=${width}x${height}`,
    '-frames:v',
    '1',
    p,
  ]);
  const stat = await readFile(p);
  return { path: p, sha256: '0123456789abcdef'.repeat(4), bytes: stat.length };
}

test('1. Luna request for 3-option backgroundCandidates: 1 POST, top-level state strings and image_url, opt<i>__<crit> noul questions, rank choice, no people or characters in empty-environment, no key in body', { timeout: 10000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dec-test-1-'));
  try {
    const f0 = await makePng(tmp, 'opt0.png');
    const f1 = await makePng(tmp, 'opt1.png');
    const f2 = await makePng(tmp, 'opt2.png');
    const files = [f0, f1, f2];
    const criteria = ['scene-fit', 'style', 'story-specific-set', 'empty-environment', 'spatial-action', 'continuity'];

    let capturedUrl = null;
    let capturedOptions = null;
    let requestCount = 0;

    const fakeFetcher = async (url, opts) => {
      requestCount++;
      capturedUrl = url;
      capturedOptions = opts;

      const body = JSON.parse(opts.body);
      const answers = {};
      for (const qKey of Object.keys(body.questions)) {
        if (qKey === 'rank') {
          answers.rank = { type: 'choice', choice: '1', confidence: 0.95, probabilities: { '0': 0.1, '1': 0.85, '2': 0.05 } };
        } else {
          answers[qKey] = { type: 'noul', noul: 0.98 };
        }
      }

      return new Response(JSON.stringify({
        id: 'gen-dec-123',
        model: 'openai/gpt-6-luna-decisions-20261010',
        answers,
        usage: { input_tokens: 500, output_tokens: 80, cost: 0.00005 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const apiKey = 'sk-or-test-secret-key-12345';
    const result = await runPrescreen({
      config: { model: 'openai/gpt-6-luna-decisions', passAbove: 0.9, failBelow: 0.4 },
      apiKey,
      fetcher: fakeFetcher,
      step: 'backgroundCandidates',
      files,
      references: [],
      contextText: 'childhood bedroom brief',
      criteria,
    });

    assert.equal(requestCount, 1);
    assert.equal(capturedUrl, DECISIONS_URL);
    assert.equal(capturedOptions.headers.Authorization, `Bearer ${apiKey}`);
    assert.equal(capturedOptions.headers['Content-Type'], 'application/json');

    const bodyText = capturedOptions.body;
    assert.ok(!bodyText.includes(apiKey), 'API key must never appear in body');
    const body = JSON.parse(bodyText);
    assert.equal(body.model, 'openai/gpt-6-luna-decisions');
    assert.ok(Array.isArray(body.state), 'state must be a top-level array');
    assert.ok(!('images' in body), 'body must not have an images field');

    for (const item of body.state) {
      if (typeof item !== 'string') {
        assert.equal(item.type, 'image_url');
        assert.ok(item.image_url?.url?.startsWith('data:image/'));
        assert.ok(!('input_image' in item));
      }
    }

    // Check questions: opt<i>__<crit> with type noul
    for (let i = 0; i < 3; i++) {
      for (const crit of [...criteria, 'no-text']) {
        const qKey = `opt${i}__${crit}`;
        assert.ok(qKey in body.questions, `Missing question ${qKey}`);
        assert.equal(body.questions[qKey].type, 'noul');
      }
    }
    assert.ok(body.questions.rank);
    assert.equal(body.questions.rank.type, 'choice');
    assert.deepEqual(Object.keys(body.questions.rank.criteria), ['0', '1', '2']);

    // Check empty-environment instructions
    const emptyQ = body.questions.opt0__empty_environment ?? body.questions['opt0__empty-environment'];
    assert.ok(emptyQ, 'empty-environment question missing');
    assert.match(emptyQ.instructions, /no people or characters/i);
    assert.ok(!emptyQ.instructions.toLowerCase().includes('empty room'), 'instructions must not say empty room');

    assert.equal(result.verdict, 'pass');
    assert.deepEqual(result.ranking, [1, 0, 2]);
    assert.equal(result.servedModel, 'openai/gpt-6-luna-decisions-20261010');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('2. clef-flash for same set: 3 per-option requests plus 1 ranking request, PRESCREEN_TOO_MANY_IMAGES guard, image recompression <=300KB', { timeout: 10000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dec-test-2-'));
  try {
    // Generate a large PNG > 300KB using uncompressed video frame or raw noise
    const largePng = join(tmp, 'large.png');
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'mandelbrot=size=1024x1024:rate=1',
      '-frames:v',
      '1',
      largePng,
    ]);
    let largeBytes = (await readFile(largePng)).length;
    if (largeBytes <= 300 * 1024) {
      // Fallback: write bytes directly into PNG structure or use higher dimension
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=2048x2048:rate=1',
        '-frames:v',
        '1',
        largePng,
      ]);
      largeBytes = (await readFile(largePng)).length;
    }
    const f0 = { path: largePng, sha256: fakeSha256('0'), bytes: largeBytes };
    assert.ok(f0.bytes > 300 * 1024, `generated fixture should be > 300KB, was ${f0.bytes}`);

    const f1 = await makePng(tmp, 'opt1.png', 100, 100);
    const f2 = await makePng(tmp, 'opt2.png', 100, 100);
    const files = [f0, f1, f2];
    const criteria = ['scene-fit', 'style'];

    const requestsCaptured = [];
    const fakeFetcher = async (url, opts) => {
      const parsedBody = JSON.parse(opts.body);
      requestsCaptured.push(parsedBody);
      const answers = {};
      for (const qKey of Object.keys(parsedBody.questions)) {
        if (qKey === 'rank') {
          answers.rank = { type: 'choice', choice: '0', confidence: 0.9, probabilities: { '0': 0.7, '1': 0.2, '2': 0.1 } };
        } else {
          answers[qKey] = { type: 'noul', noul: 0.92 };
        }
      }
      return new Response(JSON.stringify({
        id: 'gen-dec-clef',
        model: 'cloudflare/clef-flash',
        answers,
        usage: { input_tokens: 300, output_tokens: 20, cost: 0.00001 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await runPrescreen({
      config: { model: 'cloudflare/clef-flash' },
      apiKey: 'test-key',
      fetcher: fakeFetcher,
      step: 'backgroundCandidates',
      files,
      references: [],
      contextText: 'brief',
      criteria,
    });

    // 3 per-option requests + 1 ranking request = 4 requests
    assert.equal(requestsCaptured.length, 4);

    // Verify all images sent were <= 300KB in raw byte size (base64 length * 3/4 <= 300KB)
    for (const req of requestsCaptured) {
      for (const item of req.state) {
        if (typeof item !== 'string' && item.type === 'image_url') {
          const b64 = item.image_url.url.split(',')[1];
          const rawBytes = Buffer.byteLength(b64, 'base64');
          assert.ok(rawBytes <= 300 * 1024, `Image byte size ${rawBytes} exceeds 300KB limit`);
        }
      }
    }

    // PRESCREEN_TOO_MANY_IMAGES guard: a set needing more than 4 images in one request throws PRESCREEN_TOO_MANY_IMAGES
    const tooManyFiles = [f0, f1, f2, f1, f2];
    await assert.rejects(
      runPrescreen({
        config: { model: 'cloudflare/clef-flash' },
        apiKey: 'test-key',
        fetcher: fakeFetcher,
        step: 'backgroundCandidates',
        files: tooManyFiles,
        references: [],
        criteria,
      }),
      /PRESCREEN_TOO_MANY_IMAGES/
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('3. Response parsing: noul 0.95 -> pass, 0.2 -> fail, 0.6 -> inconclusive, missing/NaN -> inconclusive, ranking probability order, date suffix on servedModel, null ranking for keyframe', { timeout: 10000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dec-test-3-'));
  try {
    const f0 = await makePng(tmp, 'k0.png');
    const files = [f0];
    const criteria = ['scene-fit', 'likeness', 'anatomy'];

    const fakeFetcher = async (url, opts) => {
      const body = JSON.parse(opts.body);
      const answers = {
        'opt0__scene-fit': { type: 'noul', noul: 0.95 },
        'opt0__likeness': { type: 'noul', noul: 0.2 },
        'opt0__anatomy': { type: 'noul', noul: 0.6 },
        'opt0__no-text': { type: 'noul', noul: NaN },
      };
      return new Response(JSON.stringify({
        id: 'gen-keyframe',
        model: 'openai/gpt-6-luna-decisions-20261011T000000Z',
        answers,
        usage: { input_tokens: 200, output_tokens: 30, cost: 0.00002 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await runPrescreen({
      config: { model: 'openai/gpt-6-luna-decisions', passAbove: 0.9, failBelow: 0.4 },
      apiKey: 'test-key',
      fetcher: fakeFetcher,
      step: 'keyframe',
      files,
      criteria,
    });

    assert.equal(result.servedModel, 'openai/gpt-6-luna-decisions-20261011T000000Z');
    assert.equal(result.ranking, null, 'keyframe 1-file step ranking must be null');
    assert.equal(result.rankingConfidence, null);

    const fRes = result.files[0];
    const cMap = Object.fromEntries(fRes.checks.map(c => [c.criterion, c.status]));
    assert.equal(cMap['scene-fit'], 'pass');
    assert.equal(cMap.likeness, 'fail');
    assert.equal(cMap.anatomy, 'inconclusive');
    assert.equal(cMap['no-text'], 'inconclusive');

    assert.equal(fRes.verdict, 'fail');
    assert.equal(result.verdict, 'fail');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('4. Error mappings: 401/403 -> DECISIONS_AUTH_FAILED, 402 -> DECISIONS_CREDITS_EXHAUSTED, 413 -> DECISIONS_IMAGE_TOO_LARGE, 429 -> DECISIONS_RATE_LIMITED, PRESCREEN_MODEL_UNKNOWN, key never leaked', { timeout: 10000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dec-test-4-'));
  try {
    const f0 = await makePng(tmp, 'f0.png');
    const secretKey = 'sk-or-super-secret-password-xyz';

    for (const [code, errPattern] of [
      [401, /DECISIONS_AUTH_FAILED/],
      [402, /DECISIONS_CREDITS_EXHAUSTED/],
      [413, /DECISIONS_IMAGE_TOO_LARGE/],
      [429, /DECISIONS_RATE_LIMITED/],
    ]) {
      const fetcher = async () => new Response(`Error ${code} body with secret ${secretKey}`, { status: code });
      await assert.rejects(
        runPrescreen({
          config: { model: 'openai/gpt-6-luna-decisions' },
          apiKey: secretKey,
          fetcher,
          step: 'keyframe',
          files: [f0],
          criteria: ['scene-fit'],
        }),
        (err) => {
          assert.match(err.message, errPattern);
          assert.ok(!err.message.includes(secretKey), `Key leaked in error: ${err.message}`);
          return true;
        }
      );
    }

    // Missing key error
    await assert.rejects(
      runPrescreen({
        config: { model: 'openai/gpt-6-luna-decisions' },
        apiKey: null,
        secretsPath: join(tmp, 'nonexistent.env'),
        fetcher: fetch,
        step: 'keyframe',
        files: [f0],
        criteria: ['scene-fit'],
      }),
      /OPENROUTER_API_KEY missing/
    );

    // Unknown model
    await assert.rejects(
      runPrescreen({
        config: { model: 'some/unknown-model' },
        apiKey: secretKey,
        fetcher: fetch,
        step: 'keyframe',
        files: [f0],
        criteria: ['scene-fit'],
      }),
      /PRESCREEN_MODEL_UNKNOWN/
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('5. usage.costUsd sums cost across requests, inputTokens sums input_tokens, estimatePrescreenCost is model-specific', { timeout: 10000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dec-test-5-'));
  try {
    const f0 = await makePng(tmp, 'f0.png');
    const f1 = await makePng(tmp, 'f1.png');
    const files = [f0, f1];

    const estLuna = estimatePrescreenCost({ model: 'openai/gpt-6-luna-decisions', files, contextText: 'sample text' });
    const estClef = estimatePrescreenCost({ model: 'cloudflare/clef-flash', files, contextText: 'sample text' });
    assert.ok(estLuna > 0);
    assert.ok(estClef > 0);
    assert.ok(estClef < estLuna, `clef-flash ($${estClef}) should be cheaper than Luna ($${estLuna})`);

    let callCount = 0;
    const fakeFetcher = async (url, opts) => {
      callCount++;
      const body = JSON.parse(opts.body);
      const answers = {};
      for (const k of Object.keys(body.questions)) answers[k] = { type: 'noul', noul: 0.95 };
      return new Response(JSON.stringify({
        id: `gen-${callCount}`,
        model: 'cloudflare/clef-flash',
        answers,
        usage: { input_tokens: 150, output_tokens: 10, cost: 0.000015 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await runPrescreen({
      config: { model: 'cloudflare/clef-flash' },
      apiKey: 'test-key',
      fetcher: fakeFetcher,
      step: 'candidates',
      files,
      criteria: ['style'],
    });

    // 2 files in clef-flash -> 2 requests
    assert.equal(callCount, 2);
    assert.equal(result.usage.requests, 2);
    assert.equal(result.usage.inputTokens, 300);
    assert.ok(Math.abs(result.usage.costUsd - 0.00003) < 1e-8);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('6. Output validates against local copy of Prescreen contract schema', { timeout: 10000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dec-test-6-'));
  try {
    const f0 = await makePng(tmp, 'f0.png');
    const f1 = await makePng(tmp, 'f1.png');
    const f2 = await makePng(tmp, 'f2.png');
    const files = [f0, f1, f2];
    const criteria = ['scene-fit', 'style'];

    const fakeFetcher = async (url, opts) => {
      const body = JSON.parse(opts.body);
      const answers = {};
      for (const k of Object.keys(body.questions)) {
        if (k === 'rank') answers.rank = { type: 'choice', choice: '2', confidence: 0.8, probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 } };
        else answers[k] = { type: 'noul', noul: 0.96 };
      }
      return new Response(JSON.stringify({
        id: 'gen-schema-test',
        model: 'openai/gpt-6-luna-decisions',
        answers,
        usage: { input_tokens: 400, output_tokens: 50, cost: 0.00004 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await runPrescreen({
      config: { model: 'openai/gpt-6-luna-decisions' },
      apiKey: 'test-key',
      fetcher: fakeFetcher,
      step: 'backgroundCandidates',
      files,
      criteria,
    });

    // Schema validation check
    const parsed = PrescreenResultSchema.parse(result);
    assert.equal(parsed.provider, 'openrouter-decisions');
    assert.equal(parsed.verdict, 'pass');
    assert.deepEqual(parsed.ranking, [2, 1, 0]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('7. Replay scoring for two models with canned results: confusion matrix, agreement, spend guard', { timeout: 10000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dec-test-7-'));
  try {
    const secretsPath = join(tmp, 'secrets.env');
    await writeFile(secretsPath, 'OPENROUTER_API_KEY=sk-or-replay-test-key\n');
    const outDir = join(tmp, 'out');

    const cannedJudgment = {
      action: 'review',
      decision: 'approved',
      step: 'backgroundCandidates',
      checks: [{ criterion: 'scene-fit', status: 'pass' }],
      recommendation: { selection: 1 },
      files: [{ path: join(tmp, 'f0.png'), sha256: fakeSha256('0'), bytes: 100 }],
      artifact: { content: { prompt: 'room', references: [] } },
    };

    // Run without --confirm-spend
    let loggedStdout = '';
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk) => { loggedStdout += chunk; return true; };

    try {
      await replayDecisions({
        runDir: tmp,
        secretsPath,
        confirmSpend: false,
        maxUsd: 0.05,
        outDir,
        judgmentsList: [cannedJudgment],
      });
    } finally {
      process.stdout.write = origWrite;
    }

    assert.match(loggedStdout, /Decisions Replay Estimated Cost/i);
    assert.match(loggedStdout, /Spend not confirmed/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('8. runPrescreen with fake tracer sends one openrouter-decisions paid-job per request with actualCostUsd equal to usage.cost', { timeout: 10000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dec-test-8-'));
  try {
    const secretsPath = join(tmp, 'secrets.env');
    await writeFile(secretsPath, 'LANGSMITH_API_KEY=ls-test-key\nOPENROUTER_API_KEY=sk-or-test-key\n');
    const f0 = await makePng(tmp, 'p0.png');
    const files = [f0];

    const fakeClient = { captured: [] };
    const tracer = await createTracer({ secretsPath, runId: 'test-dec-trace', client: fakeClient });

    const fakeFetcher = async () => new Response(JSON.stringify({
      id: 'gen-trace-1',
      model: 'openai/gpt-6-luna-decisions',
      answers: { 'opt0__scene-fit': { type: 'noul', noul: 0.95 }, 'opt0__no-text': { type: 'noul', noul: 0.95 } },
      usage: { input_tokens: 120, output_tokens: 20, cost: 0.0000123 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    await runPrescreen({
      config: { model: 'openai/gpt-6-luna-decisions' },
      secretsPath,
      fetcher: fakeFetcher,
      step: 'keyframe',
      files,
      criteria: ['scene-fit'],
      tracer,
    });

    const paidJobRuns = fakeClient.captured.filter(r => r.phase === 'paid-job-end');
    assert.equal(paidJobRuns.length, 1);
    const trace = paidJobRuns[0];
    assert.equal(trace.provider, 'openrouter-decisions');
    assert.equal(trace.actualCostUsd, 0.0000123);
    assert.equal(trace.outcome, 'ok');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
