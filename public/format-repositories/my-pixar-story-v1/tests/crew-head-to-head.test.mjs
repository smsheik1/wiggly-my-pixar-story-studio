import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openRunCopy, projectStates, findState } from '../evaluation/r4-replay.mjs';
import { runHeadToHead } from '../evaluation/crew-head-to-head.mjs';
import { openWorkflow, taskFor } from '../runtime/workflow.mjs';
import { loadStudio } from '../runtime/instructions.mjs';

const sha = buf => createHash('sha256').update(buf).digest('hex');

const secrets = async (dir, key = 'ISOLATED-OPENROUTER-KEY') => {
  const p = join(dir, 'secrets.env');
  await writeFile(p, `OPENROUTER_API_KEY=${key}\n`);
  return p;
};

test('1. findState picks the right state, key, gate and version from a synthetic checkpoint list', { timeout: 10000 }, async () => {
  const s1 = { step: 'script', gate: 'author', artifacts: [{ id: 'script@1', key: 'script', version: 1 }] };
  const s2 = { step: 'script', gate: 'review', artifacts: [{ id: 'script@1', key: 'script', version: 1 }] };
  const s3 = { step: 'candidates', characterId: 'c1', gate: 'review', artifacts: [{ id: 'candidates:c1@1', key: 'candidates:c1', version: 1 }] };
  const s4 = { step: 'candidates', characterId: 'c1', gate: 'review', artifacts: [{ id: 'candidates:c1@2', key: 'candidates:c1', version: 2 }] };

  const list = [s4, s3, s2, s1]; // newest first

  const foundScript = await findState(list, { key: 'script', gate: 'author' });
  assert.equal(foundScript, s1);

  const foundCandidatesV1 = await findState(list, { key: 'candidates:c1', gate: 'review', version: 1 });
  assert.equal(foundCandidatesV1, s3);

  const foundCandidatesV2 = await findState(list, { key: 'candidates:c1', gate: 'review', version: 2 });
  assert.equal(foundCandidatesV2, s4);

  const foundNone = await findState(list, { key: 'nonexistent', gate: 'review' });
  assert.equal(foundNone, null);
});

