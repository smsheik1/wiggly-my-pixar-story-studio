import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySaver, Command } from '@langchain/langgraph';
import { buildGraph, retryNotes, requiredAssetTags, makeAnimaticEditorNode } from '../graph/graph.mjs';
import { parseInitialState, statusReducer } from '../graph/state.mjs';
import { V2_MODELS } from '../config/models.mjs';
import { GOOD_ANSWERS } from './fixtures/good-answers.mjs';
import { draftStoryboard } from './fixtures/storyboard-draft.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const FIX = { 'story-director': 'good-stage-play.json', 'character-architect': 'good-master-renders.json', 'location-scout': 'good-location-plates.json', 'seedance-compiler': 'good-seedance-prompts.json' };
const initial = (extra = {}) => ({ inputs: { subject: 'Shaz', answers: GOOD_ANSWERS, targetTotalRuntimeSec: 60, settingSeed: 'suburban home' }, animaticApproval: { decision: 'approve' }, ...extra });
const assets = () => json('good-approved-assets.json');

/** Fake model: returns fixtures; `bad` maps agent -> number of leading bad attempts (or Infinity). Records every call. */
function fakeInvoke(bad = {}) {
  const calls = [];
  const fn = async (req) => {
    calls.push({ agent: req.agent, attempt: req.attempt, retryNotes: req.retryNotes, model: req.config.model, effort: req.config.effort, skill: req.skill.length, input: req.input });
    if (req.attempt <= (bad[req.agent] ?? 0)) {
      const o = json(FIX[req.agent]);
      if (req.agent === 'location-scout') o.locations[0].locationPlatePrompt.promptText += ' A boy sits at the table.';
      else if (req.agent === 'story-director') return '{not json';
      else if (req.agent === 'character-architect') o.characters[0].elementTag = '@Nobody';
      else o.segments[0].tenBlocks.block6_visualStyle += ' Render in 1080p.';
      return JSON.stringify(o);
    }
    if (req.agent === 'storyboard-artist') return JSON.stringify(draftStoryboard(req.input));
    if (req.agent === 'seedance-compiler') {
      const txt = JSON.stringify(json(FIX[req.agent]));
      return Object.entries(json('good-approved-assets.json')).reduce((t, [tag, k]) => {
        const approvedKey = req.input?.references?.find((r) => r.sourceTag === tag)?.assetKey;
        return approvedKey ? t.split(k).join(approvedKey) : t;
      }, txt);
    }
    return JSON.stringify(json(FIX[req.agent]));
  };
  fn.calls = calls;
  return fn;
}

