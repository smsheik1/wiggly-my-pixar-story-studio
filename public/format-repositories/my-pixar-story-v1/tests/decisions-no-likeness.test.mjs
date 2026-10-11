// Decisions prescreen never does likeness (Oct 11 2026): no reference photos are sent, no
// question asks about resemblance or identity, and likeness sentences are scrubbed from the
// brief. It only asks about deformities, baked-in text and whether the image follows the brief.
// No network (fake fetchers only), no ffmpeg.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRequests, runPrescreen, prescreenCriteria, scrubLikeness, prescreenBrief, assertNoLikeness,
  PRESCREEN_QUESTIONS, LIKENESS_TERMS, estimatePrescreenCost,
} from '../runtime/decisions-prescreen.mjs';
import { criteria as rubric } from '../runtime/contracts.mjs';

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function files(dir, n) {
  const out = [];
  for (let i = 0; i < n; i++) { const p = join(dir, `o${i}.png`); await writeFile(p, PNG); out.push({ path: p, sha256: String(i).repeat(64), bytes: PNG.length }); }
  return out;
}
const SHEET_PROMPT = 'Create ONE stylized 3D character model sheet for adult Shaz. Use the attached adult photograph as the sole age-specific likeness reference. Translate these recognizable traits into animation geometry. Match the rust-red sweater, silver chain necklace and dark watch on the left wrist. Compose exactly TWELVE cells. The sheet must contain no text.';

test('1. criteria: likeness and reference-only continuity never asked; deformities, brief-fit and no-text always asked', { timeout: 10000 }, () => {
  for (const step of ['candidates', 'sheet', 'backgroundCandidates', 'backgroundAngle', 'keyframe']) {
    const c = prescreenCriteria(rubric[step] ?? []);
    for (const banned of ['likeness', 'continuity', 'setting-continuity']) assert.ok(!c.includes(banned), `${step} asks ${banned}`);
    for (const always of ['anatomy', 'brief-fit', 'no-text']) assert.ok(c.includes(always), `${step} misses ${always}`);
  }
  assert.ok(!('likeness' in PRESCREEN_QUESTIONS));
  for (const [k, q] of Object.entries(PRESCREEN_QUESTIONS)) assert.doesNotMatch(JSON.stringify(q), LIKENESS_TERMS, k);
  assert.match(PRESCREEN_QUESTIONS.anatomy.instructions, /hands/);assert.match(PRESCREEN_QUESTIONS.anatomy.instructions, /faces/);
  assert.match(PRESCREEN_QUESTIONS['brief-fit'].instructions, /outfit/);assert.match(PRESCREEN_QUESTIONS['brief-fit'].instructions, /headscarf/);
  assert.match(PRESCREEN_QUESTIONS['no-text'].instructions, /grid lines/);
});

test('2. brief scrub drops likeness/photo/identity sentences and keeps outfit, layout and no-text instructions', { timeout: 10000 }, () => {
  const s = scrubLikeness(SHEET_PROMPT);
  assert.doesNotMatch(s, LIKENESS_TERMS);
  assert.match(s, /rust-red sweater, silver chain necklace and dark watch/);
  assert.match(s, /TWELVE cells/);assert.match(s, /no text/);
  assert.doesNotMatch(s, /photograph|likeness|recognizable/);
  const brief = prescreenBrief({ artifacts: [] }, { key: 'candidates:shaz-adult', content: { prompt: SHEET_PROMPT } });
  assert.equal(brief, s);
  const room = prescreenBrief({ artifacts: [{ key: 'backgroundBrief:room', valid: true, content: { direction: 'A 1990s bedroom.', knownDetails: ['bunk bed'] } }] }, { key: 'backgroundCandidates:room', content: {} });
  assert.match(room, /1990s bedroom[\s\S]*bunk bed/);
});

