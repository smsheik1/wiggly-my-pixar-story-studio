import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessageChunk } from '@langchain/core/messages';
import { createLiveness, LivenessHandler, withWatchdog } from '../graph/liveness.mjs';
import { buildGraph } from '../graph/graph.mjs';
import { runRehearsal } from '../scripts/run-rehearsal.mjs';
import { createRecorder, trackerSection } from '../scripts/lib/report.mjs';
import { GOOD_ANSWERS } from './fixtures/good-answers.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const clock = (t = 0) => { const c = () => t; c.add = (ms) => { t += ms; }; return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('heartbeat line: phase, tokens, elapsed, last activity; STALLED? after 90s idle', () => {
  const now = clock(); const l = createLiveness({ now });
  const e = l.begin('story-director', 1); now.add(10_000);
  l.activity('story-director', 1, { phase: 'thinking', tokens: 1240 }); now.add(124_000 + 3_000);
  // started 0, activity at 10s, now 137s
  assert.equal(l.line(e), 'Story Director — attempt 1 — thinking… 1,240 tokens · 2m17s · last activity 2m07s ago · STALLED?');
  l.activity('story-director', 1, { tokens: 1 }); now.add(3000);
  assert.equal(l.line(e), 'Story Director — attempt 1 — thinking… 1,241 tokens · 2m20s · last activity 3s ago');
  assert.equal(l.status(e).stalled, false);
});
test('callback handler: waiting -> thinking (reasoning) -> writing -> tool-call, keyed by inherited metadata', () => {
  const now = clock(); const l = createLiveness({ now }); const h = new LivenessHandler(l);
  const e = l.begin('location-scout', 2);
  h.handleChainStart({}, {}, 'att', undefined, [], { agent: 'location-scout', attempt: 2 });
  h.handleChatModelStart({}, [], 'llm', 'att', {}, [], {});
  assert.equal(e.phase, 'waiting-for-first-token');
  h.handleLLMNewToken('', {}, 'llm', 'att', [], { chunk: { message: new AIMessageChunk({ content: '', additional_kwargs: { reasoning: 'hmm' } }) } });
  assert.equal(e.phase, 'thinking'); assert.equal(e.tokens, 1); assert.ok(e.firstTokenAt !== null);
  h.handleLLMNewToken('Hello', {}, 'llm', 'att', [], { chunk: { message: new AIMessageChunk({ content: 'Hello' }) } });
  assert.equal(e.phase, 'writing');
  h.handleLLMNewToken('', {}, 'llm', 'att', [], { chunk: { message: new AIMessageChunk({ content: '', tool_call_chunks: [{ name: 'submit_location-scout', args: '{', index: 0 }] }) } });
  assert.equal(e.phase, 'tool-call'); assert.equal(e.tokens, 3);
});
test('watchdog: no first token within limit -> rejects with timeout and aborts the signal', async () => {
  const l = createLiveness(); let sig;
  await assert.rejects(withWatchdog((s) => { sig = s; return new Promise(() => {}); }, { liveness: l, agent: 'story-director', attempt: 1, firstTokenMs: 30, idleMs: 10_000, pollMs: 5 }),
    /model call timed out \(no first token within 0s\)/);
  assert.equal(sig.aborted, true); assert.equal(l.active().length, 0);
});
test('watchdog: tokens then silence -> idle timeout; steady activity never times out', async () => {
  const l = createLiveness();
  await assert.rejects(withWatchdog(async () => { l.activity('location-scout', 1, { tokens: 1 }); await new Promise(() => {}); }, { liveness: l, agent: 'location-scout', attempt: 1, firstTokenMs: 10_000, idleMs: 40, pollMs: 5 }), /no activity for/);
  const ok = await withWatchdog(async () => { for (let i = 0; i < 6; i++) { l.activity('character-architect', 1, { tokens: 1 }); await sleep(15); } return 'fine'; },
    { liveness: l, agent: 'character-architect', attempt: 1, firstTokenMs: 30, idleMs: 40, pollMs: 5 });
  assert.equal(ok, 'fine');
});
test('timeout counts as failed attempt; message reaches retry feedback; next attempt passes', async () => {
  const l = createLiveness(); const calls = [];
  const invoke = async (r) => {
    calls.push(r);
    if (r.agent === 'story-director' && r.attempt === 1) return new Promise(() => {}); // hangs, never streams
    return JSON.stringify(json({ 'story-director': 'good-stage-play.json', 'character-architect': 'good-master-renders.json', 'location-scout': 'good-location-plates.json' }[r.agent]));
  };
  const s = await buildGraph({ invoke, liveness: l, timeouts: { firstTokenMs: 30, idleMs: 1000, pollMs: 5 } }).invoke({ inputs: { subject: 'Shaz', answers: GOOD_ANSWERS } });
  assert.equal(s.status, 'awaiting-approval'); assert.equal(s.retryCounts['story-director'], 1);
  assert.match(s.validationErrors[0].errors[0].message, /model call timed out/);
  assert.match(calls.find((c) => c.agent === 'story-director' && c.attempt === 2).retryNotes, /model call timed out/);
  assert.ok(calls[0].signal instanceof AbortSignal);
});
test('runner: heartbeat to console + tracker every interval, red STALLED?, tracing label during run then link', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-live-'));
  try {
    const proj = join(root, 'p.json'); writeFileSync(proj, JSON.stringify({ inputs: { subject: 'Shaz', answers: GOOD_ANSWERS } }));
    const tracker = join(root, 't.html'); writeFileSync(tracker, '<html><body><div class="now">x</div></body></html>');
    const lines = []; const snaps = [];
    const invoke = async (r) => {
      if (r.agent === 'story-director') { await sleep(60); snaps.push(readFileSync(tracker, 'utf8')); }
      return JSON.stringify(json({ 'story-director': 'good-stage-play.json', 'character-architect': 'good-master-renders.json', 'location-scout': 'good-location-plates.json' }[r.agent]));
    };
    await runRehearsal({ projectPath: proj, runId: 'hb', runsRoot: root, invoke, secrets: {}, trackerPath: tracker, log: (x) => lines.push(x), heartbeatMs: 10,
      timeouts: { stallMs: 20 }, tracing: { projectName: 'wiggly-v2', callbacks: [], rootRunId: '00000000-0000-4000-8000-000000000002', url: async () => 'https://smith.langchain.com/x', flush: async () => {} } });
    assert.ok(lines.some((x) => /^\[heartbeat\] Story Director — attempt 1 — waiting for first token… 0 tokens · \d+s · last activity \d+s ago/.test(x)), lines.join('\n'));
    assert.ok(lines.some((x) => x.includes('STALLED?')));
    assert.ok(lines.includes('LangSmith: tracing to wiggly-v2'));
    assert.match(snaps[0], /tracing to wiggly-v2/); assert.match(snaps[0], /color:#f87171'><span class='spin sm'><\/span>Story Director — attempt 1/);
    const end = readFileSync(tracker, 'utf8'); assert.ok(end.includes('https://smith.langchain.com/x') && !end.includes('[heartbeat]') && !/attempt 1 — waiting/.test(end));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('tracker label without tracing says not traced', () => {
  const r = createRecorder({ runId: 'n' }); assert.match(trackerSection(r.model), /LangSmith: not traced/);
});
