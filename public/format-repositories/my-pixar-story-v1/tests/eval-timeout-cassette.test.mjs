import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cassette, recordingFetcher } from '../runtime/cassette.mjs';
import { DEPT_EVAL_HOST_TIMEOUT_MS } from '../evaluation/dept-evals.mjs';

const T = { timeout: 20000 };

test('cassette recording surfaces the real body-read error (e.g. a timeout), never "Body has already been read"', T, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cassette-bodyerr-'));
  try {
    const cassette = await Cassette.create(dir, { type: 'header', test: true }, { secrets: [] });
    const failingBody = new ReadableStream({ pull(controller) { controller.error(new Error('The operation was aborted due to timeout')); } });
    const fake = async () => new Response(failingBody, { status: 200, headers: { 'content-type': 'application/json' } });
    const fetcher = recordingFetcher(cassette, 'openrouter', fake);
    await assert.rejects(fetcher('https://example.invalid/x', { method: 'POST', body: '{}' }), e => /aborted due to timeout/.test(e.message) && !/already been read/.test(e.message));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cassette recording keeps a non-JSON body served as application/json as text; dept-eval host timeout matches the studio runner', T, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cassette-text-'));
  try {
    const cassette = await Cassette.create(dir, { type: 'header', test: true }, { secrets: [] });
    const fake = async () => new Response('upstream said: not json', { status: 200, headers: { 'content-type': 'application/json' } });
    const resp = await recordingFetcher(cassette, 'openrouter', fake)('https://example.invalid/x', { method: 'POST', body: '{}' });
    assert.equal(await resp.text(), 'upstream said: not json');
    const lines = (await readFile(join(dir, 'cassette.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l)).filter(e => e.type === 'http');
    assert.equal(lines.at(-1).response.body, 'upstream said: not json');
    const runner = await readFile(new URL('../runner.mjs', import.meta.url), 'utf8');
    assert.match(runner, new RegExp(`new OpenRouterHost\\(\\{[^\\n]*timeoutMs:${DEPT_EVAL_HOST_TIMEOUT_MS}`), 'evals use the same OpenRouter timeout as studio runs');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
