import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGraph, requiredAssetTags } from '../graph/graph.mjs';
import { makeProductionApprovalNode, makeProducerNode, makeAssemblyNode, upscaleClipWithReplicate, renderClipWithReplicate } from '../graph/producer.mjs';
import { generatePropTurnaroundPrompt } from '../crew/prop-architect/extract-props.mjs';
import { selectSeedanceCompilerInput } from '../crew/seedance-compiler/input.mjs';
import { GOOD_ANSWERS } from './fixtures/good-answers.mjs';
import { draftStoryboard } from './fixtures/storyboard-draft.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const FIX = {
  'story-director': 'good-stage-play.json',
  'character-architect': 'good-master-renders.json',
  'location-scout': 'good-location-plates.json',
  'seedance-compiler': 'good-seedance-prompts.json',
};
const assets = () => json('good-approved-assets.json');

function fakeInvoke() {
  return async (req) => {
    if (req.agent === 'storyboard-artist') return JSON.stringify(draftStoryboard(req.input));
    return JSON.stringify(json(FIX[req.agent]));
  };
}

test('Producer node renders clips and returns renderedClips array', async () => {
  const renderedCalls = [];
  const fakeRender = async ({ clip, duration }) => {
    renderedCalls.push(clip.segmentId);
    return {
      clipId: clip.segmentId,
      videoPath: `/tmp/fake-clip-${clip.segmentId}.mp4`,
      durationSec: duration,
      predictionId: `pred_${clip.segmentId}`,
      costUsd: 1.50,
    };
  };

  const producerNode = makeProducerNode({ renderClip: fakeRender });
  const fakeState = {
    seedanceCompiler: {
      output: {
        segments: [
          { segmentId: 1, totalDurationSec: 19, generationPayload: { durationSec: 19 } },
          { segmentId: 2, totalDurationSec: 30, generationPayload: { durationSec: 30 } },
        ],
      },
    },
  };

  const res = await producerNode(fakeState);
  assert.equal(res.renderedClips.length, 2);
  assert.deepEqual(renderedCalls, [1, 2]);
  assert.equal(res.renderedClips[0].videoPath, '/tmp/fake-clip-1.mp4');
  assert.equal(res.renderedClips[1].durationSec, 30);
});

test('Assembly node aggregates rendered clips into masterVideo with duration', async () => {
  const assemblyNode = makeAssemblyNode({ runDir: '/tmp' });
  const state = {
    renderedClips: [
      { clipId: 1, videoPath: '/tmp/clip1.mp4', durationSec: 19.0 },
      { clipId: 2, videoPath: '/tmp/clip2.mp4', durationSec: 30.0 },
    ],
  };

  const res = await assemblyNode(state);
  assert.equal(res.status, 'done');
  assert.ok(res.masterVideo);
  assert.equal(res.masterVideo.durationSec, 49.0);
  assert.match(res.masterVideo.videoPath, /master-video\.mp4/);
});

test('upscaleClipWithReplicate invokes bytedance/video-upscaler with scene aigc', async () => {
  const fakeFetch = async (url, opts) => {
    if (url.includes('/predictions') && opts?.method === 'POST') {
      const body = JSON.parse(opts.body);
      assert.equal(body.input.scene, 'aigc');
      assert.equal(body.input.target_resolution, '1080p');
      assert.equal(body.input.video, 'https://cdn.example.com/clip.mp4');
      return {
        ok: true,
        json: async () => ({ id: 'pred_upscale_123', status: 'succeeded', output: 'https://cdn.example.com/upscaled-1080p.mp4' }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  const res = await upscaleClipWithReplicate({
    inputVideoUrl: 'https://cdn.example.com/clip.mp4',
    apiKey: 'test-key',
    targetResolution: '1080p',
    fetchFn: fakeFetch,
  });

  assert.equal(res.predictionId, 'pred_upscale_123');
  assert.equal(res.outputVideoUrl, 'https://cdn.example.com/upscaled-1080p.mp4');
  assert.equal(res.targetResolution, '1080p');
});

test('generatePropTurnaroundPrompt produces 4-view 3D model sheet instructions', () => {
  const prop = { name: '2000 Honda Accord Coupe', description: 'silver 2-door coupe' };
  const prompt = generatePropTurnaroundPrompt(prop, ['https://cdn.example.com/car.jpg']);
  assert.match(prompt, /Multi-angle model sheet/i);
  assert.match(prompt, /2000 Honda Accord Coupe/);
  assert.match(prompt, /front 3\/4 view, side profile, and rear 3\/4 view/i);
  assert.match(prompt, /Matching real-life reference photos/i);
});

test('selectSeedanceCompilerInput binds heroProps into references array', () => {
  const baseState = {
    storyDirector: json('good-stage-play.json'),
    characterArchitect: { output: json('good-master-renders.json') },
    locationScout: { output: json('good-location-plates.json') },
    approvedAssets: {
      ...assets(),
      '@Prop 1': 'asset:prop-sheet:2000-honda-accord',
    },
    heroProps: [
      {
        propTag: '@Prop 1',
        elementTag: '@2000_honda_accord',
        name: '2000 Honda Accord',
        description: 'silver 2-door coupe parked in driveway',
        assetKey: 'asset:prop-sheet:2000-honda-accord',
      },
    ],
  };

  const input = selectSeedanceCompilerInput(baseState);
  assert.ok(input.references.some((r) => r.type === 'prop' && r.tag === '@2000_honda_accord' && r.sourceTag === '@Prop 1'));
});

test('Full Graph with production: true runs through producer and assembly to masterVideo', async () => {
  const invoke = fakeInvoke();
  const mockRender = async ({ clip, duration }) => ({
    clipId: clip.segmentId,
    videoPath: `/tmp/mock-clip-${clip.segmentId}.mp4`,
    durationSec: duration,
    predictionId: `pred_test_${clip.segmentId}`,
    costUsd: 2.0,
  });

  const graph = buildGraph({
    invoke,
    production: true,
    autoApproveProduction: true,
    renderClip: mockRender,
    runDir: '/tmp',
  });

  const initialState = {
    inputs: { subject: 'Shaz', answers: GOOD_ANSWERS, targetTotalRuntimeSec: 60, settingSeed: 'suburban home' },
    animaticApproval: { decision: 'approve' },
    approvedAssets: assets(),
  };

  const finalState = await graph.invoke(initialState);
  assert.equal(finalState.status, 'done', JSON.stringify(finalState.escalations));
  assert.ok(finalState.renderedClips?.length > 0, 'renderedClips should be populated');
  assert.ok(finalState.masterVideo, 'masterVideo should be populated');
  assert.ok(finalState.masterVideo.durationSec > 0, 'durationSec should be positive');
  assert.equal(finalState.masterVideo.resolution, '1920x1080');
});
