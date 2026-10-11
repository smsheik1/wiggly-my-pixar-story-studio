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

test('6. spend guard holds per request: worst case uses max_tokens and images, missing usage.cost falls back to token price, Sol verdict read from the newest state', { timeout: 10000 }, async () => {
  const { worstCaseRequestUsd, responseCostUsd, estimateTaskCost } = await import('../evaluation/crew-head-to-head.mjs');
  const body = JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', max_tokens: 16000, messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(4000) }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(200000) } }] }] });
  const worst = worstCaseRequestUsd(body, 'deepseek/deepseek-v4.1-flash');
  // 16,000 output tokens at $1.20/M dominate; the base64 bytes are counted as one image, not as text.
  assert.ok(worst > 0.0192 && worst < 0.0215, String(worst));
  assert.ok(worstCaseRequestUsd(body, 'meta/muse-spark-1.3-contributor') < worst);
  assert.equal(responseCostUsd({ cost: 0.0042 }, 'deepseek/deepseek-v4.1-flash'), 0.0042);
  assert.ok(Math.abs(responseCostUsd({ prompt_tokens: 1_000_000, completion_tokens: 0 }, 'deepseek/deepseek-v4.1-flash') - 0.30) < 1e-9);
  // A 3-image review task estimates higher than a text-only one.
  const img = n => ({ path: `/x/${n}.png`, sha256: String(n).repeat(64).slice(0, 64), bytes: 10, width: 1600, height: 900 });
  assert.ok(estimateTaskCost({ artifact: { content: { files: [img(1), img(2), img(3)] } }, dependencies: [] }, 'deepseek/deepseek-v4.1-flash') > estimateTaskCost({ artifact: { content: { prompt: 'p' } }, dependencies: [] }, 'deepseek/deepseek-v4.1-flash'));
  // Source-level guard: the fetch wrapper refuses before calling the network, and Sol's verdict comes from states[0].
  const src = await (await import('node:fs/promises')).readFile(new URL('../evaluation/crew-head-to-head.mjs', import.meta.url), 'utf8');
  assert.match(src, /HEAD_TO_HEAD_CAP_REACHED[\s\S]*?const resp = await fetcher/);
  assert.match(src, /states\[0\]\?\.artifacts\?\.find/);
});

// Shared synthetic text-review state + fake OpenRouter fetcher (no network, no codex).
const textReviewFixture = () => {
  const baseStudio = loadStudio();
  const bgBrief = { id: 'backgroundBrief:childhood-room@1', key: 'backgroundBrief:childhood-room', kind: 'backgroundBrief', version: 1, digest: 'b'.repeat(64), content: { direction: 'room', sceneIds: ['s1'], knownDetails: [], proposedDetails: [], continuityNotes: '', references: [] }, valid: true, authoredBy: 'author-brief', approvedBy: { message: 'approved' } };
  const bgPrompt = { id: 'backgroundPrompt:childhood-room@1', key: 'backgroundPrompt:childhood-room', kind: 'backgroundPrompt', version: 1, digest: 'p'.repeat(64), content: { prompt: '1980s childhood room', recipeSha256: 'r'.repeat(64), briefDigest: 'b'.repeat(64), changeSummary: 'initial' }, valid: true, authoredBy: 'author-prompt' };
  const state = { id: 'proj-h2h-effort', step: 'backgroundPrompt', gate: 'review', locationId: 'childhood-room', sequence: 1, reviewMode: 'supervised', studio: baseStudio, artifacts: [bgBrief, bgPrompt], jobs: [], history: [], feedback: [], reviewDisagreements: 0 };
  const bodies = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const event = { taskId: taskFor(state).taskId, actor: 'reviewer', action: 'review', artifactId: bgPrompt.id, artifactDigest: bgPrompt.digest, review: { decision: 'approved', perception: 'direct-text', modelVersion: body.model, checks: ['brief-fit', 'style', 'spatial-action', 'continuity'].map(criterion => ({ criterion, status: 'pass', evidence: 'ok', location: 'text', quotes: ['1980s childhood room'] })) } };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: body.model, usage: { prompt_tokens: 120, completion_tokens: 60, completion_tokens_details: { reasoning_tokens: 40 }, cost: 0.0002 }, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ eventJson: JSON.stringify(event) }) } }] }) };
  };
  return { state, fetcher, bodies };
};

