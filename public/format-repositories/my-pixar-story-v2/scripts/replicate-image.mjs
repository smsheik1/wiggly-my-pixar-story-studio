// Nano Banana 2.1 stills through the Replicate API. Google Flow is not this path.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { existsSync } from 'node:fs';

export const NANO_BANANA_MODEL = 'google/nano-banana-2.1';
const PREDICT_URL = `https://api.replicate.com/v1/models/${NANO_BANANA_MODEL}/predictions`;

export function missingReplicateTokenError() {
  return [
    'Replicate is not connected. REPLICATE_API_TOKEN is missing, so Nano Banana 2.1 cannot render.',
    '1. Open https://replicate.com/account/api-tokens',
    '2. Copy the API token.',
    '3. Open secrets.env at ~/Projects/wiggly/secrets.env',
    '4. Add a line: REPLICATE_API_TOKEN=r8_...',
    '5. Save the file and run the render again.',
  ].join('\n');
}

function outputUrl(output) {
  if (typeof output === 'string' && output.startsWith('http')) return output;
  if (Array.isArray(output)) {
    const found = output.find((item) => typeof item === 'string' && item.startsWith('http'));
    if (typeof found === 'string') return found;
  }
  return '';
}

async function uploadReference(filePath, apiKey, fetchFn) {
  if (!existsSync(filePath)) throw new Error(`Reference image is missing: ${filePath}`);
  const bytes = await readFile(filePath);
  const type = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const body = new FormData();
  body.append('content', new Blob([bytes], { type }), basename(filePath));
  const response = await fetchFn('https://api.replicate.com/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.urls?.get) {
    throw new Error(`Replicate file upload failed: HTTP ${response.status}`);
  }
  return payload.urls.get;
}

export async function generateNanoBanana({
  prompt,
  aspectRatio = '1:1',
  resolution = '1K',
  referencePaths = [],
  apiKey,
  fetchFn = globalThis.fetch,
  pollIntervalMs = 2000,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!apiKey?.trim()) throw new Error(missingReplicateTokenError());
  if (!prompt?.trim()) throw new Error('Nano Banana 2.1 needs the crew prompt. An empty prompt is not a still.');
  const imageInput = [];
  for (const filePath of referencePaths) imageInput.push(await uploadReference(filePath, apiKey, fetchFn));
  const input = {
    prompt: prompt.trim(),
    aspect_ratio: aspectRatio,
    resolution,
    ...(imageInput.length ? { image_input: imageInput } : {}),
  };
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Prefer: 'wait=5' };
  const created = await fetchFn(PREDICT_URL, { method: 'POST', headers, body: JSON.stringify({ input }) });
  let prediction = await created.json().catch(() => null);
  if (!created.ok || !prediction?.id) {
    throw new Error(`${NANO_BANANA_MODEL} failed: HTTP ${created.status} ${JSON.stringify(prediction)}`);
  }
  for (let attempt = 0; attempt < 180 && ['starting', 'processing'].includes(prediction.status); attempt += 1) {
    await wait(pollIntervalMs);
    const pollUrl = prediction.urls?.get || `https://api.replicate.com/v1/predictions/${prediction.id}`;
    const polled = await fetchFn(pollUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    prediction = await polled.json().catch(() => null);
    if (!polled.ok) throw new Error(`${NANO_BANANA_MODEL} poll failed: HTTP ${polled.status}`);
  }
  if (prediction.status !== 'succeeded') {
    throw new Error(`${NANO_BANANA_MODEL} ${prediction.status || 'did not finish'}: ${prediction.error || prediction.id}`);
  }
  const url = outputUrl(prediction.output);
  if (!url) throw new Error(`${NANO_BANANA_MODEL} returned no image URL. Prediction ${prediction.id}.`);
  return { url, id: prediction.id, metrics: prediction.metrics ?? {} };
}

export async function saveNanoBanana({ dest, ...options }) {
  const generated = await generateNanoBanana(options);
  const image = await options.fetchFn(generated.url);
  if (!image.ok) throw new Error(`Nano Banana image download failed: HTTP ${image.status}`);
  const bytes = Buffer.from(await image.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, bytes);
  return { ...generated, dest, bytes: bytes.length };
}
