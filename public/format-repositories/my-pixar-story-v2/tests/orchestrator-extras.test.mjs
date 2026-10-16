import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v2 from '../index.mjs';
import { buildGraph, gateCharacters, statusReducer, assembleCompiledPrompt, BLOCK_HEADERS, parseSeedancePrompts, makeSubmitTool } from '../index.mjs';
import { runRehearsal, inputsFromProject } from '../scripts/run-rehearsal.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const FIX = { 'story-director': 'good-stage-play.json', 'character-architect': 'good-master-renders.json', 'location-scout': 'good-location-plates.json', 'seedance-compiler': 'good-seedance-prompts.json' };
const initial = (extra = {}) => ({ inputs: { subject: 'Shaz', answers: { scene1Childhood: 'sunglasses scientist' } }, ...extra });
const fake = (override = {}) => { const calls = []; const fn = async (r) => { calls.push(r); const o = override[r.agent]; if (o) return o(r); return JSON.stringify(json(FIX[r.agent])); }; fn.calls = calls; return fn; };

test('5: agent fails once then passes -> retryCounts exactly 1, validationErrors logged once', async () => {
  const s = await buildGraph({ invoke: fake({ 'location-scout': (r) => { const o = json(FIX['location-scout']); if (r.attempt === 1) o.locations[0].locationPlatePrompt.promptText += ' A boy sits at the table.'; return JSON.stringify(o); } }) })
    .invoke(initial({ approvedAssets: json('good-approved-assets.json') }));
  assert.equal(s.status, 'done'); assert.equal(s.retryCounts['location-scout'], 1); assert.equal(s.retryCounts['story-director'], 0);
  const log = s.validationErrors.filter((v) => v.node === 'location-scout');
  assert.equal(log.length, 1); assert.equal(log[0].attempt, 1); assert.ok(log[0].errors.length && !Number.isNaN(Date.parse(log[0].timestamp)));
});
test('1: 3 exhausted attempts -> status failed + escalation + 3 log entries; failed wins in reducer', async () => {
  const s = await buildGraph({ invoke: fake({ 'story-director': () => '{bad' }) }).invoke(initial());
  assert.equal(s.status, 'failed'); assert.equal(s.escalations[0].agent, 'story-director'); assert.equal(s.retryCounts['story-director'], 2);
  assert.deepEqual(s.validationErrors.map((v) => v.attempt), [1, 2, 3]);
  for (const st of ['running', 'done', 'awaiting-approval', 'escalated']) { assert.equal(statusReducer('failed', st), 'failed'); assert.equal(statusReducer(st, 'failed'), 'failed'); }
});
for (const agent of Object.keys(FIX)) {
  test(`2: ${agent} model throw counts as an attempt, message fed back`, async () => {
    const s = await buildGraph({ invoke: fake({ [agent]: (r) => { if (r.attempt === 1) throw new Error('upstream 503 boom'); return JSON.stringify(json(FIX[agent])); } }) })
      .invoke(initial({ approvedAssets: json('good-approved-assets.json') }));
    assert.equal(s.status, 'done'); assert.equal(s.attempts[agent], 2); assert.equal(s.retryCounts[agent], 1);
    assert.match(s.validationErrors.find((v) => v.node === agent).errors[0].message, /upstream 503 boom/);
  });
}
test('2: retry prompt carries the thrown message', async () => {
  const inv = fake({ 'story-director': (r) => { if (r.attempt === 1) throw new Error('timeout xyz'); return JSON.stringify(json(FIX['story-director'])); } });
  await buildGraph({ invoke: inv }).invoke(initial());
  assert.match(inv.calls.find((c) => c.agent === 'story-director' && c.attempt === 2).retryNotes, /timeout xyz/);
});
test('3: per-character gate prefixes errors with the character name', () => {
  const ca = json(FIX['character-architect']); const name = ca.characters[1].name;
  ca.characters[1].masterRenderPrompt.promptText += ' Shot on a 35mm lens with bokeh.';
  const r = gateCharacters(ca, json(FIX['story-director']));
  assert.equal(r.isValid, false); assert.ok(r.errors.every((e) => e.startsWith(`${name}: `)), r.errors.join('\n'));
});
test('3: one bad character keeps the others; retry merges only the failed one', async () => {
  const good = json(FIX['character-architect']); const keepTag = good.characters[0].elementTag;
  const inv = fake({ 'character-architect': (r) => {
    const o = json(FIX['character-architect']);
    if (r.attempt === 1) { o.characters[1].masterRenderPrompt.promptText += ' Shot on a 35mm lens with bokeh.'; o.characters[0].name += ' KEPT'; }
    else o.characters[0].name += ' REDONE';
    return JSON.stringify(o);
  } });
  const s = await buildGraph({ invoke: inv }).invoke(initial({ approvedAssets: json('good-approved-assets.json') }));
  const c0 = s.characterArchitect.output.characters.find((c) => c.elementTag === keepTag);
  assert.match(c0.name, /KEPT$/); assert.equal(s.retryCounts['character-architect'], 1);
  assert.equal(s.characterArchitect.output.characters.length, good.characters.length);
});
test('4: compiledPrompt is assembled in code from 10 ordered blocks', () => {
  const d = json(FIX['seedance-compiler']); d.segments.forEach((s) => { delete s.compiledPrompt; });
  const p = parseSeedancePrompts(d).segments[0].compiledPrompt;
  const idx = BLOCK_HEADERS.map((h) => p.indexOf(h)); assert.ok(idx.every((x, i) => x >= 0 && (i === 0 || x > idx[i - 1])));
  assert.equal(p, assembleCompiledPrompt(d.segments[0].tenBlocks));
});
test('4: submit tool accepts blocks without compiledPrompt and assembles it', async () => {
  const subs = []; const t = makeSubmitTool('seedance-compiler', subs);
  const d = json(FIX['seedance-compiler']); d.segments.forEach((s) => { delete s.compiledPrompt; });
  await t.invoke(d); assert.ok(subs[0].segments[0].compiledPrompt.startsWith(BLOCK_HEADERS[0]));
});
test('6: barrel exports builder, state, nodes, schemas, gates', () => {
  for (const k of ['buildGraph', 'makeAgentNode', 'PipelineAnnotation', 'PipelineStateSchema', 'deepAgentInvoke', 'parseStagePlay', 'parseCharacterSheets', 'parseLocationPlates', 'parseSeedancePrompts', 'validateCharacterSheets', 'validateLocationPlates'])
    assert.ok(k in v2, k);
});
test('7: rehearsal runner with injected fake stops at approval and saves outputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-reh-'));
  try {
    const proj = join(root, 'project.json');
    writeFileSync(proj, JSON.stringify({ inputs: { subject: { preferredName: 'Shaz', recipientName: 'Mia', relationshipToRecipient: 'parent' }, answers: { scene1Childhood: { memory: 'sunglasses scientist' } } } }));
    const lines = []; const { state, dir } = await runRehearsal({ projectPath: proj, runId: 'r1', runsRoot: root, invoke: fake(), secrets: {}, tracing: null, trackerPath: null, log: (l) => lines.push(l) });
    assert.equal(state.status, 'awaiting-approval');
    for (const a of ['story-director', 'character-architect', 'location-scout']) assert.ok(existsSync(join(dir, `${a}.json`)), a);
    assert.ok(!existsSync(join(dir, 'seedance-compiler.json')));
    assert.ok(lines.some((l) => /awaiting approval for: @Image 1/.test(l)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('7: rehearsal prints escalating agent and gate errors; no fallback story', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-reh-'));
  try {
    const proj = join(root, 'p.json'); writeFileSync(proj, JSON.stringify({ inputs: { subject: 'Shaz', answers: { a: 'x' } } }));
    const lines = []; await runRehearsal({ projectPath: proj, runId: 'r2', runsRoot: root, invoke: fake({ 'story-director': () => '{bad' }), secrets: {}, tracing: null, trackerPath: null, log: (l) => lines.push(l) });
    assert.ok(lines.some((l) => l.startsWith('ESCALATED story-director'))); assert.ok(lines.some((l) => /\[SCHEMA_REJECTED\]/.test(l)));
    assert.throws(() => inputsFromProject({ inputs: { subject: 'Shaz' } }), /no questionnaire answers/);
    assert.equal(inputsFromProject({ inputs: { subject: { preferredName: 'Shaz', recipientName: 'Mia' }, answers: { a: 1 } } }).subject, 'Shaz, story for Mia');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
