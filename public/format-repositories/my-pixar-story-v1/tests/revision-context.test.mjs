import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialProject, current, taskFor } from '../runtime/workflow.mjs';
import { OpenRouterHost, DEFAULT_OPENROUTER_MODEL } from '../runtime/openrouter-host.mjs';
import { inputs, send, authored, reviewed, audioProject } from './helpers.mjs';
import { generated } from './shot-helpers.mjs';

// OpenRouter workers keep no session, so every revision task must itself carry
// the prior version, the reviewer's findings and the human direction.
test('revision tasks carry prior version, reviewer findings and human direction without session memory', () => {
  let p = authored(initialProject('x', inputs, { workflowRevision: 2 })); const v1 = current(p);
  p = reviewed(p, 'rejected'); let t = taskFor(p);
  assert.equal(t.gate, 'author'); assert.equal(t.artifact.id, v1.id); assert.equal(t.artifact.review.decision, 'rejected');
  assert.ok(t.artifact.review.checks.some(c => c.status === 'fail' && c.evidence)); assert.match(JSON.stringify(t.feedback), /fail/);

  let q = audioProject(); const script = current(q, 'script');
  q = send(q, 'changes', { artifactId: script.id, artifactDigest: script.digest, message: 'ISOLATED shorten beat two.' }); t = taskFor(q);
  assert.equal(t.step, 'script'); assert.equal(t.artifact, null);
  assert.equal(t.previousVersion.id, script.id); assert.deepEqual(t.previousVersion.content, script.content);
  assert.equal(t.feedback.at(-1).message, 'ISOLATED shorten beat two.');

  let r = generated(); const frame = current(r); const prompt = current(r, `keyframePrompt:${r.shotId}`);
  r = send(r, 'changes', { artifactId: frame.id, artifactDigest: frame.digest, message: 'ISOLATED improve pose' }); t = taskFor(r);
  assert.equal(t.step, 'keyframePrompt'); assert.equal(t.artifact, null);
  assert.equal(t.previousVersion.id, prompt.id); assert.deepEqual(t.previousVersion.content, prompt.content);
  assert.equal(t.feedback.at(-1).message, 'ISOLATED improve pose');

  assert.equal(taskFor(authored(initialProject('y', inputs, { workflowRevision: 2 }))).previousVersion, undefined);
});

test('OpenRouter revision turn sends the prior version and the human direction in its packet', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memoir-or-revision-'));
  try {
    const secretsPath = join(dir, 'secrets.env'); await writeFile(secretsPath, 'OPENROUTER_API_KEY=ISOLATED-KEY\n');
    let q = audioProject(); const script = current(q, 'script');
    q = send(q, 'changes', { artifactId: script.id, artifactDigest: script.digest, message: 'ISOLATED shorten beat two.' });
    const task = taskFor(q); const bodies = [];
    const host = new OpenRouterHost({ cwd: dir, secretsPath, fetcher: async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: DEFAULT_OPENROUTER_MODEL, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'not json' } }] }) }; } });
    const worker = { workerId: 'openrouter:script-writer:test', name: 'Leo', role: 'script-writer', modelVersion: DEFAULT_OPENROUTER_MODEL, capabilityVersion: await host.profile(), backend: 'openrouter' };
    await assert.rejects(host.runTask(task, { worker, callTool: async () => { throw new Error('unused'); } }));
    const packet = JSON.parse(bodies[0].messages[1].content[0].text);
    assert.deepEqual(packet.task.previousVersion.content, script.content);
    assert.equal(packet.task.feedback.at(-1).message, 'ISOLATED shorten beat two.');
  } finally { await rm(dir, { recursive: true }); }
});
