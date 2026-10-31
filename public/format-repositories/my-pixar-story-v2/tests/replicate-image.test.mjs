import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateNanoBanana, missingReplicateTokenError, NANO_BANANA_MODEL, saveNanoBanana } from '../scripts/replicate-image.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, rm } from 'node:fs/promises';

test('a still is Nano Banana 2.1 on Replicate with the crew prompt and the reference image', async () => {
  const bodies = [];
  const urls = [];
  const fetchFn = async (url, init) => {
    urls.push(String(url));
    if (String(url).endsWith('/files')) {
      return new Response(JSON.stringify({ urls: { get: 'https://replicate.delivery/ref.png' } }), { status: 201 });
    }
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({
      id: 'pred-still',
      status: 'succeeded',
      output: 'https://replicate.delivery/still.png',
      metrics: { image_output_count: 1, resolution_target: '2K' },
    }), { status: 201 });
  };
  const result = await generateNanoBanana({
    prompt: 'full body stylized character on gray',
    aspectRatio: '16:9',
    resolution: '2K',
    referencePaths: [],
    apiKey: 'test-token',
    fetchFn,
  });
  assert.equal(result.url, 'https://replicate.delivery/still.png');
  assert.equal(result.id, 'pred-still');
  assert.equal(urls[0], `https://api.replicate.com/v1/models/${NANO_BANANA_MODEL}/predictions`);
  assert.equal(bodies[0].input.prompt, 'full body stylized character on gray');
  assert.equal(bodies[0].input.aspect_ratio, '16:9');
  assert.equal(bodies[0].input.resolution, '2K');
  assert.equal(bodies[0].input.image_input, undefined);
});

test('a missing Replicate token stops before any request', async () => {
  let calls = 0;
  await assert.rejects(
    () => generateNanoBanana({ prompt: 'x', apiKey: '', fetchFn: async () => { calls += 1; return new Response('{}'); } }),
    /REPLICATE_API_TOKEN/,
  );
  assert.equal(calls, 0);
  assert.match(missingReplicateTokenError(), /https:\/\/replicate.com\/account\/api-tokens/);
});

test('saveNanoBanana defaults fetchFn and writes bytes to destination', async () => {
  const dest = join(tmpdir(), `test-nano-banana-${Date.now()}.png`);
  const fakePng = Buffer.from('fake-png-data');
  const fetchFn = async (url) => {
    if (String(url).endsWith('/predictions')) {
      return new Response(JSON.stringify({
        id: 'pred-save',
        status: 'succeeded',
        output: 'https://replicate.delivery/out.png',
      }), { status: 201 });
    }
    if (String(url).includes('out.png')) {
      return new Response(fakePng, { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  try {
    const res = await saveNanoBanana({
      prompt: 'test prompt',
      dest,
      apiKey: 'test-token',
      fetchFn,
    });
    assert.equal(res.dest, dest);
    assert.equal(res.bytes, fakePng.length);
    const diskBytes = await readFile(dest);
    assert.deepEqual(diskBytes, fakePng);
  } finally {
    await rm(dest, { force: true });
  }
});