test('happy path: all five agents run, Muse Spark 1.3 max, status done, outputs in their slots', async () => {
  const invoke = fakeInvoke();
  const s = await buildGraph({ invoke }).invoke(initial({ approvedAssets: assets() }));
  assert.equal(s.status, 'done', JSON.stringify(s.escalations));
  assert.deepEqual(invoke.calls.map((c) => c.agent).sort(), ['character-architect', 'location-scout', 'seedance-compiler', 'story-director', 'storyboard-artist']);
  assert.ok(invoke.calls.every((c) => c.model === V2_MODELS[c.agent]?.model && c.effort === V2_MODELS[c.agent]?.effort && c.skill > 500));
  assert.ok(s.storyDirector.segments.length === 2 && s.characterArchitect.output.characters.length === 3);
  assert.equal(s.locationScout.output.locations[0].elementTag, '@Loc 1');
  assert.equal(s.seedanceCompiler.output.segments[0].generationPayload.resolution, '480p');
  assert.deepEqual(s.attempts, { 'story-director': 1, 'character-architect': 1, 'location-scout': 1, 'storyboard-artist': 1, 'seedance-compiler': 1 });
});
test('both parallel branches run after the Story Director and before the compiler; inputs are their own slices', async () => {
  const invoke = fakeInvoke();
  await buildGraph({ invoke }).invoke(initial({ approvedAssets: assets() }));
  const order = invoke.calls.map((c) => c.agent);
  assert.equal(order[0], 'story-director'); assert.equal(order[3], 'storyboard-artist'); assert.equal(order[4], 'seedance-compiler');
  assert.deepEqual(order.slice(1, 3).sort(), ['character-architect', 'location-scout']);
  const ls = invoke.calls.find((c) => c.agent === 'location-scout').input;
  assert.ok(!('cast' in ls) && ls.settings[0].name === 'Kitchen');
  assert.ok('cast' in invoke.calls.find((c) => c.agent === 'character-architect').input);
});
test('retry then pass: gate issues are fed into the retry prompt', async () => {
  const invoke = fakeInvoke({ 'location-scout': 1, 'story-director': 1 });
  const s = await buildGraph({ invoke }).invoke(initial({ approvedAssets: assets() }));
  assert.equal(s.status, 'done');
  assert.equal(s.attempts['location-scout'], 2); assert.equal(s.attempts['story-director'], 2);
  const retry = invoke.calls.find((c) => c.agent === 'location-scout' && c.attempt === 2).retryNotes;
  assert.match(retry, /HUMAN_FIGURE_IN_BACKGROUND/);
  assert.match(invoke.calls.find((c) => c.agent === 'story-director' && c.attempt === 2).retryNotes, /SCHEMA_REJECTED/);
});
test('3 failures escalate and stop the graph (no compiler call)', async () => {
  const invoke = fakeInvoke({ 'character-architect': Infinity });
  const s = await buildGraph({ invoke }).invoke(initial({ approvedAssets: assets() }));
  assert.equal(s.status, 'failed');
  assert.equal(invoke.calls.filter((c) => c.agent === 'character-architect').length, 3);
  assert.ok(!invoke.calls.some((c) => c.agent === 'seedance-compiler'));
  assert.equal(s.escalations[0].agent, 'character-architect'); assert.ok(s.escalations[0].issues.some((i) => i.code === 'TAG_PARITY'));
  assert.ok(s.locationScout.output, 'sibling branch output still merged');
});
test('compiler escalation after 3 bad prompts', async () => {
  const invoke = fakeInvoke({ 'seedance-compiler': Infinity });
  const s = await buildGraph({ invoke }).invoke(initial({ approvedAssets: assets() }));
  assert.equal(s.status, 'failed'); assert.ok(s.escalations[0].issues.some((i) => i.code === 'WRONG_RESOLUTION'));
});
test('missing approvedAssets halts at the approval gate', async () => {
  const invoke = fakeInvoke();
  const s = await buildGraph({ invoke }).invoke(initial());
  assert.equal(s.status, 'awaiting-approval');
  assert.deepEqual(s.pendingApproval, ['@Image 1', '@Image 2', '@Image 3', '@Loc 1']);
  assert.ok(!invoke.calls.some((c) => c.agent === 'seedance-compiler'));
  const p = assets(); delete p['@Loc 1'];
  const s2 = await buildGraph({ invoke: fakeInvoke() }).invoke(initial({ approvedAssets: p }));
  assert.deepEqual(s2.pendingApproval, ['@Loc 1']);
});
test('human interrupt: pauses for approval, resumes with approvedAssets, finishes', async () => {
  const invoke = fakeInvoke();
  const g = buildGraph({ invoke, useInterrupt: true, checkpointer: new MemorySaver() });
  const cfg = { configurable: { thread_id: 't1' } };
  const s1 = await g.invoke(initial(), cfg);
  assert.ok(s1.__interrupt__?.[0]?.value?.missing?.length === 4);
  assert.ok(!invoke.calls.some((c) => c.agent === 'seedance-compiler'));
  const s2 = await g.invoke(new Command({ resume: { approvedAssets: assets() } }), cfg);
  assert.equal(s2.status, 'done'); assert.deepEqual(s2.approvedAssets, assets());
});
test('human interrupt resumes cleanly when approvedAssets is an array of tag strings', async () => {
  const invoke = fakeInvoke();
  const g = buildGraph({ invoke, useInterrupt: true, checkpointer: new MemorySaver() });
  const cfg = { configurable: { thread_id: 't2' } };
  const s1 = await g.invoke(initial({ assetFiles: assets() }), cfg);
  assert.ok(s1.__interrupt__?.[0]?.value?.missing?.length === 4);
  const tags = ['@Image 1', '@Image 2', '@Image 3', '@Loc 1'];
  const s2 = await g.invoke(new Command({ resume: { approvedAssets: tags } }), cfg);
  assert.equal(s2.status, 'done');
  assert.deepEqual(s2.approvedAssets, assets());
});
test('human interrupt resumes cleanly when approvedAssets contains file paths or URLs, storing canonical asset keys', async () => {
  const invoke = fakeInvoke();
  const g = buildGraph({ invoke, useInterrupt: true, checkpointer: new MemorySaver() });
  const cfg = { configurable: { thread_id: 't3' } };
  const s1 = await g.invoke(initial({ assetFiles: { '@Image 1': '/tmp/image1.png', '@Image 2': '/tmp/image2.png', '@Image 3': '/tmp/image3.png', '@Loc 1': '/tmp/loc1.png' } }), cfg);
  assert.ok(s1.__interrupt__?.[0]?.value?.missing?.length === 4);
  const dirtyApprovals = {
    '@Image 1': '/tmp/image1.png',
    '@Image 2': 'https://wiggly.agentenamel.com/api/mcp/renders/Image2.png',
    '@Image 3': '/tmp/image3.png',
    '@Loc 1': '/tmp/loc1.png',
  };
  const s2 = await g.invoke(new Command({ resume: { approvedAssets: dirtyApprovals } }), cfg);
  assert.equal(s2.status, 'done');
  for (const [tag, key] of Object.entries(s2.approvedAssets)) {
    assert.match(key, /^[A-Za-z0-9][\w.:-]*$/, `key for ${tag} must be local asset key`);
    assert.ok(!key.includes('/'), `key for ${tag} must not contain slashes`);
    assert.ok(!key.startsWith('http'), `key for ${tag} must not be a URL`);
  }
});
test('parallel outputs merge without clobbering; reducers', async () => {
  const s = await buildGraph({ invoke: fakeInvoke() }).invoke(initial({ approvedAssets: assets(), locationScout: { hints: { Kitchen: { singleSignText: 'LAB' } } } }));
  assert.ok(s.locationScout.hints && s.locationScout.output, 'hints and output coexist');
  assert.deepEqual(Object.keys(s.gateIssues).sort(), ['character-architect', 'location-scout', 'seedance-compiler', 'story-director', 'storyboard-artist']);
  assert.equal(statusReducer('failed', 'done'), 'failed'); assert.equal(statusReducer('running', 'awaiting-approval'), 'awaiting-approval');
  assert.deepEqual(requiredAssetTags(s), ['@Image 1', '@Image 2', '@Image 3', '@Loc 1']);
});
test('selector failure escalates immediately; buildGraph needs invoke; state schema rejects URL assets', async () => {
  const s = await buildGraph({ invoke: fakeInvoke() }).invoke({ inputs: { answers: 'nope' } });
  assert.equal(s.status, 'failed'); assert.equal(s.escalations[0].issues[0].code, 'INPUT_SELECTOR_FAILED');
  assert.throws(() => buildGraph({ invoke: 42 }), /invoke must be a function/);
  assert.throws(() => parseInitialState(initial({ approvedAssets: { '@Image 1': 'https://x.example/a.png' } })));
  assert.equal(parseInitialState(initial()).status, 'running');
  assert.equal(retryNotes([]), '');
});

test('makeAnimaticEditorNode: compiles animatic video, writes approvedShotTimings, and records animatic-video in assetFiles', async () => {
  const d = mkdtempSync(join(tmpdir(), 'anim-node-'));
  const stagePlay = json(FIX['story-director']);
  const state = {
    storyDirector: stagePlay,
    assetFiles: {
      '1.1': join(d, '1.1.png'),
    },
  };
  const node = makeAnimaticEditorNode({ runDir: d });
  const result = await node(state);

  assert.ok(Array.isArray(result.approvedShotTimings), 'must output approvedShotTimings');
  assert.ok(result.approvedShotTimings.length > 0, 'must have shots in approvedShotTimings');
  assert.equal(result.assetFiles['animatic-video'], join(d, 'animatic_preview.mp4'));
  assert.equal(result.animaticVideo, join(d, 'animatic_preview.mp4'));
  assert.ok(existsSync(join(d, 'animatic_preview.mp4')), 'animatic_preview.mp4 must exist on disk');
});
