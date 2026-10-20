import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { prepareRunWorkspace, workspaceAgent, makeSubmitTool, deepAgentInvoke, assetPath, dropDisallowedNulls } from '../graph/deep-agent-node.mjs';
import { StoryDirectorOutputSchema } from '../crew/story-director/schema.mjs';
import { buildGraph } from '../graph/graph.mjs';
import { GOOD_ANSWERS } from './fixtures/good-answers.mjs';

// Explicit isolated mock (same idea as v1 studio-spike offline-model.ts): proves harness mechanics only.
class ScriptedModel extends BaseChatModel {
  constructor(script) { super({}); this.modelName = 'isolated-scripted-model'; this.script = script; this.calls = []; this.toolNames = []; }
  getName() { return 'ChatOpenAI'; }
  _llmType() { return 'isolated-scripted-test'; }
  bindTools(tools) { this.toolNames = tools.map((t) => t.name); return this; }
  async _generate(messages) {
    this.calls.push(messages);
    const step = this.script.shift();
    assert.ok(step, 'model called after expected termination');
    return { generations: [{ text: '', message: step(messages) }] };
  }
}
const call = (name, args, id = name + Math.random().toString(36).slice(2, 7)) => new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });
const done = () => new AIMessage('Done');
const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const FIX = { 'story-director': 'good-stage-play.json', 'character-architect': 'good-master-renders.json', 'location-scout': 'good-location-plates.json', 'seedance-compiler': 'good-seedance-prompts.json' };
const assets = () => json('good-approved-assets.json');
async function tmp(run) { const d = await mkdtemp(join(tmpdir(), 'wiggly-v2-runs-')); try { await run(d); } finally { await rm(d, { recursive: true, force: true }); } }
const lastText = (m) => JSON.stringify(m.at(-1)?.content);

test('run workspace layout: drafts/references/versions/skills, SKILL.md = role.md, approved assets in /references', () => tmp(async (runs) => {
  const photo = join(runs, 'plate.png'); await writeFile(photo, 'png-bytes');
  const { root, manifest } = await prepareRunWorkspace({ runsRoot: runs, runId: 'r1', agent: 'seedance-compiler', input: { a: 1 },
    approvedAssets: assets(), assetFiles: { 'asset:location-plate:kitchen-v1': photo } });
  assert.equal(root, join(runs, 'r1', 'seedance-compiler'));
  for (const d of ['drafts', 'references', 'versions', 'skills/seedance-compiler']) assert.ok((await stat(join(root, d))).isDirectory(), d);
  assert.match(await readFile(join(root, 'skills/seedance-compiler/SKILL.md'), 'utf8'), /name: seedance-compiler/);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'references/input.json'), 'utf8')), { a: 1 });
  const m = JSON.parse(await readFile(join(root, 'references/approved-assets.json'), 'utf8'));
  assert.deepEqual(m, manifest); assert.equal(m.length, 4);
  assert.ok(m.every((x) => x.path.startsWith('/references/assets/') && !/https?:/.test(x.path)));
  assert.equal(m.find((x) => x.tag === '@Loc 1').path, assetPath('asset:location-plate:kitchen-v1', '.png'));
  assert.equal(await readFile(join(root, m.find((x) => x.tag === '@Loc 1').path.slice(1)), 'utf8'), 'png-bytes');
  await assert.rejects(prepareRunWorkspace({ runsRoot: runs, runId: 'r2', agent: 'location-scout', approvedAssets: { '@Loc 1': 'https://x.example/a.png' } }), /not a URL/);
}));

test('permissions: writes outside /drafts and reads outside the mounts are denied; drafts writable; tools exclude task/execute', () => tmp(async (runs) => {
  const { root } = await prepareRunWorkspace({ runsRoot: runs, runId: 'p', agent: 'location-scout', input: {} });
  await writeFile(join(root, 'versions/locked.txt'), 'LOCKED');
  await writeFile(join(root, 'secrets.env'), 'DUMMY_SECRET_NEVER_TO_MODEL');
  const model = new ScriptedModel([
    () => call('write_file', { file_path: '/versions/new.txt', content: 'bad' }),
    () => call('write_file', { file_path: '/references/input.json', content: 'bad' }),
    () => call('write_file', { file_path: '/skills/location-scout/SKILL.md', content: 'bad' }),
    () => call('read_file', { file_path: '/secrets.env' }),
    (m) => { assert.match(lastText(m), /denied|permission/i); return call('read_file', { file_path: '/references/input.json' }); },
    () => call('write_file', { file_path: '/drafts/notes.txt', content: 'permitted' }),
    (m) => { assert.ok(!JSON.stringify(m).includes('DUMMY_SECRET_NEVER_TO_MODEL')); return done(); },
  ]);
  const agent = workspaceAgent(model, root, 'openai:isolated-scripted-model', 'perm-test', [], 'Isolated permission test.');
  const res = await agent.invoke({ messages: [{ role: 'user', content: 'go' }] }, { recursionLimit: 30 });
  assert.equal(await readFile(join(root, 'versions/locked.txt'), 'utf8'), 'LOCKED');
  await assert.rejects(readFile(join(root, 'versions/new.txt')));
  assert.equal(await readFile(join(root, 'references/input.json'), 'utf8'), '{}');
  assert.match(await readFile(join(root, 'skills/location-scout/SKILL.md'), 'utf8'), /name: location-scout/);
  assert.equal(await readFile(join(root, 'drafts/notes.txt'), 'utf8'), 'permitted');
  const denied = res.messages.filter((x) => x.type === 'tool' && /denied|permission/i.test(JSON.stringify(x.content)));
  assert.equal(denied.length, 4);
  assert.ok(!model.toolNames.includes('task') && !model.toolNames.includes('execute'));
}));