test('7. production OpenRouterHost refuses a host-wide xhigh/max (Muse alone runs xhigh via its model override); the evaluation host sets any offered effort per model', { timeout: 10000 }, async () => {
  const { OpenRouterHost } = await import('../runtime/openrouter-host.mjs');
  const { evaluationHost, assertEvalEffort } = await import('../evaluation/crew-head-to-head.mjs');
  for (const reasoningEffort of ['xhigh', 'max']) {
    assert.throws(() => new OpenRouterHost({ cwd: '/tmp', model: 'meta/muse-spark-1.3-contributor', reasoningEffort, fetcher: async () => { throw new Error('no network'); } }), /OPENROUTER_REASONING_LIMIT/);
  }
  const muse = evaluationHost({ cwd: '/tmp', model: 'meta/muse-spark-1.3-contributor', fetcher: async () => { throw new Error('no network'); } }, 'xhigh');
  assert.equal(muse.requestSettings().reasoning.effort, 'xhigh');
  const ds = evaluationHost({ cwd: '/tmp', model: 'deepseek/deepseek-v4.1-flash', fetcher: async () => { throw new Error('no network'); } }, 'max');
  assert.equal(ds.requestSettings().reasoning.effort, 'max');
  // DeepSeek has no xhigh; unknown levels are refused.
  assert.throws(() => assertEvalEffort('deepseek/deepseek-v4.1-flash', 'xhigh'), /HEAD_TO_HEAD_EFFORT_INVALID/);
  assert.throws(() => assertEvalEffort('meta/muse-spark-1.3-contributor', 'ultra'), /HEAD_TO_HEAD_EFFORT_INVALID/);
  // Eval can still run Muse below its production xhigh.
  assert.equal(evaluationHost({ cwd: '/tmp', model: 'meta/muse-spark-1.3-contributor', fetcher: async () => { throw new Error('no network'); } }, 'high').requestSettings().reasoning.effort, 'high');
  // A fresh production host: Muse at its per-model xhigh, DeepSeek still medium; real runs never import the evaluation host.
  assert.equal(new OpenRouterHost({ cwd: '/tmp', model: 'meta/muse-spark-1.3-contributor' }).requestSettings().reasoning.effort, 'xhigh');
  assert.equal(new OpenRouterHost({ cwd: '/tmp', model: 'deepseek/deepseek-v4.1-flash' }).requestSettings().reasoning.effort, 'medium');
  const runnerSrc = await readFile(new URL('../runner.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(runnerSrc, /crew-head-to-head|evaluationHost/);
  const hostSrc = await readFile(new URL('../runtime/openrouter-host.mjs', import.meta.url), 'utf8');
  assert.match(hostSrc, /never max\/xhigh/);
});

test('8. --effort reaches the request body, per-turn timing/tokens and repairs are recorded, and the $0.10 cap cannot be raised', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'h2h-effort-'));
  try {
    const secretsPath = await secrets(dir);
    const { state, fetcher, bodies } = textReviewFixture();
    const res = await runHeadToHead({
      runDir: dir, secretsPath, outDir: join(dir, 'out'), confirmSpend: true, fetcher, stateList: [state],
      models: ['meta/muse-spark-1.3-contributor', 'deepseek/deepseek-v4.1-flash'],
      tasks: ['sage-prompt-review'],
      efforts: { 'meta/muse-spark-1.3-contributor': 'xhigh', 'deepseek/deepseek-v4.1-flash': 'max' },
      maxUsd: 5,
    });
    assert.equal(res.capUsd, 0.10);
    assert.deepEqual(bodies.map(b => [b.model, b.reasoning?.effort]), [['meta/muse-spark-1.3-contributor', 'xhigh'], ['deepseek/deepseek-v4.1-flash', 'max']]);
    for (const r of res.results) {
      assert.equal(r.valid, true, r.gateError);
      assert.equal(r.turns.length, 1);
      assert.ok(Number.isFinite(r.turns[0].ms));
      assert.equal(r.reasoningTokens, 40);
      assert.equal(r.validationRetries, 0);
      assert.equal(r.invalidToolCalls, 0);
    }
    assert.deepEqual(res.results.map(r => r.effort), ['xhigh', 'max']);
    const md = await readFile(join(dir, 'out', 'report.md'), 'utf8');
    assert.match(md, /\| xhigh \|/);
    // An effort the model does not offer stops before any request.
    bodies.length = 0;
    await assert.rejects(runHeadToHead({ runDir: dir, secretsPath, confirmSpend: true, fetcher, stateList: [state], models: ['deepseek/deepseek-v4.1-flash'], tasks: ['sage-prompt-review'], efforts: { 'deepseek/deepseek-v4.1-flash': 'xhigh' } }), /HEAD_TO_HEAD_EFFORT_INVALID/);
    assert.equal(bodies.length, 0);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('9. adult-sheet task targets r4 adult Shaz sheets v1, stays out of the default run, and --version selects one version', { timeout: 10000 }, async () => {
  const { TASK_DEFS, selectVersions } = await import('../evaluation/crew-head-to-head.mjs');
  const def = TASK_DEFS['vera-adult-sheet-review'];
  assert.deepEqual({ role: def.role, key: def.key, gate: def.gate, versions: def.versions }, { role: 'visual-reviewer', key: 'candidates:shaz-adult', gate: 'review', versions: [1] });
  assert.deepEqual(selectVersions(def, 1), [1]);
  assert.deepEqual(selectVersions(TASK_DEFS['vera-sheet-review'], 2), [2]);
  assert.deepEqual(selectVersions(TASK_DEFS['vera-sheet-review'], null), [1, 2]);
  assert.deepEqual(selectVersions(TASK_DEFS['vera-sheet-review'], 3), []);
  // Default (no --tasks) never picks it up, so default estimates are unchanged.
  const src = await readFile(new URL('../evaluation/crew-head-to-head.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src.match(/const RUN_ORDER = \[[^\]]*\]/)[0], /vera-adult-sheet-review/);
});

test('10. per-turn ms runs until the full response body is read, not until the headers arrive (delayed body, no network)', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'h2h-timing-'));
  const BODY_DELAY_MS = 400;
  try {
    const secretsPath = await secrets(dir);
    const { state, fetcher: inner } = textReviewFixture();
    // A real Response whose headers resolve at once but whose JSON body only finishes streaming after BODY_DELAY_MS.
    const fetcher = async (url, init) => {
      const text = JSON.stringify(await (await inner(url, init)).json());
      const enc = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(text.slice(0, 10)));
          setTimeout(() => { controller.enqueue(enc.encode(text.slice(10))); controller.close(); }, BODY_DELAY_MS);
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const res = await runHeadToHead({
      runDir: dir, secretsPath, outDir: join(dir, 'out'), confirmSpend: true, fetcher, stateList: [state],
      models: ['meta/muse-spark-1.3-contributor'], tasks: ['sage-prompt-review'],
    });
    const [r] = res.results;
    assert.equal(r.valid, true, r.gateError);
    assert.equal(r.turns.length, 1);
    const [turn] = r.turns;
    assert.ok(turn.ms >= BODY_DELAY_MS - 20, `ms ${turn.ms} should include the ${BODY_DELAY_MS}ms body`);
    assert.ok(turn.ttfbMs < BODY_DELAY_MS - 20, `ttfbMs ${turn.ttfbMs} should stop at the headers`);
    assert.ok(turn.ms >= turn.ttfbMs);
    assert.equal(r.reasoningTokens, 40);
  } finally {
    await rm(dir, { recursive: true });
  }
});
