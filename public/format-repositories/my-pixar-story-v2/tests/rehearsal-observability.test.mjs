import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { runRehearsal } from '../scripts/run-rehearsal.mjs';
import { loadSecrets } from '../scripts/lib/secrets.mjs';
import { upsertTracker, createRecorder } from '../scripts/lib/report.mjs';
import { readEvents } from '../graph/event-log.mjs';
import { placeholderAssets } from '../graph/graph.mjs';
import { GOOD_ANSWERS } from './fixtures/good-answers.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const FIX = { 'story-director': 'good-stage-play.json', 'character-architect': 'good-master-renders.json', 'location-scout': 'good-location-plates.json', 'seedance-compiler': 'good-seedance-prompts.json' };
// Seedance fake binds to whatever keys were approved (placeholder or real), like the real compiler would.
const rebind = (txt, approved) => Object.entries(json('good-approved-assets.json')).reduce((t, [tag, k]) => t.split(k).join(approved?.[tag] ?? k), txt);
const fake = (bad = {}) => async (r) => { if (r.agent === 'seedance-compiler') return rebind(JSON.stringify(json(FIX[r.agent])), r.state.approvedAssets); const o = json(FIX[r.agent]); if (r.attempt <= (bad[r.agent] ?? 0)) o.locations[0].locationPlatePrompt.promptText += ' A boy sits at the table.'; return JSON.stringify(o); };
const TRACKER = '<!doctype html><html><head><style>.x{}</style></head><body><h1>Old work</h1><ul><li>keep me</li></ul>\n<div class="now"><b>Now:</b> x</div><script>/*reload*/</script></body></html>';
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'v2-obs-'));
  const proj = join(root, 'p.json'); writeFileSync(proj, JSON.stringify({ inputs: { subject: 'Shaz', answers: GOOD_ANSWERS, targetTotalRuntimeSec: 60 } }));
  const tracker = join(root, 'progress.html'); writeFileSync(tracker, TRACKER);
  return { root, proj, tracker, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('secrets: loads only OPENROUTER_API_KEY and LANGSMITH_*, never other keys', () => {
  const { root, done } = sandbox();
  try {
    const f = join(root, 's.env'); writeFileSync(f, 'OPENROUTER_API_KEY="or-fake"\nexport LANGSMITH_API_KEY=ls-fake\nLANGSMITH_PROJECT=p\nVIDEO_ENDPOINT=fake-value\nOTHER=1\n');
    assert.deepEqual(loadSecrets(f), { OPENROUTER_API_KEY: 'or-fake', LANGSMITH_API_KEY: 'ls-fake', LANGSMITH_PROJECT: 'p' });
    assert.deepEqual(loadSecrets(join(root, 'missing.env')), {});
  } finally { done(); }
});
test('placeholder assets: compiler runs past approval with marked fake keys; report + tracker written', async () => {
  const { root, proj, tracker, done } = sandbox();
  try {
    const lines = [];
    const r = await runRehearsal({ projectPath: proj, runId: 'p1', runsRoot: root, invoke: fake({ 'location-scout': 1 }), secrets: {}, tracing: null, trackerPath: tracker, usePlaceholderAssets: true, log: (l) => lines.push(l) });
    assert.equal(r.state.status, 'done');
    assert.ok(Object.values(r.state.approvedAssets).every((k) => k.startsWith('placeholder:')));
    assert.ok(existsSync(join(r.dir, 'seedance-compiler.json'))); assert.ok(lines[0].startsWith('PLACEHOLDER ASSETS'));
    assert.ok(existsSync(r.eventsFile));
    const evs = readEvents(r.eventsFile);
    assert.ok(evs.length >= 5);
    assert.equal(evs[0].type, 'run-started');
    assert.equal(evs.at(-1).type, 'run-finished');
    const rep = readFileSync(r.report, 'utf8');
    for (const s of ['Story Director', 'Character Architect', 'Location Scout', 'Seedance Compiler', 'Attempt 2', 'HUMAN', 'placeholder assets']) assert.ok(rep.includes(s), s);
    const t = readFileSync(tracker, 'utf8');
    assert.ok(t.includes('<li>keep me</li>') && t.includes('<div class="now">') && t.includes('/*reload*/'));
    assert.equal(t.match(/v2-dry-run:start/g).length, 1); assert.ok(t.includes("id='v2-dry-run'") && /passed/.test(t));
    assert.ok(t.indexOf('v2-dry-run:start') < t.indexOf('<div class="now">'));
    assert.deepEqual(placeholderAssets(['@Image 1', '@Loc 1']), { '@Image 1': 'placeholder:master-render:image-1', '@Loc 1': 'placeholder:location-plate:loc-1' });
  } finally { done(); }
});
test('tracker: live status updates during the run (running then passed) and re-upserts in place', async () => {
  const { root, proj, tracker, done } = sandbox();
  try {
    const seen = [];
    const inv = async (r) => { const t = readFileSync(tracker, 'utf8'); seen.push(/Story Director<\/b><span class='tag'[^>]*>running/.test(t)); return fake()(r); };
    await runRehearsal({ projectPath: proj, runId: 'live', runsRoot: root, invoke: inv, secrets: {}, tracing: null, trackerPath: tracker, log: () => {} });
    assert.equal(seen[0], true);
    const rec = createRecorder({ runId: 'x' }); upsertTracker(rec.model, tracker); upsertTracker(rec.model, tracker);
    assert.equal(readFileSync(tracker, 'utf8').match(/v2-dry-run:start/g).length, 1);
  } finally { done(); }
});
test('tracing: one root run, child per agent node and per attempt, tagged runId/agent/attempt; URL printed', async () => {
  const { root, proj, done } = sandbox();
  try {
    const runs = [];
    class Rec extends BaseCallbackHandler { name = 'rec'; handleChainStart(_c, inputs, runId, parentRunId, tags, metadata, _t, name) { runs.push({ runId, parentRunId, tags, name }); } }
    const lines = [];
    await runRehearsal({ projectPath: proj, runId: 'tr1', runsRoot: root, invoke: fake({ 'location-scout': 1 }), secrets: {}, trackerPath: null, log: (l) => lines.push(l),
      tracing: { callbacks: [new Rec()], rootRunId: '00000000-0000-4000-8000-000000000001', url: async () => 'https://smith.langchain.com/fake-run', flush: async () => {} } });
    const rootRuns = runs.filter((r) => !r.parentRunId);
    assert.equal(rootRuns.length, 1); assert.equal(rootRuns[0].runId, '00000000-0000-4000-8000-000000000001'); assert.ok(rootRuns[0].tags.includes('runId:tr1'));
    for (const a of ['story-director', 'character-architect', 'location-scout']) assert.ok(runs.some((r) => r.name === a), `node ${a}`);
    const att = runs.filter((r) => r.name === 'location-scout attempt 2');
    assert.equal(att.length, 1); assert.ok(att[0].tags.includes('agent:location-scout') && att[0].tags.includes('attempt:2') && att[0].tags.includes('runId:tr1'));
    assert.ok(lines.includes('LangSmith: https://smith.langchain.com/fake-run'));
  } finally { done(); }
});
