import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OpenRouterHost, modelTraits} from '../runtime/openrouter-host.mjs';
import {CrewHost} from '../runtime/crew-host.mjs';
import {loadStudio} from '../runtime/instructions.mjs';
import {runCrewTask} from '../runtime/crew.mjs';
import {taskFor} from '../runtime/workflow.mjs';

const secrets = async (dir, key = 'ISOLATED-OPENROUTER-KEY') => {
  const p = join(dir, 'secrets.env');
  await writeFile(p, `OPENROUTER_API_KEY=${key}\n`);
  return p;
};

const verifyOk = (model, content = 'pong') => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({
    model,
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
  }),
});

test('1. Binding a Muse role: verify body has reasoning.effort === low, no enabled:false, no response_format, max_tokens === 512', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-verify-'));
  try {
    const secretsPath = await secrets(dir);
    const bodies = [];
    const host = new OpenRouterHost({
      cwd: dir,
      secretsPath,
      fetcher: async (url, init) => {
        bodies.push(JSON.parse(init.body));
        return verifyOk('meta/muse-spark-1.3-contributor');
      },
    });
    await host.startRole('visual-reviewer', { name: 'Vera', model: 'meta/muse-spark-1.3-contributor' });
    assert.equal(bodies.length, 1);
    const body = bodies[0];
    assert.equal(body.reasoning?.effort, 'low');
    assert.equal(body.reasoning?.enabled, undefined);
    assert.ok(!('response_format' in body));
    assert.equal(body.max_tokens, 512);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('2. Muse runTask with forced tool sends reasoning.effort and never enabled:false; DeepSeek sends enabled:false', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-forced-tool-'));
  try {
    const secretsPath = await secrets(dir);
    const bodies = [];
    const host = new OpenRouterHost({
      cwd: dir,
      secretsPath,
      fetcher: async (url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        return verifyOk(body.model);
      },
    });

    // Forced tool call for Muse
    await host.chat({
      model: 'meta/muse-spark-1.3-contributor',
      messages: [{ role: 'user', content: 'test' }],
      toolChoice: { type: 'function', function: { name: 'wiggly_tool' } },
    });
    const museBody = bodies[0];
    assert.equal(museBody.reasoning?.effort, 'xhigh');
    assert.equal(museBody.reasoning?.enabled, undefined);

    // Forced tool call for DeepSeek
    await host.chat({
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'test' }],
      toolChoice: { type: 'function', function: { name: 'wiggly_tool' } },
    });
    const deepseekBody = bodies[1];
    assert.deepEqual(deepseekBody.reasoning, { enabled: false });
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('3. Muse runTask normal turn sends its production reasoning.effort xhigh, json_schema wrapper, and price policy Muse satisfies', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-normal-turn-'));
  try {
    const secretsPath = await secrets(dir);
    const bodies = [];
    const host = new OpenRouterHost({
      cwd: dir,
      secretsPath,
      model: 'meta/muse-spark-1.3-contributor',
      fetcher: async (url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            model: 'meta/muse-spark-1.3-contributor',
            choices: [{
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({ eventJson: JSON.stringify({ taskId: 't1', actor: 'agent', action: 'artifact', content: {} }) }),
              },
            }],
          }),
        };
      },
    });
    const worker = {
      workerId: 'openrouter:text-reviewer:test',
      name: 'Sage',
      role: 'text-reviewer',
      modelVersion: 'meta/muse-spark-1.3-contributor',
      capabilityVersion: await host.profile(),
      backend: 'openrouter',
    };
    const task = { step: 'script', taskId: 't1', actor: 'agent', gate: 'author', workflowRevision: 2 };
    await host.runTask(task, { worker, callTool: async () => {} });
    assert.equal(bodies.length, 1);
    const body = bodies[0];
    assert.equal(body.reasoning?.effort, 'xhigh');
    assert.equal(body.max_tokens, 32000);
    assert.equal(body.reasoning?.enabled, undefined);
    assert.equal(body.response_format?.type, 'json_schema');
    assert.equal(body.response_format?.json_schema?.name, 'event');
    // Muse price ($0.10 in / $0.20 out) satisfies max_price {prompt: 0.3, completion: 1.2}
    assert.ok(body.provider?.max_price?.prompt >= 0.10);
    assert.ok(body.provider?.max_price?.completion >= 0.20);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('4. Vera on OpenRouter: CrewHost routes Vera to OpenRouterHost, backgroundCandidates task sends 3 image_url parts, toolEvidence contains viewImage', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vera-openrouter-'));
  try {
    const secretsPath = await secrets(dir);
    const bodies = [];
    const museModel = 'meta/muse-spark-1.3-contributor';

    const baseStudio = loadStudio();
    const studioConfig = structuredClone(baseStudio.config);
    studioConfig.agents['visual-reviewer'] = {
      name: 'Vera',
      backend: 'openrouter',
      model: museModel,
      skill: 'crew/vera/SKILL.md',
      tools: ['readAsset', 'viewImage', 'watchVideo'],
    };

    let currentTaskId = 'task-bg';
    const host = new OpenRouterHost({
      cwd: dir,
      secretsPath,
      model: museModel,
      fetcher: async (url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        const reviewEvent = {
          taskId: currentTaskId,
          actor: 'reviewer',
          action: 'review',
          workerId: 'openrouter:visual-reviewer:vera',
          review: {
            decision: 'approved',
            perception: 'direct-image',
            modelVersion: museModel,
            checks: [
              { criterion: 'scene-fit', status: 'pass', evidence: 'good', location: 'all' },
              { criterion: 'style', status: 'pass', evidence: 'good', location: 'all' },
              { criterion: 'story-specific-set', status: 'pass', evidence: 'good', location: 'all' },
              { criterion: 'empty-environment', status: 'pass', evidence: 'good', location: 'all' },
              { criterion: 'spatial-action', status: 'pass', evidence: 'good', location: 'all' },
              { criterion: 'continuity', status: 'pass', evidence: 'good', location: 'all' },
            ],
            recommendation: { selection: 0, ranking: [0, 1, 2], reason: 'Option 0 is best' },
          },
        };
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            model: museModel,
            choices: [{
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({ eventJson: JSON.stringify(reviewEvent) }),
              },
            }],
          }),
        };
      },
    });

    const crewHost = new CrewHost({ openrouter: host, config: studioConfig });
    const capabilityVersion = await host.profile();
    const worker = {
      workerId: 'openrouter:visual-reviewer:vera',
      name: 'Vera',
      role: 'visual-reviewer',
      modelVersion: museModel,
      capabilityVersion,
      execution: 'host',
      backend: 'openrouter',
    };

    assert.equal(crewHost.hostFor(worker), host);

    // Build backgroundCandidates artifact with 3 valid 16:9 images
    const { execFileSync } = await import('node:child_process');
    const { importMedia } = await import('../runtime/media.mjs');
    const raw0 = join(dir, 'raw0.png');
    const raw1 = join(dir, 'raw1.png');
    const raw2 = join(dir, 'raw2.png');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:d=1', '-frames:v', '1', raw0], { timeout: 20000, killSignal: 'SIGKILL' });
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=1920x1080:d=1', '-frames:v', '1', raw1], { timeout: 20000, killSignal: 'SIGKILL' });
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:d=1', '-frames:v', '1', raw2], { timeout: 20000, killSignal: 'SIGKILL' });
    const file0 = await importMedia(raw0, dir);
    const file1 = await importMedia(raw1, dir);
    const file2 = await importMedia(raw2, dir);

    const bgPromptArt = {
      id: 'backgroundPrompt:loc1@1',
      key: 'backgroundPrompt:loc1',
      kind: 'backgroundPrompt',
      version: 1,
      digest: 'p'.repeat(64),
      content: { prompt: 'bedroom', recipeSha256: 'r'.repeat(64), briefDigest: 'b'.repeat(64), changeSummary: 'first' },
      dependencies: [],
      valid: true,
      authoredBy: 'author0',
      approvedBy: { message: 'approved', at: new Date().toISOString() },
    };

    const artifactObj = {
      id: 'backgroundCandidates:loc1@1',
      key: 'backgroundCandidates:loc1',
      kind: 'backgroundCandidates',
      version: 1,
      digest: 'd'.repeat(64),
      content: { files: [file0, file1, file2], prompt: 'bedroom' },
      dependencies: [bgPromptArt.id],
      valid: true,
      authoredBy: 'author1',
    };

    const projectState = {
      id: 'proj1',
      step: 'backgroundCandidates',
      gate: 'review',
      sequence: 1,
      locationId: 'loc1',
      reviewMode: 'supervised',
      studio: {
        config: studioConfig,
        documents: baseStudio.documents,
        sha256: (await import('../runtime/contracts.mjs')).digest({ config: studioConfig, documents: baseStudio.documents }),
      },
      artifacts: [bgPromptArt, artifactObj],
      crew: {
        workers: [
          worker,
          ...Object.keys(studioConfig.agents)
            .filter(r => r !== 'visual-reviewer')
            .map(r => ({ workerId: `dummy:${r}`, name: 'Dummy', role: r, modelVersion: 'm', capabilityVersion: 'c', execution: 'host' })),
        ],
      },
      jobs: [],
      history: [],
      feedback: [],
      reviewDisagreements: 0,
    };

    const taskObj = taskFor(projectState);
    currentTaskId = taskObj.taskId;

    const event = await runCrewTask(projectState, taskObj, crewHost);
    assert.equal(event.action, 'review');
    assert.equal(event.review?.decision, 'approved');

    // Check request bodies had 3 image_url parts
    const taskTurn = bodies[0];
    const userMsg = taskTurn.messages.find(m => m.role === 'user');
    const imageUrlParts = userMsg.content.filter(p => p.type === 'image_url');
    assert.equal(imageUrlParts.length, 3);

    // toolEvidence must contain viewImage for each file sha256
    assert.ok(event.review?.toolEvidence);
    const seenEvidenceHashes = event.review.toolEvidence.filter(e => e.tool === 'viewImage').map(e => e.sha256);
    assert.ok(seenEvidenceHashes.includes(file0.sha256));
    assert.ok(seenEvidenceHashes.includes(file1.sha256));
    assert.ok(seenEvidenceHashes.includes(file2.sha256));
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('5. Text-only model on a role with viewImage throws OPENROUTER_VISION_UNSUPPORTED at startRole and runTask', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'text-only-vision-'));
  try {
    const secretsPath = await secrets(dir);
    let fetchCalled = false;
    const host = new OpenRouterHost({
      cwd: dir,
      secretsPath,
      model: 'acme/text-only',
      fetcher: async () => {
        fetchCalled = true;
        throw new Error('should not fetch');
      },
    });

    // startRole with viewImage role ('text-reviewer' has viewImage in studio.json)
    await assert.rejects(
      host.startRole('text-reviewer', { name: 'Sage', model: 'acme/text-only' }),
      err => {
        assert.match(err.message, /OPENROUTER_VISION_UNSUPPORTED/);
        assert.equal(err.stopDispatch, true);
        return true;
      }
    );
    assert.equal(fetchCalled, false);

    // runTask with image assets
    const worker = {
      workerId: 'openrouter:text-reviewer:test',
      name: 'Sage',
      role: 'text-reviewer',
      modelVersion: 'acme/text-only',
      capabilityVersion: await host.profile(),
      backend: 'openrouter',
    };
    const refFile = { path: join(dir, 'test.png'), sha256: 'a'.repeat(64), bytes: 50, width: 100, height: 100 };
    await writeFile(refFile.path, 'dummy');

    const task = {
      step: 'script',
      taskId: 't-text',
      actor: 'agent',
      gate: 'author',
      workflowRevision: 2,
      artifact: { content: { files: [refFile] } },
    };

    await assert.rejects(
      host.runTask(task, { worker, callTool: async () => {} }),
      err => {
        assert.match(err.message, /OPENROUTER_VISION_UNSUPPORTED/);
        assert.equal(err.stopDispatch, true);
        return true;
      }
    );
    assert.equal(fetchCalled, false);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('6. profile() differs between DeepSeek and Muse hosts', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'profile-diff-'));
  try {
    const secretsPath = await secrets(dir);
    const deepseekHost = new OpenRouterHost({ cwd: dir, secretsPath, model: 'deepseek/deepseek-v4.1-flash' });
    const museHost = new OpenRouterHost({ cwd: dir, secretsPath, model: 'meta/muse-spark-1.3-contributor' });

    const dsProfile = await deepseekHost.profile();
    const museProfile = await museHost.profile();

    assert.notEqual(dsProfile, museProfile);
    assert.match(dsProfile, /^[a-f0-9]{64}$/);
    assert.match(museProfile, /^[a-f0-9]{64}$/);
  } finally {
    await rm(dir, { recursive: true });
  }
});
