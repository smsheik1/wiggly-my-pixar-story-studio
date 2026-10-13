// r5 easy batch regressions. Invented fixtures only; every network call is mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { current } from '../runtime/workflow.mjs';
import { requestDescriptor } from '../runtime/providers.mjs';
import { MOUTHS_CLOSED_CLAUSE, TALK_CLAUSES, withTalkClause, talkMode } from '../runtime/studio.mjs';
import { Content } from '../runtime/contracts.mjs';
import { executeVideo, keyframeForVideo } from '../runtime/video-provider.mjs';
import { createGeminiReviewTools, GEMINI_REVIEW_MODEL, talkReviewLine } from '../runtime/gemini-review.mjs';
import { crewTools } from '../runtime/crew.mjs';
import { importMedia } from '../runtime/media.mjs';
import { checkSpendPreflight, requireSpendHeadroom, OPENROUTER_KEY_URL, spendFloorUsd, DEFAULT_SPEND_FLOOR_USD } from '../runtime/spend-preflight.mjs';
import { endOfRunCheck, runProcesses } from '../runtime/end-of-run.mjs';
import { supervisedVideoReady } from './supervised-helpers.mjs';
import { videoReady } from './studio-helpers.mjs';

globalThis.fetch = () => { throw new Error('FETCH_PROHIBITED in r5-easy-batch.test.mjs'); };
const tmp = () => mkdtemp(join(tmpdir(), 'r5-easy-'));

// ---- 2. per-clip talk mode (narration, not dialogue; MOS conversations allowed) ----
const MOS_CLAUSE = 'Characters converse silently under narration: loose, natural, unsynced mouth movement and gestures, no lip-sync to any words, no visible speech text.';
const withClipTalk = (p, talk) => { const q = structuredClone(p); const clip = current(q, 'videoPlan').content.clips.find(c => c.id === q.clipId); if (talk === undefined) delete clip.talk; else clip.talk = talk; return q; };

test('r5 talk: clause helpers are fixed, idempotent, and default to none', () => {
  assert.equal(MOUTHS_CLOSED_CLAUSE, 'Mouths stay closed; no talking, no lip movement.');
  assert.equal(TALK_CLAUSES.none, MOUTHS_CLOSED_CLAUSE);
  assert.equal(TALK_CLAUSES.mos, MOS_CLAUSE);
  assert.equal(withTalkClause('Camera: held'), `Camera: held\n${MOUTHS_CLOSED_CLAUSE}`);
  assert.equal(withTalkClause(withTalkClause('x', 'mos'), 'mos'), `x\n${MOS_CLAUSE}`);
  assert.equal(talkMode({}), 'none'); assert.equal(talkMode({ talk: 'mos' }), 'mos'); assert.equal(talkMode({ talk: 'bogus' }), 'none');
});

test('r5 talk: videoPlan clip talk is none|mos, defaulting to none', () => {
  const plan = c => ({ resolution: '480p', clips: [1, 2, 3, 4].map(i => ({ id: `clip-${i}`, shotId: `shot-${i}`, startSeconds: 0, durationSeconds: 15, generationSeconds: 15, camera: 'held', action: 'a', anchors: 'b', atmosphere: 'c', ...c })) });
  assert.equal(Content.videoPlan.parse(plan({})).clips[0].talk, 'none');
  assert.equal(Content.videoPlan.parse(plan({ talk: 'mos' })).clips[0].talk, 'mos');
  assert.throws(() => Content.videoPlan.parse(plan({ talk: 'dialogue' })));
});

test('r5 talk: video request appends the none clause by default and the MOS clause for talk mos', () => {
  const base = videoReady(supervisedVideoReady());
  const prompt = current(base, `videoPrompt:${base.clipId}`).content.prompt;
  for (const [talk, clause] of [[undefined, MOUTHS_CLOSED_CLAUSE], ['none', MOUTHS_CLOSED_CLAUSE], ['mos', MOS_CLAUSE]]) {
    const request = requestDescriptor(withClipTalk(base, talk), { provider: 'replicate', operation: 'video', estimatedCostUsd: 1, parameters: { prompt } });
    assert.ok(request.input.prompt.startsWith(prompt));
    assert.ok(request.input.prompt.endsWith(clause), String(talk));
    assert.equal(request.input.prompt.split(clause).length, 2);
    assert.equal(request.input.generate_audio, false);
    assert.equal(request.input.duration, 15);
  }
});