test('3. Luna and clef requests carry only the option images, even when a caller passes reference photos', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dec-nolike-3-'));
  try {
    const f = await files(dir, 3), refs = await files(dir, 2);
    for (const model of ['openai/gpt-6-luna-decisions', 'cloudflare/clef-flash']) {
      const reqs = await buildRequests({ model, step: 'candidates', files: f, references: refs, contextText: SHEET_PROMPT, criteria: rubric.sheet });
      let images = 0;
      for (const r of reqs) {
        for (const part of r.body.state) {
          if (typeof part === 'string') { assert.doesNotMatch(part, /^REFERENCE/); assert.doesNotMatch(part, LIKENESS_TERMS); }
          else images++;
        }
        for (const [k, q] of Object.entries(r.body.questions)) { assert.doesNotMatch(k, /likeness/); assert.doesNotMatch(JSON.stringify(q), LIKENESS_TERMS); }
      }
      // Luna: 3 option images in 1 request; clef: 3 per-option + 3 in the rank request.
      assert.equal(images, model.startsWith('openai') ? 3 : 6, model);
    }
    assert.equal(estimatePrescreenCost({ model: 'openai/gpt-6-luna-decisions', files: f, references: refs }), estimatePrescreenCost({ model: 'openai/gpt-6-luna-decisions', files: f }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('4. assertNoLikeness refuses reference parts, extra images and likeness questions', { timeout: 10000 }, () => {
  const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } };
  const ok = { state: ['OPTION 0', img], questions: { 'opt0__anatomy': PRESCREEN_QUESTIONS.anatomy } };
  assert.equal(assertNoLikeness(ok, 1), ok);
  assert.throws(() => assertNoLikeness({ state: ['OPTION 0', img, 'REFERENCE: mum', img], questions: {} }, 1), /PRESCREEN_LIKENESS_FORBIDDEN/);
  assert.throws(() => assertNoLikeness({ state: ['OPTION 0', img, img], questions: {} }, 1), /PRESCREEN_LIKENESS_FORBIDDEN/);
  assert.throws(() => assertNoLikeness({ state: ['OPTION 0', img], questions: { 'opt0__likeness': { type: 'noul', instructions: 'Does it look like the reference photos?' } } }, 1), /PRESCREEN_LIKENESS_FORBIDDEN/);
  assert.throws(() => assertNoLikeness({ state: ['Use the attached photograph as the likeness reference', 'OPTION 0', img], questions: {} }, 1), /PRESCREEN_LIKENESS_FORBIDDEN/);
});

test('5. runPrescreen scores only the allowed checks; runner and replay never pass reference photos; Vera/June skills say likeness stays theirs', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dec-nolike-5-'));
  try {
    const f = await files(dir, 3);
    let sent = null;
    const fetcher = async (_url, init) => {
      sent = JSON.parse(init.body);
      const answers = {};
      for (const k of Object.keys(sent.questions)) answers[k] = k === 'rank' ? { type: 'choice', confidence: 0.9, probabilities: { '0': 0.2, '1': 0.7, '2': 0.1 } } : { type: 'noul', noul: 0.95 };
      return new Response(JSON.stringify({ model: sent.model, answers, usage: { input_tokens: 10, cost: 0.0001 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const out = await runPrescreen({ config: { model: 'openai/gpt-6-luna-decisions' }, apiKey: 'k', fetcher, step: 'candidates', files: f, contextText: SHEET_PROMPT, criteria: rubric.sheet });
    assert.equal(out.verdict, 'pass');assert.deepEqual(out.ranking, [1, 0, 2]);
    const crits = out.files[0].checks.map(c => c.criterion);
    assert.ok(!crits.includes('likeness'));assert.ok(crits.includes('brief-fit'));assert.ok(crits.includes('anatomy'));
    assert.match(sent.state[0], /^BRIEF/);
    const runner = await readFile(new URL('../runner.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(runner, /references:\s*refs/);assert.doesNotMatch(runner, /prescreenInputs/);assert.match(runner, /prescreenBrief\(/);
    const replay = await readFile(new URL('../evaluation/decisions-replay.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(replay, /references:/);
    const { DEFAULT_REPLAY_MODELS } = await import('../evaluation/decisions-replay.mjs');
    assert.deepEqual(DEFAULT_REPLAY_MODELS, ['openai/gpt-6-luna-decisions']);
    for (const who of ['vera', 'june']) {
      const skill = await readFile(new URL(`../crew/${who}/SKILL.md`, import.meta.url), 'utf8');
      assert.match(skill, /prescreen never sees reference photos and never judges likeness/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
