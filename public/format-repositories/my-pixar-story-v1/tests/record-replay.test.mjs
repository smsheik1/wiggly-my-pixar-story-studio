import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  normalizeForCassette,
  Cassette,
  replayFetcher,
  replaySpawn
} from '../runtime/cassette.mjs';
import { makeSolidPng, sha256Hex } from './fixtures/cassettes/make-synthetic.mjs';
import { OpenRouterHost, DEFAULT_OPENROUTER_MODEL } from '../runtime/openrouter-host.mjs';
import { CodexHost } from '../runtime/codex-host.mjs';
import { replayCassette } from './helpers/replay.mjs';
import { openWorkflow } from '../runtime/workflow.mjs';
import { loadStudio } from '../runtime/instructions.mjs';
import { crewRoles } from '../runtime/crew.mjs';
import { inputs, questionnaire } from './helpers.mjs';
import { GEMINI_REVIEW_PROFILE } from '../runtime/gemini-review.mjs';
import { CARTESIA_STT_PROFILE } from '../runtime/cartesia-stt.mjs';
import { AUDIO_EDIT_PROFILE } from '../runtime/audio-edit.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('1. normalizeForCassette normalizes binary/data URLs and redacts secrets; writer throws CASSETTE_SECRET_LEAK', async () => {
  const pngBytes = makeSolidPng(8, 8, 255, 0, 0);
  const pngHash = sha256Hex(pngBytes);
  const dataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`;

  const secrets = ['SUPER_SECRET_TOKEN_123', 'ANOTHER_KEY_XYZ'];

  // Test 1: data URL replaced with data:<mime>;sha256,<hex>
  const normStr = await normalizeForCassette(`Here is an image: ${dataUrl}`, { secrets });
  assert.equal(normStr, `Here is an image: data:image/png;sha256,${pngHash}`);

  // Test 2: Gemini inline media part {data:<base64>, mime_type} -> {sha256, bytes, mime_type}
  const geminiPart = {
    data: pngBytes.toString('base64'),
    mime_type: 'image/png'
  };
  const normGemini = await normalizeForCassette(geminiPart, { secrets });
  assert.deepEqual(normGemini, {
    sha256: pngHash,
    bytes: pngBytes.length,
    mime_type: 'image/png'
  });

  // Test 3: Buffer / Uint8Array / Blob bodies
  const normBuf = await normalizeForCassette(pngBytes, { secrets });
  assert.deepEqual(normBuf, {
    binarySha256: pngHash,
    bytes: pngBytes.length
  });

  const blob = new Blob([pngBytes], { type: 'image/png' });
  const normBlob = await normalizeForCassette(blob, { secrets });
  assert.deepEqual(normBlob, {
    binarySha256: pngHash,
    bytes: pngBytes.length
  });

  // Test 4: FormData
  const fd = new FormData();
  fd.append('username', 'alice');
  fd.append('file', blob, 'pic.png');
  const normFd = await normalizeForCassette(fd, { secrets });
  assert.deepEqual(normFd, [
    { name: 'username', value: 'alice' },
    { name: 'file', value: { binarySha256: pngHash, bytes: pngBytes.length } }
  ]);

  // Test 5: Secret redaction in strings, URLs, headers
  const objWithSecret = {
    url: 'https://api.example.com/v1?token=SUPER_SECRET_TOKEN_123',
    headers: { 'x-api-key': 'SUPER_SECRET_TOKEN_123' },
    error: 'Failed with key ANOTHER_KEY_XYZ'
  };
  const normSecrets = await normalizeForCassette(objWithSecret, { secrets });
  assert.equal(normSecrets.url, 'https://api.example.com/v1?token=[REDACTED]');
  assert.equal(normSecrets.headers['x-api-key'], '[REDACTED]');
  assert.equal(normSecrets.error, 'Failed with key [REDACTED]');

  // Test 6: Cassette.writeLine throws CASSETTE_SECRET_LEAK when leaked
  const dir = await mkdtemp(join(tmpdir(), 'memoir-leak-test-'));
  try {
    const c = await Cassette.create(dir, { type: 'header', version: 1 }, { secrets });
    await assert.rejects(
      async () => {
        await c.writeLine({ leak: 'this contains SUPER_SECRET_TOKEN_123' });
      },
      /CASSETTE_SECRET_LEAK/
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('2. OpenRouter replay from openrouter-synthetic.jsonl returns identical event with zero network', async () => {
  const cassettePath = join(root, 'tests', 'fixtures', 'cassettes', 'openrouter-synthetic.jsonl');
  const cassette = await Cassette.open(cassettePath);

  // Replay fetcher must never touch real network
  const fetcher = replayFetcher(cassette, 'openrouter');
  const dir = await mkdtemp(join(tmpdir(), 'memoir-or-replay-'));
  try {
    const secretsPath = join(dir, 'secrets.env');
    await writeFile(secretsPath, 'OPENROUTER_API_KEY=dummy\n');

    const host = new OpenRouterHost({
      cwd: dir,
      secretsPath,
      fetcher,
      profileOverride: cassette.header?.profiles?.openrouter
    });

    const pngBytes = makeSolidPng(8, 8, 255, 0, 0);
    const pngHash = sha256Hex(pngBytes);

    // Call chat round 1 as recorded in openrouter-synthetic.jsonl
    const res1 = await host.chat({
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: 'synthetic system prompt' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Task packet with image' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBytes.toString('base64')}` } }
          ]
        }
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'wiggly_tool', description: 'synthetic tool' }
        }
      ]
    });

    assert.equal(res1.tool_calls?.[0]?.function?.name, 'wiggly_tool');

    // Call chat round 2 as recorded
    const res2 = await host.chat({
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: 'synthetic system prompt' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Task packet with image' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBytes.toString('base64')}` } }
          ]
        },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'wiggly_tool',
                arguments: JSON.stringify({ name: 'viewImage', sha256: pngHash, referenceSha256: null })
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: JSON.stringify({ perception: 'direct-image', sha256: pngHash, attached: true, note: 'attached below' })
        },
        {
          type: 'text',
          text: `viewImage result for sha256 ${pngHash}`
        },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${pngBytes.toString('base64')}` }
        }
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'wiggly_tool', description: 'synthetic tool' }
        }
      ]
    });

    const parsedEvent = JSON.parse(JSON.parse(res2.content).eventJson);
    assert.equal(parsedEvent.taskId, 'synthetic-task-1');
    assert.equal(parsedEvent.action, 'artifact');

    // All calls consumed
    assert.doesNotThrow(() => cassette.assertFullyConsumed());
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('3. Changed packet text throws REPLAY_MISMATCH naming call #1 and path under body.messages', async () => {
  const cassettePath = join(root, 'tests', 'fixtures', 'cassettes', 'openrouter-synthetic.jsonl');
  const cassette = await Cassette.open(cassettePath);
  const fetcher = replayFetcher(cassette, 'openrouter');

  const pngBytes = makeSolidPng(8, 8, 255, 0, 0);

  const dir = await mkdtemp(join(tmpdir(), 'memoir-or-test3-'));
  try {
    const secretsPath = join(dir, 'secrets.env');
    await writeFile(secretsPath, 'OPENROUTER_API_KEY=dummy\n');
    const host = new OpenRouterHost({ cwd: dir, secretsPath, fetcher });

    // Send different text in user content
    await assert.rejects(
      async () => {
        await host.chat({
          model: 'deepseek/deepseek-v4.1-flash',
          messages: [
            { role: 'system', content: 'synthetic system prompt' },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'MODIFIED TASK PACKET TEXT' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBytes.toString('base64')}` } }
              ]
            }
          ],
          tools: [
            {
              type: 'function',
              function: { name: 'wiggly_tool', description: 'synthetic tool' }
            }
          ]
        });
      },
      (err) => {
        assert.match(err.message, /REPLAY_MISMATCH: http call #1/);
        assert.match(err.message, /differs at body\.messages\[1\]\.content\[0\]\.text/);
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('4. Changed image (different PNG bytes) yields mismatch on sha256 in data URL', async () => {
  const cassettePath = join(root, 'tests', 'fixtures', 'cassettes', 'openrouter-synthetic.jsonl');
  const cassette = await Cassette.open(cassettePath);
  const fetcher = replayFetcher(cassette, 'openrouter');

  // Green PNG instead of Red PNG
  const greenPngBytes = makeSolidPng(8, 8, 0, 255, 0);

  const dir = await mkdtemp(join(tmpdir(), 'memoir-or-test4-'));
  try {
    const secretsPath = join(dir, 'secrets.env');
    await writeFile(secretsPath, 'OPENROUTER_API_KEY=dummy\n');
    const host = new OpenRouterHost({ cwd: dir, secretsPath, fetcher });

    await assert.rejects(
      async () => {
        await host.chat({
          model: 'deepseek/deepseek-v4.1-flash',
          messages: [
            { role: 'system', content: 'synthetic system prompt' },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Task packet with image' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${greenPngBytes.toString('base64')}` } }
              ]
            }
          ],
          tools: [
            {
              type: 'function',
              function: { name: 'wiggly_tool', description: 'synthetic tool' }
            }
          ]
        });
      },
      (err) => {
        assert.match(err.message, /REPLAY_MISMATCH: http call #1/);
        assert.match(err.message, /data:image\/png;sha256,/);
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('5. Extra call -> REPLAY_EXHAUSTED; missing call -> REPLAY_INCOMPLETE', async () => {
  const cassettePath = join(root, 'tests', 'fixtures', 'cassettes', 'openrouter-synthetic.jsonl');

  // Test missing call -> REPLAY_INCOMPLETE
  const cassette1 = await Cassette.open(cassettePath);
  assert.throws(
    () => {
      cassette1.assertFullyConsumed();
    },
    (err) => {
      assert.match(err.message, /REPLAY_INCOMPLETE: 2 recorded http calls were never made; first unmade: #1/);
      return true;
    }
  );

  // Test extra call -> REPLAY_EXHAUSTED
  const cassette2 = await Cassette.open(cassettePath);
  // Consume the two recorded calls
  cassette2.nextHttpIndex = 2;
  const fetcher = replayFetcher(cassette2, 'openrouter');

  await assert.rejects(
    async () => {
      await fetcher('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({})
      });
    },
    (err) => {
      assert.match(err.message, /REPLAY_EXHAUSTED: http call #1 has no recorded response/);
      return true;
    }
  );
});

test('6. Codex replay from codex-synthetic.jsonl completes turn; changed turn/start input mismatches', async () => {
  const cassettePath = join(root, 'tests', 'fixtures', 'cassettes', 'codex-synthetic.jsonl');
  const cassette1 = await Cassette.open(cassettePath);

  const dir1 = await mkdtemp(join(tmpdir(), 'memoir-codex-replay-1-'));
  try {
    const host = new CodexHost({
      cwd: dir1,
      spawnProcess: replaySpawn(cassette1),
      codexVersion: () => cassette1.header.codexVersion,
      profileOverride: cassette1.header.profiles?.codex
    });

    await host.initialize();
    const result = await host.turn(
      { workerId: 'thr-synthetic-1', name: 'Leo', role: 'script-writer' },
      JSON.stringify({ instruction: 'synthetic turn', task: { taskId: 'synthetic-codex-task-1' } })
    );

    const parsed = JSON.parse(result);
    assert.ok(parsed.eventJson);
    assert.doesNotThrow(() => cassette1.assertFullyConsumed());
    host.close();
  } finally {
    await rm(dir1, { recursive: true });
  }

  // Test changed turn/start input mismatches
  const cassette2 = await Cassette.open(cassettePath);
  const dir2 = await mkdtemp(join(tmpdir(), 'memoir-codex-replay-2-'));
  try {
    const host = new CodexHost({
      cwd: dir2,
      spawnProcess: replaySpawn(cassette2),
      codexVersion: () => cassette2.header.codexVersion,
      profileOverride: cassette2.header.profiles?.codex
    });

    await host.initialize();
    await assert.rejects(
      async () => {
        await host.turn(
          { workerId: 'thr-synthetic-1', name: 'Leo', role: 'script-writer' },
          JSON.stringify({ instruction: 'MODIFIED TURN INPUT', task: { taskId: 'synthetic-codex-task-1' } })
        );
      },
      (err) => {
        assert.match(err.message, /REPLAY_MISMATCH: codex call #4 \(codex turn\/start\)/);
        return true;
      }
    );
    host.close();
  } finally {
    await rm(dir2, { recursive: true });
  }
});

// An all-OpenRouter pinned studio so the CLI never launches a real `codex app-server`
// (absent in CI, where its spawn error left CodexHost.initialize waiting 10 minutes).
async function allOpenRouterStudio(dir) {
  const current = loadStudio();
  const studioDir = join(dir, 'studio-src');
  const raw = structuredClone(current.config);
  for (const agent of Object.values(raw.agents)) { agent.backend = 'openrouter'; agent.model = DEFAULT_OPENROUTER_MODEL; }
  await mkdir(studioDir, { recursive: true });
  await writeFile(join(studioDir, 'studio.json'), JSON.stringify(raw));
  for (const path of Object.keys(current.documents)) {
    await mkdir(dirname(join(studioDir, path)), { recursive: true });
    await writeFile(join(studioDir, path), current.documents[path].content);
  }
  return loadStudio(pathToFileURL(studioDir + '/'));
}

test('7. End-to-end CLI: work-codex --record creates cassette, replay returns ok:true, mutated cassette returns ok:false', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memoir-e2e-record-replay-'));
  try {
    const runnerPath = join(root, 'runner.mjs');
    const mockHttp = join(dir, 'mock-http.mjs');
    const secretsPath = join(dir, 'secrets.env');
    await writeFile(secretsPath, 'OPENROUTER_API_KEY=test-secret-key-12345\n');

    const orHost = new OpenRouterHost({
      cwd: dir,
      secretsPath,
      perceptionProfile: {
        media: GEMINI_REVIEW_PROFILE,
        transcription: CARTESIA_STT_PROFILE,
        audioEditing: AUDIO_EDIT_PROFILE
      }
    });
    const cap = await orHost.profile();

    // Initialize run in sqlite workflow
    const workflow = openWorkflow(join(dir, 'checkpoints.sqlite'));
    const studio = await allOpenRouterStudio(dir);
    let s = await workflow.init('project', inputs, { workflowRevision: 5, studio });
    const studioConfig = studio.config;
    const workers = Object.entries(crewRoles).map(([role, def]) => {
      const backend = studioConfig.agents[role]?.backend ?? 'codex';
      return {
        workerId: `${backend}:${role}:synthetic-id`,
        name: def.name,
        role,
        modelVersion: backend === 'openrouter' ? 'deepseek/deepseek-v4.1-flash' : 'gpt-6.1-sol',
        capabilityVersion: cap,
        execution: 'host',
        backend
      };
    });
    s = await workflow.respond('project', {
      taskId: s.pending.taskId,
      actor: 'human',
      action: 'configure-crew',
      message: 'configure crew',
      crew: { workers }
    });
    // Advance to answers review (role: text-reviewer, backend: openrouter)
    s = await workflow.respond('project', {
      taskId: s.pending.taskId,
      actor: 'agent',
      workerId: s.pending.crewWorker.workerId,
      action: 'artifact',
      content: questionnaire(s.project)
    });
    workflow.close();

    // Create a mock http file that handles OpenRouter chat and verify
    const validQuote = 'I learned to fix bicycles with my dad in our Ohio garage. We laughed when the bell fell off.';
    const reviewEvent = {
      taskId: s.pending.taskId,
      actor: 'reviewer',
      workerId: s.pending.crewWorker.workerId,
      action: 'review',
      artifactId: s.pending.artifact.id,
      artifactDigest: s.pending.artifact.digest,
      review: {
        decision: 'approved',
        perception: 'direct-text',
        modelVersion: s.pending.crewWorker.modelVersion,
        capabilityVersion: cap,
        checks: s.pending.criteria.map((c) => ({
          criterion: c,
          status: 'pass',
          location: 'intake',
          evidence: validQuote,
          repair: '',
          quotes: [validQuote]
        }))
      }
    };

    const mockContent = `
      globalThis.fetch = async (url, init = {}) => {
        const strUrl = url.toString();
        const body = init.body ? JSON.parse(init.body) : {};
        if (strUrl.includes('openrouter.ai')) {
          if (!body.tools || body.tools.length === 0) {
            return new Response(JSON.stringify({
              model: body.model,
              choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }]
            }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return new Response(JSON.stringify({
            model: body.model,
            choices: [{
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({ eventJson: JSON.stringify(${JSON.stringify(reviewEvent)}) })
              }
            }]
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 200 });
      };
    `;
    await writeFile(mockHttp, mockContent);

    // Now run work-codex with --record
    const recordRes = spawnSync(
      process.execPath,
      [
        '--import',
        mockHttp,
        runnerPath,
        'work-codex',
        '--record',
        '--run',
        dir,
        '--secrets',
        secretsPath
      ],
      { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' }
    );
    assert.equal(recordRes.status, 0, `work-codex --record failed: ${recordRes.stderr}`);
    const recordedLines = (await readFile(join(recordRes.stderr.match(/recorded cassette: (.+)/)[1].trim(), 'cassette.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(recordedLines.filter((l) => l.type === 'codex').length, 0, 'the e2e run must never talk to a real codex app-server');
    assert.match(recordRes.stderr, /recorded cassette: (.+)/);

    const match = recordRes.stderr.match(/recorded cassette: (.+)/);
    const cassetteDir = match[1].trim();

    // Verify cassette file content: NO secrets, NO base64
    const jsonlContent = await readFile(join(cassetteDir, 'cassette.jsonl'), 'utf8');
    assert.equal(jsonlContent.includes('test-secret-key-12345'), false, 'Cassette must not contain secret');
    assert.equal(jsonlContent.includes('base64,'), false, 'Cassette must not contain base64');

    // Run replay via test helper
    const replayRes = await replayCassette(cassetteDir);
    assert.equal(replayRes.exitCode, 0, `Replay failed with exitCode ${replayRes.exitCode}: stdout=${replayRes.stdout} stderr=${replayRes.stderr}`);
    assert.equal(replayRes.result?.ok, true);
    assert.equal(replayRes.result?.mismatch, null);
    assert.equal(replayRes.result?.output, 'identical');

    // Mutate the recorded request in cassette.jsonl
    const lines = jsonlContent.trim().split('\n');
    const mutatedLines = lines.map((line) => {
      const obj = JSON.parse(line);
      if (obj.type === 'http' && obj.request) {
        obj.request.url = 'https://openrouter.ai/api/v1/chat/MUTATED';
      }
      return JSON.stringify(obj);
    });
    await writeFile(join(cassetteDir, 'cassette.jsonl'), mutatedLines.join('\n') + '\n');

    // Replay mutated cassette -> must return ok:false with REPLAY_MISMATCH
    const replayMutated = await replayCassette(cassetteDir);
    assert.equal(replayMutated.exitCode, 1);
    assert.equal(replayMutated.result?.ok, false);
    assert.match(replayMutated.result?.mismatch, /REPLAY_MISMATCH/);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('8. Guard: profileOverride appears only in replay path; replay mode blocks globalThis.fetch', async () => {
  const runnerSource = await readFile(join(root, 'runner.mjs'), 'utf8');

  // Assert profileOverride appears ONLY inside replay code path
  const matches = runnerSource.match(/profileOverride/g);
  assert.ok(matches && matches.length > 0);

  // Check lines containing profileOverride
  const lines = runnerSource.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('profileOverride')) {
      // Must be in replay options handling or host construction with replay overrides
      const context = lines.slice(Math.max(0, i - 15), Math.min(lines.length, i + 5)).join('\n');
      assert.ok(
        context.includes('replayCassetteDir') || context.includes('profileOverridden'),
        `profileOverride found outside replay path on line ${i + 1}: ${line}`
      );
    }
  }

  // Check replay mode blocks globalThis.fetch
  assert.match(runnerSource, /globalThis\.fetch\s*=\s*(?:\(\)\s*=>|\(\)\s*=>\s*\{)[\s\S]*?REPLAY_NETWORK_BLOCKED/);
});

test('9. run-dir paths are aliased to <RUN> so a Codex replay in a different sandbox still matches', async () => {
  const recordDir = await mkdtemp(join(tmpdir(), 'memoir-alias-rec-'));
  const replayDir = await mkdtemp(join(tmpdir(), 'memoir-alias-play-'));
  try {
    const msg = { id: 5, method: 'thread/resume', params: { threadId: 'thread-synthetic', cwd: join(recordDir, 'host-workspace') } };
    const recorded = normalizeForCassette(msg, { aliases: { [recordDir]: '<RUN>' } });
    assert.equal(recorded.params.cwd, '<RUN>/host-workspace');
    const cassette = await Cassette.create(join(recordDir, 'c'), { type: 'header', version: 1, argv: [], codexVersion: 'synthetic', profiles: { codex: null, openrouter: null } });
    await cassette.writeLine({ type: 'codex', seq: 1, dir: 'out', message: recorded });
    await cassette.writeLine({ type: 'codex', seq: 2, dir: 'in', message: { id: 5, result: { ok: true } } });
    const play = await Cassette.open(join(recordDir, 'c'));
    play.aliases = { [replayDir]: '<RUN>' };
    const child = replaySpawn(play)('codex', [], {});
    const got = new Promise((resolve) => child.stdout.once('data', (d) => resolve(JSON.parse(String(d)))));
    child.stdin.write(JSON.stringify({ ...msg, params: { ...msg.params, cwd: join(replayDir, 'host-workspace') } }) + '\n');
    assert.deepEqual(await got, { id: 5, result: { ok: true } });
    assert.equal(play.mismatchError, null);
    play.assertFullyConsumed();
  } finally {
    await rm(recordDir, { recursive: true });
    await rm(replayDir, { recursive: true });
  }
});

test('10. CASSETTE_SECRET_LEAK never echoes the secret; runner schema command still works', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memoir-leak-msg-'));
  try {
    const cassette = await Cassette.create(join(dir, 'c'), { type: 'header', version: 1 }, { secrets: ['LEAKY-SECRET-777'] });
    await assert.rejects(cassette.writeLine({ type: 'http', body: 'x LEAKY-SECRET-777' }), (error) => {
      assert.match(error.message, /CASSETTE_SECRET_LEAK/);
      assert.equal(error.message.includes('LEAKY-SECRET-777'), false);
      return true;
    });
    const out = execFileSync(process.execPath, [join(root, 'runner.mjs'), 'schema', 'event', '--run', dir], { encoding: 'utf8' });
    assert.ok(JSON.parse(out));
  } finally {
    await rm(dir, { recursive: true });
  }
});
