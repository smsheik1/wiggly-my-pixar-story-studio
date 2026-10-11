import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { CodexHost } from '../runtime/codex-host.mjs';

function fakeChild({ onWrite = () => {}, killImpl = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.written = [];
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      child.written.push(chunk.toString());
      try { onWrite(chunk.toString()); } catch {}
      cb();
    },
  });
  child.stdin.on('error', () => {});
  child.killCalled = null;
  child.kill = (sig) => { child.killCalled = sig; if (killImpl) killImpl(sig); };
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test('1. missing codex binary fails fast with CODEX_HOST_START_FAILED, not the 10-minute timeout', { timeout: 5000 }, async (t) => {
  const start = Date.now();
  const child = fakeChild();
  const host = new CodexHost({ cwd: '/tmp/isolated', spawnProcess: () => child, timeoutMs: 600000 });
  t.after(() => { try { host.close(); } catch {} });
  queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })));
  await assert.rejects(host.initialize(), /CODEX_HOST_START_FAILED: codex not found/);
  assert.ok(Date.now() - start < 1000, `failed fast, took ${Date.now() - start}ms`);
});

test('2. early app-server exit fails fast and writes nothing after the exit', { timeout: 5000 }, async (t) => {
  const child = fakeChild();
  const host = new CodexHost({ cwd: '/tmp/isolated', spawnProcess: () => child, timeoutMs: 600000 });
  t.after(() => { try { host.close(); } catch {} });
  queueMicrotask(() => { child.exitCode = 1; child.emit('exit', 1, null); });
  const start = Date.now();
  await assert.rejects(host.initialize(), /CODEX_HOST_START_FAILED: .*exited early/);
  assert.ok(Date.now() - start < 1000);
  const writtenAfter = child.written.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(child.written.length, writtenAfter, 'nothing written after exit');
});

test('3. silent app-server that never answers the handshake is killed with SIGKILL', { timeout: 5000 }, async (t) => {
  const child = fakeChild();
  const host = new CodexHost({ cwd: '/tmp/isolated', spawnProcess: () => child, timeoutMs: 600000, startTimeoutMs: 50 });
  t.after(() => { try { host.close(); } catch {} });
  await assert.rejects(host.initialize(), /no app-server handshake within/);
  assert.equal(child.killCalled, 'SIGKILL');
});

test('4. healthy handshake keeps CODEX_HOST_EXITED and CODEX_TIMEOUT behaviour', { timeout: 5000 }, async (t) => {
  const child = fakeChild();
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      for (const line of chunk.toString().trim().split('\n')) {
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        if (req.method === 'initialize') child.stdout.write(JSON.stringify({ id: req.id, result: { ok: true } }) + '\n');
      }
      cb();
    },
  });
  child.stdin.on('error', () => {});
  const host = new CodexHost({ cwd: '/tmp/isolated', spawnProcess: () => child, timeoutMs: 50 });
  t.after(() => { try { host.close(); } catch {} });
  await host.initialize();
  assert.equal(host.started, true);
  child.exitCode = 1;
  child.emit('exit', 1, null);
  await assert.rejects(host.call('thread/start', {}), /CODEX_HOST_EXITED/);
  const childB = fakeChild();
  childB.stdin = new Writable({
    write(chunk, _enc, cb) {
      for (const line of chunk.toString().trim().split('\n')) {
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        if (req.method === 'initialize') childB.stdout.write(JSON.stringify({ id: req.id, result: { ok: true } }) + '\n');
      }
      cb();
    },
  });
  childB.stdin.on('error', () => {});
  const hostB = new CodexHost({ cwd: '/tmp/isolated', spawnProcess: () => childB, timeoutMs: 50, startTimeoutMs: 5000 });
  t.after(() => { try { hostB.close(); } catch {} });
  await hostB.initialize();
  await assert.rejects(hostB.call('thread/start', {}), /CODEX_TIMEOUT/);
});

test('5. start failure never echoes secrets or run-dir paths', { timeout: 5000 }, async (t) => {
  const token = 'LEAKY-TOKEN-777-XYZ';
  const cwd = `/tmp/isolated-${token}-run`;
  const child = fakeChild();
  const host = new CodexHost({ cwd, spawnProcess: () => child, timeoutMs: 600000 });
  t.after(() => { try { host.close(); } catch {} });
  queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })));
  const err = await host.initialize().then(() => null, (e) => e);
  assert.ok(err);
  assert.match(err.message, /CODEX_HOST_START_FAILED/);
  assert.equal(err.message.includes(token), false);
  assert.equal(err.message.includes(cwd), false);
});
