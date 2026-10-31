import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { StateGraph, START, END, MemorySaver } from '@langchain/langgraph';
import { PipelineAnnotation } from '../graph/state.mjs';
import { makeSheetStillNode, paidItemsPath } from '../graph/stills.mjs';

const leo = {
  imageTag: '@Leo',
  characterId: 'leo',
  name: 'Leo',
  masterRenderPrompt: { promptText: 'a boy' },
};

test('a paid still is skipped and a crash file is not', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'paid-'));
  try {
    mkdirSync(join(runDir, 'outputs'), { recursive: true });
    writeFileSync(paidItemsPath(runDir), JSON.stringify({ '@Leo': '/tmp/leo.png' }));
    let calls = 0;
    const node = makeSheetStillNode({
      runDir,
      renderStill: async () => {
        calls += 1;
        return { dest: '/tmp/again.png' };
      },
    });
    const done = await node({ characterArchitect: { output: { characters: [leo] } } });
    assert.equal(calls, 0);
    assert.equal(done.assetFiles['@Leo'], '/tmp/leo.png');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('a provider failure is failed and is not marked paid', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'fail-'));
  try {
    const node = makeSheetStillNode({
      runDir,
      renderStill: async () => {
        throw new Error('Nano Banana failed');
      },
    });
    const done = await node({ characterArchitect: { output: { characters: [leo] } } });
    assert.equal(done.status, 'failed');
    assert.equal(existsSync(paidItemsPath(runDir)), false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('a short balance interrupts and does not fail the still', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'pause-'));
  try {
    let calls = 0;
    const node = makeSheetStillNode({
      runDir,
      renderStill: async () => {
        calls += 1;
        const error = new Error('short');
        error.code = 'AWAITING_CREDITS';
        error.itemId = '@Leo';
        error.credits = 8;
        throw error;
      },
    });
    const graph = new StateGraph(PipelineAnnotation)
      .addNode('sheets', node)
      .addEdge(START, 'sheets')
      .addEdge('sheets', END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: 'credits' } };
    await graph.invoke({ characterArchitect: { output: { characters: [leo] } } }, config);
    const snap = await graph.getState(config);
    const interrupts = (snap.tasks ?? []).flatMap((task) => task.interrupts ?? []);
    assert.equal(interrupts[0]?.value?.kind, 'credits');
    assert.equal(interrupts[0]?.value?.credits, 8);
    assert.equal(calls, 1);
    assert.equal(existsSync(paidItemsPath(runDir)), false);
    assert.notEqual(snap.values?.status, 'failed');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('makeSheetStillNode renders hero prop turnaround sheets alongside characters and locations', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'props-'));
  try {
    const renderedItems = [];
    const node = makeSheetStillNode({
      runDir,
      renderStill: async (req) => {
        renderedItems.push(req.itemId);
        return { dest: `/tmp/${req.itemId}.png` };
      },
    });
    const state = {
      characterArchitect: { output: { characters: [leo] } },
      locationScout: { output: { locations: [{ elementTag: '@Kitchen', locationId: 'l1', name: 'Kitchen', locationPlatePrompt: { promptText: 'cozy kitchen' } }] } },
      heroProps: [{ propTag: '@Prop 1', name: 'Camry', description: "Z's 2005 Toyota Camry" }],
    };
    const done = await node(state);
    assert.deepEqual(renderedItems, ['@Leo', '@Kitchen', '@Prop 1']);
    assert.equal(done.assetFiles['@Prop 1'], '/tmp/@Prop 1.png');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
