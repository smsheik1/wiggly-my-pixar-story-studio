import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveQueueDir, emitFlowJob, checkLandedImage, waitForFlowJob } from '../scripts/flow-queue.mjs';

test('resolveQueueDir: respects custom directory or fallback', () => {
  const custom = '/tmp/custom-wiggly-queue';
  assert.equal(resolveQueueDir(custom), custom);
});

test('emitFlowJob: bundles prompt and references into queue directory', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'wiggly-queue-test-'));
  try {
    const dummyRef = join(tmp, 'dummy-ref.png');
    await writeFile(dummyRef, 'fake-image-bytes');

    const res = await emitFlowJob({
      jobId: 'sheet-1',
      runId: 'run-101',
      prompt: 'A boy sits with sunglasses on his head.',
      references: [dummyRef],
      queueDir: tmp,
    });

    assert.ok(res.jobDir);
    assert.equal(res.job.jobId, 'sheet-1');
    assert.equal(res.job.references.length, 1);
    assert.equal(res.job.references[0].name, 'dummy-ref.png');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('checkLandedImage: catches missing files and validates dimensions', async () => {
  const missing = checkLandedImage('/tmp/nonexistent-image.png');
  assert.equal(missing.ok, false);
  assert.equal(missing.issues[0].code, 'FILE_MISSING');
});

test('waitForFlowJob: times out when output never lands', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'wiggly-queue-timeout-'));
  try {
    await emitFlowJob({
      jobId: 'sheet-timeout',
      runId: 'run-102',
      prompt: 'Testing timeout.',
      queueDir: tmp,
    });

    await assert.rejects(
      () => waitForFlowJob('sheet-timeout', { queueDir: tmp, timeoutMs: 200, pollIntervalMs: 50 }),
      /timed out after 0s waiting/
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
