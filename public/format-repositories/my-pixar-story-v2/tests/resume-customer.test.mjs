import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGraph } from '../graph/graph.mjs';
import { runCustomer, resumeCustomer } from '../scripts/run-customer.mjs';
import { GOOD_ANSWERS } from './fixtures/good-answers.mjs';
import { draftStoryboard } from './fixtures/storyboard-draft.mjs';

const json = (file) => JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8'));
const FIX = {
  'story-director': 'good-stage-play.json',
  'character-architect': 'good-master-renders.json',
  'location-scout': 'good-location-plates.json',
  'seedance-compiler': 'good-seedance-prompts.json',
};

test('an approval is written back and the same run resumes through production at 480p', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-resume-'));
  const invoke = async (req) => {
    if (req.agent === 'storyboard-artist') return JSON.stringify(draftStoryboard(req.input));
    return JSON.stringify(json(FIX[req.agent]));
  };
  const rendered = [];
  const renderClip = async ({ duration }) => {
    rendered.push(duration);
    return { clipId: rendered.length, videoPath: '/tmp/missing-clip.mp4', durationSec: duration, predictionId: 'pred', costUsd: 0 };
  };
  const stills = [];
  const renderStill = async (request) => {
    stills.push(request);
    return { dest: request.dest, id: 'still', url: 'https://example.com/still.png' };
  };
  const shared = { runId: 'film-resume', runsRoot: root, invoke, apiKey: 'test-token', renderClip, renderStill, photoRefsPath: null, log: () => {}, buildGraphFn: buildGraph };
  try {
    const started = await runCustomer({ ...shared, project: { inputs: { subject: 'Shaz', answers: GOOD_ANSWERS, targetTotalRuntimeSec: 60, settingSeed: 'suburban home' } } });
    assert.equal(started.state.status, 'awaiting-approval');
    assert.ok(started.state.pendingApproval.length > 0);
    const masters = json('good-master-renders.json');
    assert.equal(stills[0].prompt, masters.characters[0].masterRenderPrompt.promptText);
    assert.equal(stills[0].resolution, '1K');
    assert.ok(started.state.assetFiles['@Image 1']);

    const assets = await resumeCustomer({ ...shared, decision: { approvedAssets: json('good-approved-assets.json') } });
    assert.deepEqual(assets.state.pendingApproval, ['animatic']);
    const written = JSON.parse(readFileSync(join(root, 'film-resume', 'outputs', 'approval.json'), 'utf8'));
    assert.ok(written.decision.approvedAssets);

    const animatic = await resumeCustomer({ ...shared, decision: { decision: 'approve' } });
    assert.equal(animatic.state.status, 'awaiting-production');
    assert.ok(stills.some((still) => still.resolution === '2K' && still.prompt));

    const produced = await resumeCustomer({ ...shared, decision: { decision: 'approve' } });
    assert.ok(rendered.length > 0);
    assert.equal(produced.state.status, 'done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
