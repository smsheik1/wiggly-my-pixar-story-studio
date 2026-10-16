import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditTrace, auditMarkdown, auditHtml, upsertSection, classifyError, llmUsage, replayGate, slimRun, AUDIT_START } from '../scripts/lib/audit.mjs';
import { auditRun, traceIdFromReport } from '../scripts/audit-trace.mjs';
import { runRehearsal } from '../scripts/run-rehearsal.mjs';

const fx = JSON.parse(readFileSync(new URL('./fixtures/r4-dry5-trace.json', import.meta.url), 'utf8'));
const m = auditTrace(fx.runs, { validationErrors: fx.validationErrors });

test('totals: tokens, cost from usage_metadata x price, wall-clock', () => {
  assert.equal(m.runId, 'r4-dry5');
  assert.equal(m.tokens, 709997);
  assert.ok(m.cost > 0.08 && m.cost < 0.1, `cost ${m.cost}`);
  assert.equal(Math.round(m.wallMs / 1000), 57 * 60 + 24);
  assert.equal(m.llmCalls, 36);
});
test('per agent attempts and wasted split network/gate/schema', () => {
  const a = m.agents;
  assert.deepEqual([a['story-director'].attempts, a['character-architect'].attempts, a['location-scout'].attempts, a['seedance-compiler'].attempts], [3, 2, 2, 2]);
  assert.equal(a['story-director'].wasted.network, 2);
  assert.equal(a['character-architect'].wasted.network, 1);
  assert.equal(a['location-scout'].wasted.gate, 1);
  assert.equal(a['seedance-compiler'].wasted.schema, 1);
  assert.equal(Object.values(a).reduce((s, x) => s + x.wastedTotal, 0), 5);
  assert.equal(a['seedance-compiler'].inAttemptSchemaRejects, 3);
});
test('rejected attempts carry codes and messages (deduped)', () => {
  const ls = m.rejected.find((r) => r.agent === 'location-scout');
  assert.equal(ls.issues[0].code, 'HUMAN_FIGURE_IN_BACKGROUND');
  const sc = m.rejected.find((r) => r.agent === 'seedance-compiler');
  assert.equal(sc.issues.length, 2); assert.ok(sc.issues.every((i) => i.code === 'SCHEMA_REJECTED'));
});
test('top 3 slowest / heaviest and unused tools', () => {
  assert.equal(m.slowest.length, 3); assert.ok(m.slowest[0].ms >= m.slowest[1].ms && m.slowest[1].ms >= m.slowest[2].ms);
  assert.equal(m.heaviest[0].tokens, 51322 - (51322 - m.heaviest[0].tokens)); assert.ok(m.heaviest[0].tokens >= m.heaviest[2].tokens);
  assert.ok(m.agents['story-director'].toolsUnused.includes('task'));
  assert.ok(!m.agents['story-director'].toolsUnused.includes('read_file'));
  assert.ok(!m.agents['story-director'].toolsUnused.some((t) => t.startsWith('submit_')));
});
test('markdown + html render every section', () => {
  const md = auditMarkdown(m);
  for (const h of ['## Per agent', '## Top 3 slowest steps', '## Top 3 token-heaviest steps', '## Rejected attempts', '## Tools bound but never called', 'HUMAN_FIGURE_IN_BACKGROUND']) assert.ok(md.includes(h), h);
  const html = auditHtml(m); assert.ok(html.startsWith(AUDIT_START)); assert.ok(!/<script/i.test(html));
});
test('upsertSection inserts after the dry-run section once and replaces on rerun', () => {
  const base = '<body><!-- v2-dry-run:start -->x<!-- v2-dry-run:end --><p>keep</p></body>';
  const once = upsertSection(base, auditHtml(m)); const twice = upsertSection(once, auditHtml(m));
  assert.equal(once, twice); assert.equal(twice.split(AUDIT_START).length, 2); assert.ok(twice.includes('<p>keep</p>'));
  assert.ok(upsertSection('<body></body>', 'S').includes('S</body>'));
});
test('classifyError and llmUsage', () => {
  assert.equal(classifyError('Network connection lost.'), 'network');
  assert.equal(classifyError('x: submit rejected by the output schema (2 issues)'), 'schema');
  assert.equal(classifyError('the deep agent finished without calling submit'), 'other');
  const u = llmUsage({ extra: { metadata: { ls_model_name: 'meta/muse-spark-1.3-contributor', usage_metadata: { input_tokens: 1000, output_tokens: 100, input_token_details: { cache_read: 500 } } } } });
  assert.equal(u.total, 1100); assert.ok(Math.abs(u.cost - (500e-7 + 500 * 2e-9 + 100 * 2e-7)) < 1e-12);
});
test('replayGate: unparseable output is a schema rejection; unknown agent is null', () => {
  assert.equal(replayGate('story-director', '{"nope":1}').kind, 'schema');
  assert.equal(replayGate('nobody', {}), null);
});
test('slimRun drops photo paths and big llm payloads', () => {
  const s = slimRun({ id: 'a', name: 'character-architect attempt 1', run_type: 'chain', inputs: { input: {}, state: { inputs: { photoReferences: [{ id: 'p', path: '/x/p.jpg' }] } }, skill: 'big' }, outputs: { ok: 1 } });
  assert.equal(s.inputs.state.inputs.photoReferences[0].path, undefined); assert.equal(s.inputs.skill, undefined);
});
test('auditRun from a saved trace writes audit.md and patches report.html + tracker; run id from report link', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-audit-'));
  try {
    mkdirSync(join(root, 'r4-dry5', 'outputs'), { recursive: true });
    writeFileSync(join(root, 'r4-dry5', 'outputs', 'state.json'), JSON.stringify({ validationErrors: fx.validationErrors }));
    writeFileSync(join(root, 'r4-dry5', 'report.html'), "<body><a href='https://x/r/1?trace_id=2cfd1780-ace5-4a54-836e-91640b67de54&amp;s=1'>t</a></body>");
    const tracker = join(root, 't.html'); writeFileSync(tracker, '<body><!-- v2-dry-run:start --><!-- v2-dry-run:end --></body>');
    const r = await auditRun({ runs: fx.runs, runsRoot: root, trackerPath: tracker, log: () => {} });
    assert.ok(readFileSync(r.mdPath, 'utf8').includes('HUMAN_FIGURE_IN_BACKGROUND'));
    assert.ok(readFileSync(join(root, 'r4-dry5', 'report.html'), 'utf8').includes(AUDIT_START));
    assert.ok(readFileSync(tracker, 'utf8').includes(AUDIT_START));
    assert.equal(traceIdFromReport(root, 'r4-dry5'), '2cfd1780-ace5-4a54-836e-91640b67de54');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('rehearsal: audit runs only when traced and never fails the run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-audit-r-'));
  try {
    const proj = join(root, 'p.json'); writeFileSync(proj, JSON.stringify({ inputs: { subject: 'S', answers: { a: { b: 'c' } } } }));
    const fx2 = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
    const F = { 'story-director': 'good-stage-play.json', 'character-architect': 'good-master-renders.json', 'location-scout': 'good-location-plates.json', 'seedance-compiler': 'good-seedance-prompts.json' };
    const invoke = async (r) => fx2(F[r.agent]);
    const lines = []; let called = 0;
    const tracing = { projectName: 'p', rootRunId: 'rid', callbacks: [], flush: async () => {}, url: async () => null };
    const r = await runRehearsal({ projectPath: proj, runId: 'a1', runsRoot: root, invoke, secrets: {}, tracing, trackerPath: null, heartbeatMs: 0, auditDelayMs: 0, log: (l) => lines.push(l),
      audit: async (o) => { called++; assert.equal(o.traceId, 'rid'); throw new Error('LangSmith unreachable'); } });
    assert.equal(called, 1); assert.ok(lines.some((l) => l.startsWith('audit skipped: LangSmith unreachable'))); assert.ok(r.state);
    called = 0; await runRehearsal({ projectPath: proj, runId: 'a2', runsRoot: root, invoke, secrets: {}, tracing: null, trackerPath: null, heartbeatMs: 0, log: () => {}, audit: async () => { called++; } });
    assert.equal(called, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('truncated model calls (output at max tokens) are flagged', { timeout: 10000 }, () => {
  const llm = (out) => ({ id: String(out), parent_run_id: 'r', name: 'ChatOpenAI', run_type: 'llm', start_time: '2026-10-16T00:00:00Z', end_time: '2026-10-16T00:01:00Z', tags: ['agent:story-director', 'attempt:1'],
    extra: { metadata: { agent: 'story-director', attempt: 1, ls_max_tokens: 32000, ls_model_name: 'meta/muse-spark-1.3-contributor', usage_metadata: { input_tokens: 10, output_tokens: out, output_token_details: { reasoning: out - 5 } } } } });
  const m2 = auditTrace([{ id: 'r', name: 'wiggly-v2 rehearsal', run_type: 'chain', start_time: '2026-10-16T00:00:00Z', end_time: '2026-10-16T00:02:00Z', tags: ['runId:x'] }, llm(32217), llm(3000)]);
  assert.equal(m2.truncated.length, 1); assert.ok(auditMarkdown(m2).includes('32.2k out of 32.0k'));
});
