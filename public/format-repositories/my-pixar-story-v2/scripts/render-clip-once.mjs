#!/usr/bin/env node
// Render ONE compiled clip on Replicate exactly once (no retries, no resubmit). Guard file blocks a second submit.
// Usage: node scripts/render-clip-once.mjs --run <runId> --clip <n> --out <mp4> --duration <s> [--resolution 480p] [--max-usd 3.1]
import { readFile, writeFile, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { loadSecrets, defaultSecretsPath } from './lib/secrets.mjs';
import { RUNS_ROOT } from '../graph/deep-agent-node.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const dir = join(RUNS_ROOT, arg('--run')), clip = arg('--clip'), out = arg('--out'), duration = Number(arg('--duration')), resolution = arg('--resolution', '480p');
const VERSION = 'ca38262bae0952bf80a7f10eda58af860a0eae7d48957a099e32632792b8f116', USD_PER_S = { '480p': 0.1028 };
const est = duration * USD_PER_S[resolution];
if (!(est <= Number(arg('--max-usd', '3.1')))) throw new Error(`estimate $${est} over cap`);
const guard = join(dir, `clip-${clip}.render.json`);
if (await access(guard).then(() => true, () => false)) throw new Error(`already submitted (${guard}); not resubmitting`);
const key = loadSecrets(defaultSecretsPath(), (n) => n === 'REPLICATE_API_TOKEN').REPLICATE_API_TOKEN;
const H = { Authorization: `Bearer ${key}` };
const prompt = await readFile(join(dir, `clip-${clip}.send.txt`), 'utf8');
const refs = JSON.parse(await readFile(join(dir, `clip-${clip}.refs.json`), 'utf8'));
const urls = [];
for (const r of refs) {
  const fd = new FormData(); const b = await readFile(r.file);
  fd.append('content', new Blob([b], { type: r.file.endsWith('.png') ? 'image/png' : 'image/jpeg' }), basename(r.file));
  const res = await fetch('https://api.replicate.com/v1/files', { method: 'POST', headers: H, body: fd });
  if (!res.ok) throw new Error(`upload ${r.image} failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  urls.push((await res.json()).urls.get); console.log('uploaded', r.image, basename(r.file));
}
const input = { prompt, duration, resolution, aspect_ratio: '16:9', generate_audio: true, reference_images: urls };
await writeFile(guard, JSON.stringify({ submittedAt: new Date().toISOString(), estimateUsd: est, input: { ...input, prompt: `clip-${clip}.send.txt` } }, null, 2));
const res = await fetch('https://api.replicate.com/v1/predictions', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: VERSION, input }) });
let p = await res.json();
if (!res.ok || !p.id) { await writeFile(guard, JSON.stringify({ error: p, status: res.status }, null, 2)); throw new Error(`create failed ${res.status}: ${JSON.stringify(p).slice(0, 400)}`); }
console.log('prediction', p.id);
await writeFile(guard, JSON.stringify({ id: p.id, estimateUsd: est }, null, 2));
while (!['succeeded', 'failed', 'canceled'].includes(p.status)) {
  await new Promise((r) => setTimeout(r, 10000));
  const g = await fetch(`https://api.replicate.com/v1/predictions/${p.id}`, { headers: H }); if (g.ok) p = await g.json();
  console.log(new Date().toISOString(), p.status);
}
const rec = { id: p.id, status: p.status, error: p.error ?? null, metrics: p.metrics ?? null, estimateUsd: est, createdAt: p.created_at, completedAt: p.completed_at };
await writeFile(guard, JSON.stringify(rec, null, 2));
if (p.status !== 'succeeded') { console.log('FAILED', JSON.stringify(rec)); process.exit(1); }
const url = Array.isArray(p.output) ? p.output[0] : p.output;
const v = await fetch(url); await writeFile(out, Buffer.from(await v.arrayBuffer()));
console.log('saved', out, JSON.stringify(rec));