test('2. Full run over synthetic text task and 3-image review task with fake fetcher writes results.json and report.md', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'h2h-run-'));
  try {
    const secretsPath = await secrets(dir);
    const outDir = join(dir, 'out');

    // Build synthetic project states for sage-prompt-review and vera-room-review
    const baseStudio = loadStudio();
    const bgBrief = {
      id: 'backgroundBrief:childhood-room@1',
      key: 'backgroundBrief:childhood-room',
      kind: 'backgroundBrief',
      version: 1,
      digest: 'b'.repeat(64),
      content: { direction: 'room', sceneIds: ['s1'], knownDetails: [], proposedDetails: [], continuityNotes: '', references: [] },
      valid: true,
      authoredBy: 'author-brief',
      approvedBy: { message: 'approved' },
    };
    const bgPrompt = {
      id: 'backgroundPrompt:childhood-room@1',
      key: 'backgroundPrompt:childhood-room',
      kind: 'backgroundPrompt',
      version: 1,
      digest: 'p'.repeat(64),
      content: { prompt: '1980s childhood room', recipeSha256: 'r'.repeat(64), briefDigest: 'b'.repeat(64), changeSummary: 'initial' },
      valid: true,
      authoredBy: 'author-prompt',
    };

    const textReviewState = {
      id: 'proj-h2h-text',
      step: 'backgroundPrompt',
      gate: 'review',
      locationId: 'childhood-room',
      sequence: 1,
      reviewMode: 'supervised',
      studio: baseStudio,
      artifacts: [bgBrief, bgPrompt],
      jobs: [],
      history: [],
      feedback: [],
      reviewDisagreements: 0,
    };

    const fakeFetcher = async (url, init) => {
      const body = JSON.parse(init.body);
      const reviewEvent = {
        taskId: taskFor(textReviewState).taskId,
        actor: 'reviewer',
        action: 'review',
        workerId: 'h2h:text-reviewer:meta-muse-spark-1.3-contributor',
        artifactId: bgPrompt.id,
        artifactDigest: bgPrompt.digest,
        review: {
          decision: 'approved',
          perception: 'direct-text',
          modelVersion: body.model,
          checks: [
            { criterion: 'brief-fit', status: 'pass', evidence: 'matches brief', location: 'text', quotes: ['1980s childhood room'] },
            { criterion: 'style', status: 'pass', evidence: 'pixar style', location: 'text', quotes: ['1980s childhood room'] },
            { criterion: 'spatial-action', status: 'pass', evidence: 'good space', location: 'text', quotes: ['1980s childhood room'] },
            { criterion: 'continuity', status: 'pass', evidence: 'consistent', location: 'text', quotes: ['1980s childhood room'] },
          ],
        },
      };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          model: body.model,
          usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0001 },
          choices: [{
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({ eventJson: JSON.stringify(reviewEvent) }),
            },
          }],
        }),
      };
    };

    const res = await runHeadToHead({
      runDir: dir,
      secretsPath,
      models: ['meta/muse-spark-1.3-contributor'],
      tasks: ['sage-prompt-review'],
      confirmSpend: true,
      outDir,
      fetcher: fakeFetcher,
      stateList: [textReviewState],
    });

    if (!res.results[0].valid) {
      console.error('gateError in test 2:', res.results[0].gateError);
    }
    assert.equal(res.results[0].valid, true);
    assert.equal(res.results[0].model, 'meta/muse-spark-1.3-contributor');

    const resultsRaw = JSON.parse(await readFile(join(outDir, 'results.json'), 'utf8'));
    assert.equal(resultsRaw.length, 1);

    const reportMd = await readFile(join(outDir, 'report.md'), 'utf8');
    assert.match(reportMd, /Crew Head-to-Head/);
    assert.match(reportMd, /sage-prompt-review/);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('3. Without --confirm-spend, fetcher is never called; with maxUsd exceeded, run stops before call and marks skipped (cap)', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'h2h-cap-'));
  try {
    const secretsPath = await secrets(dir);
    let fetchCalled = false;
    const fakeFetcher = async () => {
      fetchCalled = true;
      throw new Error('should not be called');
    };

    const baseStudio = loadStudio();
    const bgBrief = { id: 'backgroundBrief:childhood-room@1', key: 'backgroundBrief:childhood-room', kind: 'backgroundBrief', version: 1, digest: 'b'.repeat(64), content: { direction: 'd', sceneIds: ['s1'], knownDetails: [], proposedDetails: [], continuityNotes: '', references: [] }, valid: true, authoredBy: 'author-brief', approvedBy: { message: 'ok' } };
    const state = {
      id: 'proj-cap',
      step: 'backgroundPrompt',
      gate: 'review',
      locationId: 'childhood-room',
      sequence: 1,
      reviewMode: 'supervised',
      studio: baseStudio,
      artifacts: [
        bgBrief,
        { id: 'backgroundPrompt:childhood-room@1', key: 'backgroundPrompt:childhood-room', kind: 'backgroundPrompt', version: 1, digest: 'p'.repeat(64), content: { prompt: 'room' }, dependencies: [bgBrief.id], valid: true, authoredBy: 'author' },
      ],
      jobs: [],
      history: [],
      feedback: [],
      reviewDisagreements: 0,
    };

    // 1) without confirmSpend
    const unconfirmed = await runHeadToHead({
      runDir: dir,
      secretsPath,
      confirmSpend: false,
      fetcher: fakeFetcher,
      stateList: [state],
    });
    assert.equal(unconfirmed.status, 'unconfirmed');
    assert.equal(fetchCalled, false);

    // 2) with cap exceeded (default maxUsd = 0.10, but pass maxUsd = 0.000001)
    const capped = await runHeadToHead({
      runDir: dir,
      secretsPath,
      confirmSpend: true,
      maxUsd: 0.000001,
      fetcher: fakeFetcher,
      stateList: [state],
    });
    assert.equal(capped.status, 'cap_exceeded');
    assert.equal(fetchCalled, false);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('4. Report contains no data: URLs and no secret key text', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'h2h-clean-'));
  try {
    const secretKey = 'MY-SECRET-OPENROUTER-KEY-999';
    const secretsPath = await secrets(dir, secretKey);
    const outDir = join(dir, 'out');

    const baseStudio = loadStudio();
    const state = {
      id: 'proj-clean',
      step: 'backgroundPrompt',
      gate: 'author',
      locationId: 'childhood-room',
      sequence: 1,
      reviewMode: 'supervised',
      studio: baseStudio,
      artifacts: [{ id: 'backgroundBrief:childhood-room@1', key: 'backgroundBrief:childhood-room', kind: 'backgroundBrief', version: 1, digest: 'b'.repeat(64), content: { direction: 'd', sceneIds: ['s1'], knownDetails: [], proposedDetails: [], continuityNotes: '', references: [] }, valid: true, authoredBy: 'b-author', approvedBy: { message: 'ok' } }],
      jobs: [],
      history: [],
      feedback: [],
      reviewDisagreements: 0,
    };

    await runHeadToHead({
      runDir: dir,
      secretsPath,
      models: ['meta/muse-spark-1.3-contributor'],
      tasks: ['theo-room-prompt'],
      dryRun: true,
      outDir,
      stateList: [state],
    });

    const reportMd = await readFile(join(outDir, 'report.md'), 'utf8');
    assert.ok(!reportMd.includes(secretKey));
    assert.ok(!reportMd.includes('data:image/'));
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('5. openRunCopy never modifies source sqlite (mtime and sha256 unchanged)', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'h2h-copy-'));
  try {
    const dbPath = join(dir, 'checkpoints.sqlite');
    const wf = openWorkflow(dbPath);
    await wf.init('thread-1', {
      subject: { fullName: 'Test User', preferredName: 'Test', recipientName: 'Rec', relationshipToRecipient: 'parent' },
      answers: { scene1Childhood: { a: '1' }, scene2TeenFreedom: { a: '2' }, scene3LeapOfFaith: { a: '3' }, scene4Romance: { a: '4' }, scene5LegacyFinale: { a: '5' } },
    });
    wf.close();

    const beforeStat = await stat(dbPath);
    const beforeBytes = await readFile(dbPath);
    const beforeSha = sha(beforeBytes);

    const { saver, tempDir } = await openRunCopy(dir);
    // Iterate checkpoints
    for await (const p of projectStates(saver)) {
      assert.ok(p.id);
    }
    saver.db.close();

    const afterStat = await stat(dbPath);
    const afterBytes = await readFile(dbPath);
    const afterSha = sha(afterBytes);

    assert.equal(beforeSha, afterSha);
    assert.equal(beforeStat.mtimeMs, afterStat.mtimeMs);
    await rm(tempDir, { recursive: true });
  } finally {
    await rm(dir, { recursive: true });
  }
});