test('invalid submit returns exact Zod paths to the agent, which resubmits within the same attempt; valid submit ends the run', () => tmp(async (runs) => {
  const bad = json(FIX['location-scout']); bad.locations[0].elementTag = '@Kitchen';
  let seen = '';
  const m = new ScriptedModel([
    () => call('read_file', { file_path: '/skills/location-scout/SKILL.md' }),
    () => call('submit_location_scout', bad),
    (msgs) => { seen = lastText(msgs); return call('submit_location_scout', json(FIX['location-scout'])); },
  ]);
  const out = await deepAgentInvoke({ finalReview: false, storyBeats: false, createModel: async () => m, runsRoot: runs, runId: 'same' })({ agent: 'location-scout', config: { model: 'isolated-scripted-model' }, input: {}, attempt: 1 });
  assert.match(seen, /SUBMISSION REJECTED \(1\/3\)/); assert.match(seen, /locations\.0\.elementTag/);
  assert.equal(out.locations[0].elementTag, '@Loc 1');
  assert.equal(m.calls.length, 3, 'no model turn after the valid submit');
}));

test('3 invalid submits in one attempt -> attempt fails with the specific Zod issues in retry notes; next attempt passes', () => tmp(async (runs) => {
  let lsRuns = 0; const notes = [];
  const createModel = async (_c, agent) => {
    const fx = json(FIX[agent]);
    const name = `submit_${agent.replaceAll('-', '_')}`;
    if (agent === 'location-scout' && lsRuns++ === 0) { fx.locations[0].elementTag = '@Kitchen'; return new ScriptedModel([0, 1, 2].map(() => () => call(name, fx))); }
    return new ScriptedModel([(m) => { notes.push([agent, JSON.stringify(m[0].content)]); return call(name, fx); }]);
  };
  // reflectionRounds: 0 keeps this test about submit retries only (reflection has its own tests in reflection.test.mjs).
  const s = await buildGraph({ deepAgent: { finalReview: false, storyBeats: false, createModel, runsRoot: runs, runId: 'retry', reflectionRounds: 0 } }).invoke({ inputs: { answers: {}, targetTotalRuntimeSec: 60 }, approvedAssets: assets() });
  assert.equal(s.status, 'done'); assert.equal(s.attempts['location-scout'], 2);
  const logged = s.validationErrors.find((v) => v.node === 'location-scout').errors;
  assert.ok(logged.every((i) => i.code === 'SCHEMA_REJECTED')); assert.ok(logged.some((i) => i.path === 'locations.0.elementTag'));
  const ln = notes.filter(([a]) => a === 'location-scout').map(([, t]) => t);
  assert.ok(ln.some((t) => /SCHEMA_REJECTED/.test(t) && /locations\.0\.elementTag/.test(t)));
}));

test('r4-dry1 regression: Muse sent null for optional shot fields; tool schema accepts it and the submit validates', () => tmp(async () => {
  // Recorded before finaleThesis, line sources, answerSources and the shot locks (scenes, onScreen) were required; add them so
  // the test still isolates the null-tolerance behaviour.
  const args = { ...json('r4-dry1-story-director-submit-args.json'), finaleThesis: 'One plain sentence naming the finale idea.' };
  args.segments = args.segments.map((seg) => ({ ...seg, answerSources: ['scene1Childhood.memory'], scenes: [{ shots: seg.shots.map((sh) => sh.shotNumber), present: [] }],
    shots: seg.shots.map((sh) => ({ ...Object.fromEntries(Object.entries(sh).map(([k, v]) => [k, (k === 'dialogue' || k === 'narration') && v ? { ...v, source: { answer: 'scene1Childhood.memory', kind: 'paraphrase' } } : v])), onScreen: [] })) }));
  assert.equal(StoryDirectorOutputSchema.safeParse(args).success, false, 'raw args fail Zod (null on optional fields)');
  const subs = []; const t = makeSubmitTool('story-director', subs);
  assert.match(await t.invoke(args), /submitted/); assert.equal(subs.length, 1);
  assert.ok(!('tag' in subs[0].segments[0].shots[0]));
  const shot = t.schema.properties.segments.items.properties.shots.items.properties;
  assert.ok(shot.tag.anyOf.some((b) => b.type === 'null') && shot.dialogue.anyOf.some((b) => b.type === 'null'));
  // nullable fields keep their null (Seedance extendsFrom)
  assert.equal(dropDisallowedNulls({ a: null, b: null }, { properties: { a: { type: ['integer', 'null'] }, b: { type: 'string' } } }).a, null);
}));

