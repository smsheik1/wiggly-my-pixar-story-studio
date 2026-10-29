import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokePersisting } from '../graph/run-state.mjs';
import { runCustomer, seedance480pRenderer } from '../scripts/run-customer.mjs';

test('state.json is rewritten on every graph status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-state-'));
  const file = join(root, 'outputs', 'state.json');
  const seen = [];
  const graph = {
    stream() {
      return (async function* () {
        yield { status: 'running', pendingApproval: [] };
        seen.push(JSON.parse(readFileSync(file, 'utf8')).status);
        yield { status: 'awaiting-approval', pendingApproval: ['@Image 1'], retryCounts: {}, escalations: [], validationErrors: [] };
      })();
    },
  };
  try {
    const state = await invokePersisting(graph, {}, {}, file);
    assert.equal(state.status, 'awaiting-approval');
    assert.deepEqual(seen, ['running']);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).pendingApproval, ['@Image 1']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a customer run starts production at 480p and does not auto-approve', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-customer-'));
  let options;
  const graph = {
    stream() {
      return (async function* () {
        yield { status: 'awaiting-approval', pendingApproval: ['@Image 1'] };
      })();
    },
  };
  try {
    const result = await runCustomer({
      project: { inputs: { subject: 'Shaz', answers: { childhood: 'the porch' } } },
      runId: 'film-1',
      runsRoot: root,
      invoke: () => '{}',
      apiKey: 'test-token',
      photoRefsPath: null,
      log: () => {},
      buildGraphFn: (opts) => { options = opts; return graph; },
    });
    assert.equal(options.production, true);
    assert.equal(options.useInterrupt, true);
    assert.equal(options.storyboard, true);
    assert.equal(options.autoApprove, false);
    assert.equal(options.autoApproveAnimatic, false);
    assert.equal(options.autoApproveProduction, false);
    assert.equal(typeof options.renderClip, 'function');
    assert.equal(result.state.status, 'awaiting-approval');
    const saved = JSON.parse(readFileSync(result.stateFile, 'utf8'));
    assert.equal(saved.status, 'awaiting-approval');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a customer clip asks Seedance for 480p', async () => {
  const bodies = [];
  const fetchFn = async (_url, init) => {
    if (init?.body && typeof init.body === 'string') bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'clip-1', status: 'succeeded', output: 'https://replicate.delivery/clip.mp4' }), { status: 201 });
  };
  const render = seedance480pRenderer({ apiKey: 'test-token', fetchFn });
  await render({
    clip: { segmentId: 1, compiledPrompt: 'A wide shot of the porch.', references: [], generationPayload: { engine: 'seedance-2.5', durationSec: 10 } },
    runDir: '/tmp',
    duration: 10,
    state: { assetFiles: {} },
  });
  assert.equal(bodies[0].input.resolution, '480p');
});
