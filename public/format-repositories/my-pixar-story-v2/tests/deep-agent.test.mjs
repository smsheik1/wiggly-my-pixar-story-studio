import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { prepareRunWorkspace, workspaceAgent, makeSubmitTool, deepAgentInvoke, assetPath } from '../graph/deep-agent-node.mjs';
import { buildGraph } from '../graph/graph.mjs';

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

test('submit tool validates against the agent output schema: invalid args never submit and end the run with the schema error; valid args submit', () => tmp(async (runs) => {
  const { root } = await prepareRunWorkspace({ runsRoot: runs, runId: 's', agent: 'location-scout', input: {} });
  const bad = json(FIX['location-scout']); bad.locations[0].elementTag = '@Kitchen';
  const subs = [];
  const m1 = new ScriptedModel([
    () => call('read_file', { file_path: '/skills/location-scout/SKILL.md' }),
    (m) => { assert.match(lastText(m), /Location Scout/); return call('submit_location_scout', bad); },
  ]);
  const a1 = workspaceAgent(m1, root, 'openai:isolated-scripted-model', 'submit-bad', [makeSubmitTool('location-scout', subs)], 'x');
  const r1 = await a1.invoke({ messages: [{ role: 'user', content: 'go' }] }, { recursionLimit: 20 });
  assert.equal(subs.length, 0); assert.match(JSON.stringify(r1.messages.at(-1).content), /@Loc 1/);
  const m2 = new ScriptedModel([() => call('submit_location_scout', json(FIX['location-scout']))]);
  const a2 = workspaceAgent(m2, root, 'openai:isolated-scripted-model', 'submit-ok', [makeSubmitTool('location-scout', subs)], 'x');
  await a2.invoke({ messages: [{ role: 'user', content: 'go' }] }, { recursionLimit: 20 });
  assert.equal(subs.length, 1); assert.equal(subs[0].locations[0].elementTag, '@Loc 1');
  assert.equal(m2.calls.length, 1, 'returnDirect: no model turn after a valid submit');
}));

test('invalid submit inside the graph becomes retry notes, then the next attempt passes', () => tmp(async (runs) => {
  let lsRuns = 0; const notes = [];
  const createModel = async (_c, agent) => {
    let fx = json(FIX[agent]);
    if (agent === 'location-scout' && lsRuns++ === 0) fx.locations[0].elementTag = '@Kitchen';
    return new ScriptedModel([(m) => { notes.push([agent, JSON.stringify(m[0].content)]); return call(`submit_${agent.replaceAll('-', '_')}`, fx); }]);
  };
  const s = await buildGraph({ deepAgent: { createModel, runsRoot: runs, runId: 'retry' } }).invoke({ inputs: { answers: {} }, approvedAssets: assets() });
  assert.equal(s.status, 'done'); assert.equal(s.attempts['location-scout'], 2);
  const ln = notes.filter(([a]) => a === 'location-scout').map(([, t]) => t);
  assert.ok(ln.some((t) => /AGENT_RUN_FAILED/.test(t) && /@Loc/.test(t)));
}));

test('graph happy path through the deep-agent node (scripted model, zero network)', () => tmp(async (runs) => {
  const seen = [];
  const createModel = async (config, agent) => {
    seen.push([agent, config.model, config.effort]);
    return new ScriptedModel([
      () => call('read_file', { file_path: `/skills/${agent}/SKILL.md` }),
      () => call('read_file', { file_path: '/references/input.json' }),
      () => call(`submit_${agent.replaceAll('-', '_')}`, json(FIX[agent])),
    ]);
  };
  const g = buildGraph({ deepAgent: { createModel, runsRoot: runs, runId: 'happy' } });
  const s = await g.invoke({ inputs: { subject: 'Shaz', answers: { scene1Childhood: 'sunglasses scientist' } }, approvedAssets: assets() });
  assert.equal(s.status, 'done', JSON.stringify(s.escalations));
  assert.deepEqual(seen.map((x) => x[0]).sort(), ['character-architect', 'location-scout', 'seedance-compiler', 'story-director']);
  assert.ok(seen.every((x) => x[1] === 'meta/muse-spark-1.3-contributor' && x[2] === 'max'));
  assert.equal(s.seedanceCompiler.output.segments.length, 2);
  const m = JSON.parse(await readFile(join(runs, 'happy_attempt-1', 'seedance-compiler', 'references/approved-assets.json'), 'utf8'));
  assert.equal(m.length, 4);
  const sdInput = JSON.parse(await readFile(join(runs, 'happy_attempt-1', 'location-scout', 'references/input.json'), 'utf8'));
  assert.equal(sdInput.settings[0].name, 'Kitchen');
}));

test('deep agent that never submits counts as a failed attempt and escalates after 3', () => tmp(async (runs) => {
  const createModel = async () => new ScriptedModel([done]);
  const s = await buildGraph({ deepAgent: { createModel, runsRoot: runs, runId: 'nosubmit' } }).invoke({ inputs: { answers: {} } });
  assert.equal(s.status, 'failed'); assert.equal(s.escalations[0].agent, 'story-director');
  assert.ok(s.escalations[0].issues.some((i) => i.code === 'AGENT_RUN_FAILED' && /without calling submit/.test(i.message)));
}));
