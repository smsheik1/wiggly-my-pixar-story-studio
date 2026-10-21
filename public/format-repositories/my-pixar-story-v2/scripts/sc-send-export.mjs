#!/usr/bin/env node
// Write each compiled clip exactly as it would be sent (sendPrompt: [ImageN] labels, per-shot storyboard panels,
// engine quote style) plus its ordered reference image list. No network, no render.
// Usage: node scripts/sc-send-export.mjs --run <runId> --refs <refs.json: { "<element tag or sceneId>": "<file path>" }>
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sendPrompt, panelRefs } from '../crew/seedance-compiler/schema.mjs';
import { RUNS_ROOT } from '../graph/deep-agent-node.mjs';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const dir = join(RUNS_ROOT, arg('--run'));
const sc = JSON.parse(await readFile(join(dir, 'outputs', 'seedance-compiler.json'), 'utf8'));
const engine = arg('--engine');
const refs = arg('--refs') ? JSON.parse(await readFile(arg('--refs'), 'utf8')) : {};
const summary = [];
for (const seg of sc.segments) {
  const id = seg.clipId ?? seg.segmentId, { prompt } = sendPrompt(seg, engine ?? seg?.generationPayload?.engine);
  const list = [...seg.references.map((r) => ({ label: r.tag, kind: r.kind, assetKey: r.assetKey, file: refs[r.tag] ?? null })),
    ...panelRefs(seg, engine ?? seg?.generationPayload?.engine).map((p) => ({ label: `storyboard ${p.sceneId}`, kind: 'storyboard', assetKey: p.assetKey, file: refs[p.sceneId] ?? null }))]
    .map((r, i) => ({ image: engine === 'wan-3.0' ? `Image ${i + 1}` : `[Image${i + 1}]`, ...r, exists: !!r.file && existsSync(r.file) }));
  const sfx = engine ? `.${engine}` : '';
  await writeFile(join(dir, `clip-${id}${sfx}.send.txt`), prompt);
  await writeFile(join(dir, `clip-${id}${sfx}.refs.json`), JSON.stringify(list, null, 2));
  summary.push({ clip: id, durationSec: seg.generationPayload.durationSec, chars: prompt.length, images: list.length, missing: list.filter((r) => !r.exists).map((r) => r.label) });
}
console.log(JSON.stringify(summary, null, 1));