test('graph happy path through the deep-agent node (scripted model, zero network)', () => tmp(async (runs) => {
  const seen = [];
  const createModel = async (config, agent) => {
    seen.push([agent, config.model, config.effort]);
    const name = `submit_${agent.replaceAll('-', '_')}`;
    // The Story Director runs its default 2 self-critique rounds (critique reply + resubmit, twice). Inside the graph each
    // deep-agent run takes one extra turn after its submit, so every SD step answers a critique with text and anything else with a submit.
    const sdStep = (m) => (/reviewing your own draft/.test(String(m[0]?.content)) ? new AIMessage('1. Minor: shot 2 action is vague. VERDICT: REVISE')
      : m.at(-1)?.getType?.() === 'tool' ? done() : call(name, json(FIX[agent])));
    const reflect = agent === 'story-director' ? Array.from({ length: 8 }, () => sdStep) : [];
    return new ScriptedModel([
      () => call('read_file', { file_path: `/skills/${agent}/SKILL.md` }),
      () => call('read_file', { file_path: '/references/input.json' }),
      () => call(name, json(FIX[agent])),
      ...reflect,
    ]);
  };
  const g = buildGraph({ deepAgent: { finalReview: false, storyBeats: false, createModel, runsRoot: runs, runId: 'happy' } });
  const s = await g.invoke({ inputs: { subject: 'Shaz', answers: GOOD_ANSWERS, targetTotalRuntimeSec: 60 }, approvedAssets: assets() });
  assert.equal(s.status, 'done', JSON.stringify(s.escalations));
  assert.deepEqual(seen.map((x) => x[0]).sort(), ['character-architect', 'location-scout', 'seedance-compiler', 'story-director']);
  assert.ok(seen.every((x) => x[1] === (x[0] === 'story-director' ? 'anthropic/claude-haiku-5.5' : 'meta/muse-spark-1.3-contributor') && x[2] === (x[0] === 'story-director' ? 'high' : 'xhigh')));
  assert.equal(s.seedanceCompiler.output.segments.length, 2);
  const m = JSON.parse(await readFile(join(runs, 'happy_attempt-1', 'seedance-compiler', 'references/approved-assets.json'), 'utf8'));
  assert.equal(m.length, 4);
  const sdInput = JSON.parse(await readFile(join(runs, 'happy_attempt-1', 'location-scout', 'references/input.json'), 'utf8'));
  assert.equal(sdInput.settings[0].name, 'Kitchen');
  assert.equal(s.reflections['story-director'][0].log.length, 2);
  assert.equal(s.reflections['character-architect'], undefined);
}));

test('deep agent that never submits counts as a failed attempt and escalates after 3', () => tmp(async (runs) => {
  const createModel = async () => new ScriptedModel([done, done]);
  const s = await buildGraph({ deepAgent: { finalReview: false, storyBeats: false, createModel, runsRoot: runs, runId: 'nosubmit' } }).invoke({ inputs: { answers: {}, targetTotalRuntimeSec: 60 } });
  assert.equal(s.status, 'failed'); assert.equal(s.escalations[0].agent, 'story-director');
  assert.ok(s.escalations[0].issues.some((i) => i.code === 'AGENT_RUN_FAILED' && /without calling submit/.test(i.message)));
}));

test('r4-dry5 regression: SC segment 1 omitted extendsFrom -> defaults to null; schema issues carry the field path', async () => {
  const [, omitted, zero] = json('r4-dry5-seedance-submit-args.json');
  const subs = []; const t = makeSubmitTool('seedance-compiler', subs, { maxInvalid: 5 });
  const r1 = await t.invoke(omitted);
  assert.ok(!/extendsFrom/.test(r1), r1.slice(0, 400));
  const r2 = await t.invoke(zero);
  assert.match(r2, /segments\.0\.extendsFrom: Too small/);
});