test('r5 talk: the video reviewer line follows the clip talk mode', async () => {
  const dir = await tmp();
  try {
    const secretsPath = join(dir, 'secrets.env'), path = join(dir, 'clip.mp4');
    await writeFile(secretsPath, 'GEMINI_API_KEY=ISOLATED_SECRET\n');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=0.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path]);
    const file = await importMedia(path, dir), worker = { workerId: 'isolated-june', name: 'June', role: 'scene-reviewer' };
    const report = { perceptible: true, fullMediaInspected: true, summary: 'ISOLATED', observations: [], limitations: ['ISOLATED'] };
    const texts = {};
    for (const talk of ['none', 'mos']) {
      let body;
      const task = { taskId: `isolated-task-${talk}`, step: 'video', artifact: { content: { files: [file] } }, criteria: ['ISOLATED'], videoBinding: { clip: { id: 'clip-1', talk } } };
      const tools = createGeminiReviewTools({ secretsPath, receiptDirectory: join(dir, `receipts-${talk}`), maxCalls: 1, fetcher: async (_u, o) => { body = JSON.parse(o.body); return new Response(JSON.stringify({ id: 'i', model: GEMINI_REVIEW_MODEL, status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(report) }] }] })); } });
      await crewTools(task, worker, tools, () => {})('watchVideo', { sha256: file.sha256 });
      texts[talk] = body.input.at(-1).text;
    }
    for (const t of Object.values(texts)) assert.doesNotMatch(t, /does not require lip sync/);
    assert.match(texts.none, /talk: none.*mouth opening, talking-like lip motion or lip flap as a defect/);
    assert.match(texts.mos, /MOS \(talk: mos\).*loose, natural, unsynced mouth movement.*that is correct/);
    assert.match(texts.mos, /only tight lip-sync-looking speech, mouthing of specific readable words, or visible speech text/);
    assert.doesNotMatch(texts.mos, /lip flap as a defect/);
    assert.equal(talkReviewLine({}), talkReviewLine({ videoBinding: { clip: { talk: 'none' } } }));
  } finally { await rm(dir, { recursive: true }); }
});

// ---- 3. spend preflight ----
const keyResponse = data => async (url, init) => { assert.equal(url, OPENROUTER_KEY_URL); assert.equal(init.method, 'GET'); assert.equal(init.headers.Authorization, 'Bearer ISOLATED_OR'); return new Response(JSON.stringify({ data })); };

test('r5 spend preflight: passes with headroom, blocks below the step estimate or the floor', async () => {
  const ok = await checkSpendPreflight({ key: 'ISOLATED_OR', estimatedCostUsd: 0.5, floorUsd: 0.25, fetcher: keyResponse({ limit: 3, limit_remaining: 2, usage: 1 }) });
  assert.equal(ok.ok, true); assert.equal(ok.remainingUsd, 2);
  const est = await checkSpendPreflight({ key: 'ISOLATED_OR', estimatedCostUsd: 0.9, floorUsd: 0.25, step: 'generate:video', fetcher: keyResponse({ limit: 3, limit_remaining: 0.6 }) });
  assert.equal(est.ok, false); assert.equal(est.reason, 'below-step-estimate'); assert.equal(est.blocker.kind, 'spend-preflight'); assert.match(est.blocker.problem, /\$0\.60 left of its \$3\.00 limit/);
  const floor = await checkSpendPreflight({ key: 'ISOLATED_OR', estimatedCostUsd: 0.01, floorUsd: 0.25, fetcher: keyResponse({ limit: 3, limit_remaining: 0.1 }) });
  assert.equal(floor.ok, false); assert.equal(floor.reason, 'below-floor');
  const unlimited = await checkSpendPreflight({ key: 'ISOLATED_OR', estimatedCostUsd: 5, fetcher: keyResponse({ limit: null, usage: 9 }) });
  assert.equal(unlimited.ok, true); assert.equal(unlimited.unlimited, true);
  const down = await checkSpendPreflight({ key: 'ISOLATED_OR', fetcher: async () => new Response('no', { status: 503 }) });
  assert.equal(down.ok, true); assert.equal(down.checked, false);
  assert.equal(spendFloorUsd({}), DEFAULT_SPEND_FLOOR_USD); assert.equal(spendFloorUsd({ WIGGLY_SPEND_FLOOR_USD: '1.5' }), 1.5);
});

