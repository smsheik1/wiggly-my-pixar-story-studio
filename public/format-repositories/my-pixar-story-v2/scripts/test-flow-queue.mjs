#!/usr/bin/env node
// Test script to verify the Flow Queue + Grok Bot webhook round-trip loop.
import { emitFlowJob, waitForFlowJob, resolveQueueDir } from './flow-queue.mjs';
import { loadSecrets } from './lib/secrets.mjs';
import { join } from 'node:path';

const sec = loadSecrets(undefined, (k) => k === 'FLOW_WEBHOOK_URL' || k === 'FLOW_WEBHOOK_AUTH');
const webhookUrl = sec.FLOW_WEBHOOK_URL;
const webhookAuth = sec.FLOW_WEBHOOK_AUTH;

if (!webhookUrl || !webhookAuth) {
  console.error('FLOW_WEBHOOK_URL or FLOW_WEBHOOK_AUTH missing in secrets.env');
  process.exit(1);
}

const waitOnly = process.argv.includes('--wait-only') ? process.argv[process.argv.indexOf('--wait-only') + 1] : null;
const runIdArg = process.argv.includes('--run-id') ? process.argv[process.argv.indexOf('--run-id') + 1] : null;

const runId = runIdArg || `test-${new Date().toISOString().slice(0, 10)}`;
const jobId = waitOnly || `test-ping-${Date.now().toString().slice(-4)}`;

if (!waitOnly) {
  console.log(`[test] Emitting test Flow job:`);
  console.log(`  runId:   ${runId}`);
  console.log(`  jobId:   ${jobId}`);
  console.log(`  Queue:   ${resolveQueueDir()}`);

  const { jobDir, job } = await emitFlowJob({
    jobId,
    runId,
    kind: 'character-sheet',
    prompt: 'A tiny cute robot waving cheerfully on a clean tabletop, soft warm lighting, 3D animated feature film style.',
    references: [],
    aspect: '16:9',
    webhook: {
      url: webhookUrl,
      auth: webhookAuth,
    },
  });

  console.log(`[test] Job created and webhook notified! Waiting for Grok Bot to process...`);
  console.log(`  Watching: ${join(jobDir, 'output.png.done')}`);
} else {
  console.log(`[test] Waiting on existing job: ${jobId} (run: ${runId})`);
}

try {
  const result = await waitForFlowJob(jobId, {
    runId,
    timeoutMs: 300_000,
    pollIntervalMs: 3000,
    isPanel: false,
  });
  console.log(`[test] SUCCESS! Output received and verified:`);
  console.log(`  Path:       ${result.outputPath}`);
  console.log(`  Dimensions: ${result.width}x${result.height}`);
} catch (err) {
  console.error(`[test] Failed:`, err.message);
  process.exit(1);
}
