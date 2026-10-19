import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { selectCharacterArchitectInput } from '../crew/character-architect/input.mjs';
import { sheetState, runCaSheets } from '../scripts/run-ca-sheets.mjs';
import { GOOD_ANSWERS } from './fixtures/good-answers.mjs';

const sd = JSON.parse(readFileSync(new URL('../runs/r4-dry10/outputs/story-director.json', import.meta.url)));
const ca = JSON.parse(readFileSync(new URL('../runs/r4-dry10/outputs/character-architect.json', import.meta.url)));
const sheetsFx = readFileSync(new URL('../runs/r4-dry10-sheets/outputs/character-architect.json', import.meta.url), 'utf8');

test('model-sheet state passes mode, masterRenderRef and master prompts through the CA selector', () => {
  const input = selectCharacterArchitectInput(sheetState({ inputs: {}, storyDirector: sd, characters: ca }));
  assert.equal(input.mode, 'model-sheet');
  for (const c of ca.characters) {
    assert.match(input.masterRenderRef[c.elementTag], /^asset:master-render:/);
    assert.equal(input.masterRenderPrompts[c.elementTag], c.masterRenderPrompt.promptText);
  }
});

function sandboxFromDry10() {
  const root = mkdtempSync(join(tmpdir(), 'v2-ca-sheets-'));
  const from = 'from-run';
  mkdirSync(join(root, from, 'outputs'), { recursive: true });
  writeFileSync(join(root, from, 'outputs', 'story-director.json'), JSON.stringify(sd));
  writeFileSync(join(root, from, 'outputs', 'character-architect.json'), JSON.stringify(ca));
  const proj = join(root, 'p.json');
  writeFileSync(proj, JSON.stringify({ inputs: { subject: 'Shaz', answers: GOOD_ANSWERS } }));
  return { root, from, proj, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('tracing: root run tagged runId + ca-sheets, LangSmith URL logged, audit called with traceId', async () => {
  const { root, from, proj, done } = sandboxFromDry10();
  try {
    const runs = [];
    class Rec extends BaseCallbackHandler {
      name = 'rec';
      handleChainStart(_c, _i, runId, parentRunId, tags, _m, _t, name) { runs.push({ runId, parentRunId, tags, name }); }
    }
    const lines = [];
    let auditArgs = null;
    const summary = await runCaSheets({
      from, runId: 'sheets-tr1', projectPath: proj, runsRoot: root, secrets: {},
      invoke: async () => sheetsFx,
      tracing: { projectName: 'wiggly-v2', callbacks: [new Rec()], rootRunId: '00000000-0000-4000-8000-0000000000aa', url: async () => 'https://smith.langchain.com/fake-sheets', flush: async () => {} },
      audit: async (o) => { auditArgs = o; }, auditDelayMs: 0,
      log: (l) => lines.push(l),
    });
    assert.equal(summary.status, 'passed');
    assert.equal(summary.langsmithUrl, 'https://smith.langchain.com/fake-sheets');
    assert.ok(lines.includes('LangSmith: tracing to wiggly-v2'));
    assert.ok(lines.includes('LangSmith: https://smith.langchain.com/fake-sheets'));
    const rootRuns = runs.filter((r) => !r.parentRunId);
    assert.equal(rootRuns.length, 1);
    assert.equal(rootRuns[0].runId, '00000000-0000-4000-8000-0000000000aa');
    assert.ok(rootRuns[0].tags.includes('runId:sheets-tr1'));
    assert.ok(rootRuns[0].tags.includes('ca-sheets'));
    assert.equal(auditArgs?.traceId, '00000000-0000-4000-8000-0000000000aa');
    assert.equal(auditArgs?.runId, 'sheets-tr1');
    assert.ok(existsSync(join(root, 'sheets-tr1', 'outputs', 'character-architect.json')));
    assert.equal(JSON.parse(readFileSync(join(root, 'sheets-tr1', 'outputs', 'state.json'), 'utf8')).tracingProject, 'wiggly-v2');
  } finally { done(); }
});

test('tracing: null skips audit; audit failure is non-fatal', async () => {
  const { root, from, proj, done } = sandboxFromDry10();
  try {
    let called = 0;
    const lines = [];
    await runCaSheets({ from, runId: 'sheets-a1', projectPath: proj, runsRoot: root, secrets: {}, invoke: async () => sheetsFx,
      tracing: { projectName: 'wiggly-v2', callbacks: [], rootRunId: '00000000-0000-4000-8000-0000000000bb', url: async () => 'https://x', flush: async () => {} },
      audit: async () => { called++; throw new Error('LangSmith unreachable'); }, auditDelayMs: 0, log: (l) => lines.push(l) });
    assert.equal(called, 1);
    assert.ok(lines.some((l) => l.startsWith('audit skipped: LangSmith unreachable')));

    called = 0;
    await runCaSheets({ from, runId: 'sheets-a2', projectPath: proj, runsRoot: root, secrets: {}, invoke: async () => sheetsFx,
      tracing: null, audit: async () => { called++; }, auditDelayMs: 0, log: () => {} });
    assert.equal(called, 0);
  } finally { done(); }
});

test('output is saved before LangSmith flush, and a hung flush is bounded (r4-dry11 lost output)', async () => {
  const { root, from, proj, done } = sandboxFromDry10();
  try {
    const lines = [];
    let savedAtFlush = null;
    const summary = await runCaSheets({ from, runId: 'sheets-hang', projectPath: proj, runsRoot: root, secrets: {}, invoke: async () => sheetsFx,
      tracing: { projectName: 'wiggly-v2', callbacks: [], rootRunId: '00000000-0000-4000-8000-0000000000cc', url: async () => 'https://x',
        flush: () => { savedAtFlush = existsSync(join(root, 'sheets-hang', 'outputs', 'character-architect.json')); return new Promise(() => {}); } },
      audit: null, auditDelayMs: 0, flushTimeoutMs: 50, log: (l) => lines.push(l) });
    assert.equal(savedAtFlush, true);
    assert.equal(summary.status, 'passed');
    assert.ok(lines.some((l) => l.startsWith('LangSmith flush timed out')));
  } finally { done(); }
});
