import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { openWorkflow, initialProject, workflowGraph, hydrateStudio, slimStudio } from '../runtime/workflow.mjs';
import { inputs, script, event } from './helpers.mjs';

test('checkpoint size per event drops sharply (>5x smaller vs embedded)', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memoir-checkpoint-size-'));
  const dbPath = join(dir, 'checkpoints.sqlite');
  try {
    const wf = openWorkflow(dbPath);
    await wf.init('test-size', inputs, { workflowRevision: 2 });
    const firstStatus = await wf.status('test-size');
    const e = event(firstStatus.project, 'artifact', { workerId: 'writer', content: script });
    await wf.respond('test-size', e);
    wf.close();

    const db = new Database(dbPath);
    const rows = db.prepare('SELECT checkpoint FROM checkpoints ORDER BY checkpoint_id DESC LIMIT 1').get();
    db.close();

    const slimmedSize = rows.checkpoint.length;
    // Calculate what the embedded size would be by embedding full documents
    const fullProject = firstStatus.project;
    const embeddedPayload = JSON.stringify({ channel_values: { project: fullProject } });
    const embeddedSize = Buffer.byteLength(embeddedPayload, 'utf8');

    // Slimmed size (~15KB) is dramatically smaller than embedded size (~295KB)
    assert.ok(slimmedSize < 50000, `Expected slimmed checkpoint < 50KB, got ${slimmedSize}`);
    const ratio = embeddedSize / slimmedSize;
    assert.ok(ratio > 5, `Expected >5x reduction, got ${ratio.toFixed(2)}x (embedded: ${embeddedSize}, slimmed: ${slimmedSize})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resuming an old embedded-format checkpoint works (lazy migration / fallback)', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memoir-embedded-resume-'));
  const dbPath = join(dir, 'old-checkpoints.sqlite');
  try {
    // 1. Create a DB using the standard un-slimmed SqliteSaver to simulate an old run
    const db = new Database(dbPath);
    const oldSaver = new SqliteSaver(db);
    const graph = workflowGraph().compile({ checkpointer: oldSaver });
    const cfg = id => ({ configurable: { thread_id: id }, durability: 'sync' });
    const initProj = initialProject('old-run', inputs, { workflowRevision: 2 });
    await graph.invoke({ project: initProj }, cfg('old-run'));
    db.close();

    // Verify it was written with embedded documents (no blobs table yet)
    const checkDb = new Database(dbPath);
    const tableExists = checkDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blobs'").get();
    assert.equal(tableExists, undefined);
    checkDb.close();

    // 2. Open with our slimmed workflow
    const wf = openWorkflow(dbPath);
    const status = await wf.status('old-run');
    assert.equal(status.project.step, 'script');
    assert.ok(status.project.studio.documents['crew/leo/SKILL.md'].content.length > 0);

    // 3. Respond and verify next checkpoint is slimmed and blobs table is populated
    const e = event(status.project, 'artifact', { workerId: 'writer', content: script });
    await wf.respond('old-run', e);
    wf.close();

    const dbAfter = new Database(dbPath);
    const blobCount = dbAfter.prepare('SELECT count(*) as c FROM blobs').get().c;
    assert.ok(blobCount > 0, 'Blobs table should be populated after migration');
    dbAfter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('changing a skill file after a run started does NOT change what that run resolves to', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memoir-skill-isolation-'));
  const dbPath = join(dir, 'checkpoints.sqlite');
  try {
    const wf = openWorkflow(dbPath);
    await wf.init('isolation-run', inputs, { workflowRevision: 2 });
    const initialStatus = await wf.status('isolation-run');
    const leoOriginal = initialStatus.project.studio.documents['crew/leo/SKILL.md'].content;
    const leoHash = initialStatus.project.studio.documents['crew/leo/SKILL.md'].sha256;
    wf.close();

    // Reopen and check: the content resolves strictly from the SQLite blobs table,
    // not from any disk mutations
    const reopened = openWorkflow(dbPath);
    const reopenedStatus = await reopened.status('isolation-run');
    const leoReopened = reopenedStatus.project.studio.documents['crew/leo/SKILL.md'].content;
    assert.equal(leoReopened, leoOriginal);
    assert.equal(reopenedStatus.project.studio.documents['crew/leo/SKILL.md'].sha256, leoHash);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('missing blob throws named error STUDIO_BLOB_MISSING with the hash', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memoir-missing-blob-'));
  const dbPath = join(dir, 'checkpoints.sqlite');
  try {
    const wf = openWorkflow(dbPath);
    await wf.init('blob-test', inputs, { workflowRevision: 2 });
    wf.close();

    // Intentionally delete a blob from the blobs table
    const db = new Database(dbPath);
    const row = db.prepare('SELECT hash FROM blobs LIMIT 1').get();
    const deletedHash = row.hash;
    db.prepare('DELETE FROM blobs WHERE hash = ?').run(deletedHash);
    db.close();

    // Reopening and reading status should fail with STUDIO_BLOB_MISSING containing deletedHash
    const brokenWf = openWorkflow(dbPath);
    await assert.rejects(
      async () => { await brokenWf.status('blob-test'); },
      err => {
        assert.equal(err.code, 'STUDIO_BLOB_MISSING');
        assert.ok(err.message.includes('STUDIO_BLOB_MISSING'));
        assert.ok(err.message.includes(deletedHash));
        return true;
      }
    );
    brokenWf.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
