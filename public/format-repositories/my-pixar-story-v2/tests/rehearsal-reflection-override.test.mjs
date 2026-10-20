// run-rehearsal --reflection-rounds: a per-run self-review override (config untouched). Fake graph only: zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRehearsal, parseReflectionRounds } from '../scripts/run-rehearsal.mjs';
import { V2_MODELS } from '../config/models.mjs';
import { reflectionRoundsFor } from '../graph/deep-agent-node.mjs';

test('parseReflectionRounds: N for every agent, or agent=N pairs; rejects junk and unknown agents', () => {
  assert.equal(parseReflectionRounds('0'), 0);
  assert.equal(parseReflectionRounds('3'), 3);
  assert.deepEqual(parseReflectionRounds('story-director=0'), { 'story-director': 0 });
  assert.deepEqual(parseReflectionRounds('story-director=1, seedance-compiler=2'), { 'story-director': 1, 'seedance-compiler': 2 });
  for (const bad of ['', '-1', 'two', 'story-director=-1', 'story-director', 'nobody=1', 'linter=1']) assert.throws(() => parseReflectionRounds(bad), /--reflection-rounds/, bad);
});

test('runRehearsal passes the override to the Deep Agents (story-director=0 beats config 2) and logs it; config is unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wiggly-rr-'));
  try {
    const proj = join(root, 'p.json'); writeFileSync(proj, JSON.stringify({ inputs: { subject: 'S', answers: { a: { b: 'c' } } } }));
    const seen = []; const lines = [];
    const STOP = new Error('stop after graph build');
    const buildGraphFn = (opts) => { seen.push(opts); throw STOP; };
    const base = { projectPath: proj, runsRoot: root, secrets: { OPENROUTER_API_KEY: 'test-not-a-key' }, tracing: null, trackerPath: null, heartbeatMs: 0, log: (l) => lines.push(l), buildGraphFn };
    await assert.rejects(runRehearsal({ ...base, runId: 'rr0', reflectionRounds: { 'story-director': 0 } }), STOP);
    assert.deepEqual(seen[0].deepAgent.reflectionRounds, { 'story-director': 0 });
    assert.ok(lines.includes('self-review rounds override: story-director=0'));
    await assert.rejects(runRehearsal({ ...base, runId: 'rr1' }), STOP);
    assert.ok(!('reflectionRounds' in seen[1].deepAgent), 'no flag: config decides');
    assert.equal(V2_MODELS['story-director'].reflectionRounds, 2);
    // how deepAgentInvoke resolves it: the override for a listed agent, config for the rest
    assert.equal(reflectionRoundsFor(V2_MODELS['story-director'], seen[0].deepAgent.reflectionRounds['story-director']), 0);
    assert.equal(reflectionRoundsFor(V2_MODELS['story-director'], seen[0].deepAgent.reflectionRounds['character-architect']), 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
