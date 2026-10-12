import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createTracer, _resetWarnedForTests } from '../runtime/tracing.mjs';
import { OpenRouterHost, DEFAULT_OPENROUTER_MODEL } from '../runtime/openrouter-host.mjs';
import { executeMediaRequest } from '../runtime/providers.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function makeTestEnv(extraSecrets = '') {
  const dir = await mkdtemp(join(tmpdir(), 'trace-test-'));
  const secretsPath = join(dir, 'secrets.env');
  await writeFile(secretsPath, `LANGSMITH_API_KEY=lsv2_test_key_12345678\nSECRET_TOKEN=top-secret-token-999\n${extraSecrets}`);
  return { dir, secretsPath };
}

test('Task 1: per-run byte cap counts each payload once with journaling ON (~0.8N not stripped, >N stripped)', { timeout: 10000 }, async () => {
  const { dir, secretsPath } = await makeTestEnv();
  const prev = process.stderr.write;
  process.stderr.write = () => true;
  _resetWarnedForTests();
  let tracer = null;
  try {
    const fake = { captured: [] };
    const N = 10000;
    tracer = await createTracer({
      secretsPath,
      runId: 'cap-double-count-check',
      runDir: dir,
      client: fake,
      limits: { maxRunBytes: N },
    });

    // 4 tool calls with ~1800 chars payload each (~7200 bytes total ~0.72N - ~0.8N)
    // On main, journaling double-counted (size in emitStart + line in appendJournal),
    // exhausting 10k budget by run 2/3 and stripping run 3.
    for (let i = 0; i < 4; i++) {
      const t = tracer.tool({ toolName: `tool-${i}`, data: 'alpha beta gamma '.repeat(110) });
      t.end();
    }

    const runs = fake.captured.filter((r) => r.phase === 'tool');
    assert.equal(runs.length, 4, '4 tool calls recorded');
    for (let i = 0; i < 4; i++) {
      assert.equal(runs[i].budgetExhausted, undefined, `tool ${i} must not be budgetExhausted at ~0.8N`);
      assert.ok(runs[i].data && runs[i].data.length > 1000, `tool ${i} data must not be stripped`);
    }

    // Now emit payload that pushes total over N (> 10000)
    const over = tracer.tool({ toolName: 'tool-over', data: 'overflow words '.repeat(300) });
    over.end();

    // Next run starts when byteUsed > N, so it must be stripped
    const stripped = tracer.tool({ toolName: 'tool-stripped', data: 'stripped words '.repeat(50) });
    stripped.end();

    const overRuns = fake.captured.filter((r) => r.phase === 'tool');
    const lastRun = overRuns.at(-1);
    assert.equal(lastRun.budgetExhausted, true, 'run exceeding N must have budgetExhausted: true');
    assert.equal(lastRun.data, undefined, 'data must be stripped once over budget');

    // Journal was written and journalBytes is tracked separately from byteUsed
    await tracer.flush();
    const journalText = await readFile(join(dir, 'trace', 'trace.jsonl'), 'utf8');
    assert.ok(journalText.includes('tool-0'));
    assert.ok(tracer.journalBytes > tracer.byteUsed, 'journalBytes records disk lines independently');
  } finally {
    process.stderr.write = prev;
    _resetWarnedForTests();
    await tracer?.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Task 2: attachImage attaches image bytes to fake client and mirrors metadata to journal', { timeout: 10000 }, async () => {
  const { dir, secretsPath } = await makeTestEnv();
  let tracer = null;
  try {
    const fake = { captured: [] };
    tracer = await createTracer({
      secretsPath,
      runId: 'attach-check',
      runDir: dir,
      client: fake,
    });

    const imgBytes = Buffer.from('fake-png-binary-data-for-testing-attachments-123456');
    const imgSha = sha256(imgBytes);
    const imgPath = join(dir, 'plate.png');
    await writeFile(imgPath, imgBytes);

    const turn = tracer.turn({ role: 'visual-reviewer', workerName: 'Vera' });
    const attResult = await tracer.attachImage(turn, {
      name: 'plate.png',
      path: imgPath,
      mimeType: 'image/png',
    });
    assert.ok(attResult, 'attachImage returned attachment tuple');
    assert.equal(attResult[0], 'image/png');
    assert.equal(attResult.sha256, imgSha);
    assert.equal(attResult.bytes, imgBytes.length);

    turn.end({ outcome: 'completed' });
    await tracer.flush();

    // Check fake client recorded attachment
    const capturedTurn = fake.captured.find((r) => r.phase === 'crew-turn');
    assert.ok(capturedTurn.attachments, 'crew-turn has attachments');
    const att = capturedTurn.attachments['plate.png'];
    assert.ok(att, 'plate.png attachment present');
    assert.equal(att.mime, 'image/png');
    assert.equal(att.sha256, imgSha);
    assert.equal(att.byteLength, imgBytes.length);
    assert.equal(att[0], 'image/png');
    assert.ok(att[1] instanceof Uint8Array);

    const attEvent = fake.captured.find((r) => r.phase === 'attachment');
    assert.ok(attEvent, 'phase attachment event emitted');
    assert.equal(attEvent.name, 'plate.png');
    assert.equal(attEvent.mime, 'image/png');
    assert.equal(attEvent.sha256, imgSha);
    assert.equal(attEvent.byteLength, imgBytes.length);

    // Check journal mirrors reference and never leaks raw bytes
    const journalText = await readFile(join(dir, 'trace', 'trace.jsonl'), 'utf8');
    const lines = journalText.trim().split('\n').map((l) => JSON.parse(l));
    const journalAtt = lines.find((l) => l.phase === 'attachment');
    assert.ok(journalAtt, 'attachment mirrored in journal');
    assert.equal(journalAtt.name, 'plate.png');
    assert.equal(journalAtt.mimeType, 'image/png');
    assert.equal(journalAtt.sha256, imgSha);
    assert.equal(journalAtt.bytes, imgBytes.length);
    assert.equal(journalAtt.attached, true);
    assert.ok(!journalText.includes('fake-png-binary-data'), 'raw image bytes never written to journal');
  } finally {
    await tracer?.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Task 2: per-image limit, budget exceeded, and missing files skip with reasons without throwing', { timeout: 10000 }, async () => {
  const { dir, secretsPath } = await makeTestEnv();
  const prev = process.stderr.write;
  process.stderr.write = () => true;
  _resetWarnedForTests();
  let tracer = null;
  try {
    const fake = { captured: [] };
    tracer = await createTracer({
      secretsPath,
      runId: 'skip-reasons-check',
      runDir: dir,
      client: fake,
      limits: { maxImageBytes: 1000, maxRunBytes: 2500 },
    });

    const turn = tracer.turn({ role: 'visual-reviewer', workerName: 'Vera' });

    // 1. Per-image limit: 1500 bytes image (> maxImageBytes 1000)
    const bigBytes = Buffer.alloc(1500, 'b');
    const r1 = await tracer.attachImage(turn, { name: 'big.png', bytes: bigBytes });
    assert.equal(r1.attachment_skipped, true);
    assert.equal(r1.reason, 'image-too-large');

    // 2. Fits image cap (800 bytes <= 1000, 800 <= 2500 run cap)
    const okBytes = Buffer.alloc(800, 'o');
    const r2 = await tracer.attachImage(turn, { name: 'ok.png', bytes: okBytes });
    assert.ok(Array.isArray(r2), 'valid image attached');

    // 3. Budget cap: 900 bytes fits per-image (900 <= 1000). Total used so far ~200+200+800+900=2100 <= 2500.
    const medBytes1 = Buffer.alloc(900, 'm');
    const r3 = await tracer.attachImage(turn, { name: 'med1.png', bytes: medBytes1 });
    assert.ok(Array.isArray(r3), 'med1 attached');

    // Next 900 bytes image has distinct content ('n' vs 'm'), so sha differs and budget check triggers (2100+900=3000 > 2500).
    const medBytes2 = Buffer.alloc(900, 'n');
    const r4 = await tracer.attachImage(turn, { name: 'med2.png', bytes: medBytes2 });
    assert.equal(r4.attachment_skipped, true);
    assert.equal(r4.reason, 'budget-exceeded');

    // 4. Missing file path: never throws, warns once, records read-error
    const r5 = await tracer.attachImage(turn, { name: 'missing.png', path: join(dir, 'does-not-exist.png') });
    assert.equal(r5.attachment_skipped, true);
    assert.equal(r5.reason, 'read-error');

    // 5. Secret scrubbing on attachment name
    const secretNamedBytes = Buffer.alloc(100, 's');
    await tracer.attachImage(turn, { name: 'photo-with-top-secret-token-999.png', bytes: secretNamedBytes });
    const dumped = JSON.stringify(fake.captured);
    assert.ok(!dumped.includes('top-secret-token-999'), 'secret value in attachment name was scrubbed');

    turn.end({ outcome: 'completed' });
    await tracer.flush();

    // Verify metadata records skip details
    assert.equal(turn.metadata.attachment_skipped, true);
    const skippedList = turn.metadata.skipped_attachments;
    assert.ok(Array.isArray(skippedList) && skippedList.length >= 3);
    assert.ok(skippedList.some((s) => s.reason === 'image-too-large'));
    assert.ok(skippedList.some((s) => s.reason === 'budget-exceeded'));
    assert.ok(skippedList.some((s) => s.reason === 'read-error'));
  } finally {
    process.stderr.write = prev;
    _resetWarnedForTests();
    await tracer?.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Task 2: reviewer check runs (Vera and June) automatically attach reviewed images', { timeout: 10000 }, async () => {
  const { dir, secretsPath } = await makeTestEnv('OPENROUTER_API_KEY=test-openrouter-key-123\n');
  const fake = { captured: [] };
  let tracer = null;

  try {
    tracer = await createTracer({
      secretsPath,
      runId: 'reviewers-check',
      runDir: dir,
      client: fake,
    });

    const img1 = join(dir, 'vera-option-0.png');
    const img2 = join(dir, 'vera-option-1.png');
    await writeFile(img1, Buffer.from('vera-image-option-0'));
    await writeFile(img2, Buffer.from('vera-image-option-1'));

    const file1 = { path: img1, sha256: sha256(Buffer.from('vera-image-option-0')), bytes: 19 };
    const file2 = { path: img2, sha256: sha256(Buffer.from('vera-image-option-1')), bytes: 19 };

    const host = new OpenRouterHost({
      cwd: dir,
      secretsPath,
      model: DEFAULT_OPENROUTER_MODEL,
      tracer,
      fetcher: async (url, init) => {
        let taskId = 'task-review';
        try {
          const body = JSON.parse(init.body);
          const lastMsg = body.messages?.at(-1);
          const packet = typeof lastMsg?.content === 'string' ? JSON.parse(lastMsg.content) : JSON.parse(lastMsg?.content?.[0]?.text);
          taskId = packet.task?.taskId ?? taskId;
        } catch {}
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            choices: [{
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  eventJson: JSON.stringify({
                    taskId,
                    actor: 'reviewer',
                    action: 'review',
                    review: { perception: 'direct-image', decision: 'approved', checks: [] }
                  })
                })
              }
            }]
          })
        };
      }
    });

    const cap = await host.profile();

    // 1. Vera (visual-reviewer: character sheets, setting plates)
    const veraWorker = { workerId: 'w-vera', name: 'Vera', role: 'visual-reviewer', modelVersion: DEFAULT_OPENROUTER_MODEL, capabilityVersion: cap, backend: 'openrouter' };
    const veraTask = {
      taskId: 'task-vera',
      step: 'sheet',
      gate: 'review',
      crewWorker: veraWorker,
      artifact: { id: 'sheet:1', content: { files: [file1, file2] } },
    };
    await host.runTask(veraTask, { worker: veraWorker, callTool: async () => {} });

    // 2. June (scene-reviewer: scene/keyframes)
    const juneImg = join(dir, 'june-keyframe.png');
    await writeFile(juneImg, Buffer.from('june-keyframe-image'));
    const juneFile = { path: juneImg, sha256: sha256(Buffer.from('june-keyframe-image')), bytes: 19 };

    const juneWorker = { workerId: 'w-june', name: 'June', role: 'scene-reviewer', modelVersion: DEFAULT_OPENROUTER_MODEL, capabilityVersion: cap, backend: 'openrouter' };
    const juneTask = {
      taskId: 'task-june',
      step: 'keyframe',
      gate: 'review',
      crewWorker: juneWorker,
      artifact: { id: 'keyframe:1', content: { files: [juneFile] } },
    };
    await host.runTask(juneTask, { worker: juneWorker, callTool: async () => {} });

    await tracer.flush();

    // Verify Vera attachments
    const veraTurn = fake.captured.find((r) => r.phase === 'crew-turn' && r.name.includes('visual-reviewer'));
    assert.ok(veraTurn, 'Vera crew turn captured');
    assert.ok(veraTurn.attachments, 'Vera turn has attachments');
    assert.ok(Object.keys(veraTurn.attachments).length >= 2, 'both options attached to Vera run');
    assert.ok(veraTurn.attachments['option-0-vera-option-0.png'], 'Vera option-0 attached');
    assert.ok(veraTurn.attachments['option-1-vera-option-1.png'], 'Vera option-1 attached');

    // Verify June attachments
    const juneTurn = fake.captured.find((r) => r.phase === 'crew-turn' && r.name.includes('scene-reviewer'));
    assert.ok(juneTurn, 'June crew turn captured');
    assert.ok(juneTurn.attachments, 'June turn has attachments');
    assert.ok(juneTurn.attachments['june-keyframe.png'], 'June keyframe image attached');
  } finally {
    await tracer?.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Task 2: image-generating steps attach generated output images', { timeout: 10000 }, async () => {
  const { dir, secretsPath } = await makeTestEnv();
  const fake = { captured: [] };
  let tracer = null;

  try {
    tracer = await createTracer({
      secretsPath,
      runId: 'image-gen-check',
      runDir: dir,
      rootName: 'generate',
      client: fake,
    });

    const job = {
      id: 'job-sheet-1',
      digest: 'digest-sheet-1',
      plan: { provider: 'meta-muse', operation: 'sheet', estimatedCostUsd: 0.01, parameters: { prompt: 'a character sheet' } },
      request: { endpoint: 'https://api.meta.ai/v1/images/edits', n: 1, prompt: 'sheet', output_format: 'png', images: [] },
    };

    // Mock fetcher returning valid 1x1 PNG bytes for executeMediaRequest
    const mockFetcher = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ b64_json: PNG.toString('base64') }],
      }),
    });

    const result = await executeMediaRequest(job, dir, 'fake-muse-key', mockFetcher, false, null, { tracer });
    assert.ok(result.files && result.files.length === 1);
    await tracer.flush();

    // Verify output image was attached to root
    const rootCaptured = fake.captured.find((r) => r.phase === 'root');
    assert.ok(rootCaptured.attachments, 'root run has attachments from generated output');
    const attachedFile = Object.values(rootCaptured.attachments).find((a) => a.sha256 === sha256(PNG));
    assert.ok(attachedFile, 'generated sheet image attached');
    assert.equal(attachedFile.bytes, PNG.length);
  } finally {
    await tracer?.flush();
    await rm(dir, { recursive: true, force: true });
  }
});