test('r5 spend preflight: a block pauses cleanly and records a blocker in the event log', async () => {
  const dir = await tmp();
  try {
    await assert.rejects(requireSpendHeadroom({ runDir: dir, key: 'ISOLATED_OR', estimatedCostUsd: 1, floorUsd: 0.25, step: 'crew:drive', fetcher: keyResponse({ limit: 3, limit_remaining: 0.2 }) }), e => e.code === 'SPEND_PREFLIGHT_BLOCKED');
    const blocker = JSON.parse(await readFile(join(dir, 'spend-blocker.json'), 'utf8'));
    assert.equal(blocker.type, 'blocker'); assert.equal(blocker.step, 'crew:drive');
    const log = (await readFile(join(dir, 'events.log'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(log.at(-1).kind, 'spend-preflight');
    assert.ok(!JSON.stringify(blocker).includes('ISOLATED_OR'));
  } finally { await rm(dir, { recursive: true }); }
});

// ---- 4. jpg keyframes ----
// 1x1 lossy webp (ffmpeg builds often decode webp without a webp encoder).
const TINY_WEBP = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=';
test('r5 keyframes: webp and png are converted to jpg before the video upload', async () => {
  const dir = await tmp();
  try {
    for (const ext of ['webp', 'png']) {
      const src = join(dir, `frame.${ext}`);
      if (ext === 'webp') await writeFile(src, Buffer.from(TINY_WEBP, 'base64'));
      else execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x36:d=0.04', '-frames:v', '1', src]);
      const out = await keyframeForVideo(src, dir);
      assert.equal(out.converted, true); assert.equal(out.mime, 'image/jpeg');
      const bytes = await readFile(out.path); assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8);
    }
    const jpg = join(dir, 'already.jpg'); execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x36:d=0.04', '-frames:v', '1', jpg]);
    assert.deepEqual(await keyframeForVideo(jpg, dir), { path: jpg, mime: 'image/jpeg', converted: false });
    const jobDir = join(dir, 'job'); await mkdir(jobDir);
    const webp = join(dir, 'frame.webp'); let sent;
    const job = { digest: 'd', request: { frame: { path: webp, sha256: 'x' }, endpoint: 'https://api.replicate.com/v1/models/bytedance/seedance-2.0-mini/predictions', input: { prompt: 'p', duration: 15 } } };
    const res = await executeVideo(job, jobDir, 'ISOLATED_REPLICATE', async (_url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ id: 'pred1', status: 'starting' })); });
    assert.equal(res.pending, true);
    assert.match(sent.input.image, /^data:image\/jpeg;base64,\/9j\//);
  } finally { await rm(dir, { recursive: true }); }
});

// ---- 5. end-of-run check ----
test('r5 end-of-run: leftover run processes and started dispatches are closed when done, flagged when stopped', async () => {
  const dir = await tmp();
  try {
    const runDir = join(dir, 'r5'); await mkdir(join(runDir, 'host-dispatch'), { recursive: true });
    const started = join(runDir, 'host-dispatch', 'a'.repeat(64) + '.json'), finished = join(runDir, 'host-dispatch', 'b'.repeat(64) + '.json');
    await writeFile(started, JSON.stringify({ status: 'started', taskId: 't1' })); await writeFile(finished, JSON.stringify({ status: 'finished', taskId: 't2' }));
    const procs = [{ pid: 10, ppid: 1, command: `bash wiggly-loop.sh --run ${runDir}` }, { pid: 11, ppid: 1, command: `node runner.mjs drive --run ${runDir}-other` }, { pid: 99, ppid: 1, command: `node runner.mjs finalize --run ${runDir}` }];
    assert.deepEqual(runProcesses(procs, runDir, 99).map(p => p.pid), [10]);
    const killed = [];
    const flagged = await endOfRunCheck({ runDir, close: false, list: async () => procs, kill: pid => killed.push(pid), selfPid: 99 });
    assert.equal(flagged.clean, false); assert.deepEqual(killed, []); assert.equal(flagged.processes[0].action, 'flagged'); assert.equal(flagged.dispatches[0].action, 'flagged');
    assert.equal(JSON.parse(await readFile(started, 'utf8')).status, 'started');
    const closed = await endOfRunCheck({ runDir, close: true, list: async () => procs, kill: pid => killed.push(pid), selfPid: 99 });
    assert.deepEqual(killed, [10]); assert.equal(closed.processes[0].action, 'terminated'); assert.equal(closed.dispatches[0].action, 'closed');
    assert.equal(JSON.parse(await readFile(started, 'utf8')).status, 'abandoned');
    assert.equal(JSON.parse(await readFile(finished, 'utf8')).status, 'finished');
    assert.equal(JSON.parse(await readFile(join(runDir, 'end-of-run.json'), 'utf8')).mode, 'close');
    const clean = await endOfRunCheck({ runDir, close: true, list: async () => [], selfPid: 99 });
    assert.equal(clean.clean, true);
  } finally { await rm(dir, { recursive: true }); }
});
