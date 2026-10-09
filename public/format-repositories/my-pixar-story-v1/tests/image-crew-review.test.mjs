import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexHost } from '../runtime/codex-host.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initialProject, taskFor, current, crewReviewEligible } from '../runtime/workflow.mjs';
import { runCrewTask, crewTools } from '../runtime/crew.mjs';
import { importMedia } from '../runtime/media.mjs';
import { criteria, digest } from '../runtime/contracts.mjs';
import { inputs, script, file, send, reviewed, approved, produce } from './helpers.mjs';
import { image, sheetImage } from './background-helpers.mjs';

function veraApprovedCandidates() {
  // minimal rev4 candidates at human gate with Vera all-pass + viewImage receipts
  let p = initialProject('vera', inputs, { workflowRevision: 4, reviewMode: 'supervised' });
  p.artifacts.push({ id: 'script@1', key: 'script', kind: 'script', version: 1, digest: 's', content: { beats: [1,2,3,4].map(i => ({ beat: i, durationSeconds: 15, narration: 'x', emotionalPurpose: 'c', sourceAnswers: ['scene1Childhood'] })), commonSenseChecks: [] }, dependencies: [], valid: true, authoredBy: 't' });
  p.artifacts.push({ id: 'roster@1', key: 'roster', kind: 'roster', version: 1, digest: 'r', content: { characters: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', important: true, references: [image(1)], notes: 'x' }] }, dependencies: [], valid: true, authoredBy: 't' });
  p.artifacts.push({ id: 'characterPrompt:alex@1', key: 'characterPrompt:alex', kind: 'characterPrompt', version: 1, digest: 'c', content: { prompt: 'character', characterDigest: 'd', referenceHashes: [image(1).sha256], recipeSha256: 'h' }, dependencies: [], valid: true, authoredBy: 't' });
  const files = [1, 2, 3].map(n => ({ path: `/isolated-test/sheet-${n}.png`, sha256: file(n).sha256, bytes: 100, width: 1200, height: 900 }));
  p.artifacts.push({ id: 'candidates:alex@1', key: 'candidates:alex', kind: 'candidates', version: 1, digest: digest({ files, prompt: 'character' }), content: { files, prompt: 'character' }, dependencies: [], valid: true, authoredBy: 'provider-runtime' });
  p.characterId = 'alex'; p.step = 'candidates'; p.gate = 'review';
  const a = current(p);
  p = send(p, 'review', { workerId: 'vera', artifactId: a.id, artifactDigest: a.digest, review: { decision: 'approved', perception: 'direct-image', checks: criteria.candidates.map(criterion => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED Vera pass' })), toolEvidence: files.map(f => ({ tool: 'viewImage', sha256: f.sha256 })) } });
  return p;
}

test('Vera all-pass with every viewImage receipt makes crew-review eligible; human picks without checklist', () => {
  let p = veraApprovedCandidates();
  assert.equal(p.gate, 'human');
  assert.equal(crewReviewEligible(p), true);
  assert.equal(taskFor(p).reviewPolicy.humanMediaConfirmationRequired, false);
  const a = current(p);
  p = send(p, 'approve', { artifactId: a.id, artifactDigest: a.digest, message: 'ISOLATED pick 2', selection: 2, humanReview: { decision: 'approved', perception: 'crew-review', checks: [] } });
  assert.equal(current(p, 'candidates:alex').selection, 2);
  assert.ok(p.step !== 'candidates' || current(p, 'candidates:alex').selection === 2);
});

test('crew-review ineligible on rejected, missing criterion, or missing viewImage receipt', () => {
  for (const mutate of [
    (r) => ({ ...r, decision: 'rejected', checks: r.checks.map((c, i) => i === 0 ? { ...c, status: 'fail', repair: 'fix' } : c) }),
    (r) => ({ ...r, checks: r.checks.slice(0, -1) }),
    (r) => ({ ...r, toolEvidence: r.toolEvidence.slice(0, -1) }),
    (r) => ({ ...r, perception: 'direct-text' }),
  ]) {
    let p = veraApprovedCandidates();
    // reset to review gate with mutated review
    const a = current(p);
    delete a.approvedBy; delete a.humanReview;
    p.step = 'candidates'; p.gate = 'review'; p.characterId = 'alex';
    // invalidate prior approval by pushing a new artifact version
    const files = a.content.files;
    const next = { id: 'candidates:alex@2', key: 'candidates:alex', kind: 'candidates', version: 2, digest: digest({ files, prompt: 'character' }), content: { files, prompt: 'character' }, dependencies: [], valid: true, authoredBy: 'provider-runtime' };
    for (const old of p.artifacts.filter(x => x.key === 'candidates:alex')) old.valid = false;
    p.artifacts.push(next);
    const b = current(p);
    const good = { decision: 'approved', perception: 'direct-image', checks: criteria.candidates.map(criterion => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'x' })), toolEvidence: files.map(f => ({ tool: 'viewImage', sha256: f.sha256 })) };
    const bad = mutate(structuredClone(good));
    if (bad.decision === 'rejected') {
      p = send(p, 'review', { workerId: 'vera', artifactId: b.id, artifactDigest: b.digest, review: bad });
      assert.equal(crewReviewEligible(p), false);
      assert.equal(taskFor(p).reviewPolicy.humanMediaConfirmationRequired, true);
      assert.throws(() => send(p, 'approve', { artifactId: b.id, artifactDigest: b.digest, message: 'ISOLATED', selection: 0, humanReview: { decision: 'approved', perception: 'crew-review', checks: [] } }), /HUMAN_MEDIA_REVIEW|agent-passing/);
    } else {
      if (bad.checks.length !== criteria.candidates.length || bad.perception !== 'direct-image') {
        // review itself should be rejected by schema/gate validation or ineligible
        try {
          p = send(p, 'review', { workerId: 'vera', artifactId: b.id, artifactDigest: b.digest, review: bad });
          assert.equal(crewReviewEligible(p), false);
        } catch (e) {
          assert.match(e.message, /Every required criterion|Cannot approve/);
        }
      } else {
        p = send(p, 'review', { workerId: 'vera', artifactId: b.id, artifactDigest: b.digest, review: bad });
        assert.equal(crewReviewEligible(p), false);
        assert.throws(() => send(p, 'approve', { artifactId: b.id, artifactDigest: b.digest, message: 'ISOLATED', selection: 0, humanReview: { decision: 'approved', perception: 'crew-review', checks: [] } }), /HUMAN_MEDIA_REVIEW/);
      }
    }
  }
});

test('human direct-image checklist still works when crew-review is not eligible', () => {
  let p = veraApprovedCandidates();
  const a = current(p);
  // direct-image human review with full checklist passes even though crew-review would also pass
  p = send(p, 'approve', { artifactId: a.id, artifactDigest: a.digest, message: 'ISOLATED direct confirm', selection: 0, humanReview: { decision: 'approved', perception: 'direct-image', checks: criteria.candidates.map(criterion => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'human saw' })) } });
  assert.ok(current(p, 'candidates:alex').approvedBy);
});

test('Vera crop inspection uses ffmpeg region without replacing full view requirement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vera-crop-'));
  try {
    const path = join(dir, 'sheet.png');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1200x900', '-frames:v', '1', path]);
    const f = await importMedia(path, dir);
    const worker = { name: 'Vera', role: 'visual-reviewer' };
    const task = { step: 'candidates', gate: 'review', artifact: { content: { files: [f] } }, dependencies: [] };
    let sawCrop = null;
    const tools = crewTools(task, worker, { viewImage: async ({ file, region }) => { if (region) sawCrop = { file, region, actualSha256: createHash('sha256').update(await readFile(file.path)).digest('hex') }; return { perception: 'direct-image' }; } }, () => {});
    await tools('viewImage', { sha256: f.sha256 });
    await tools('viewImage', { sha256: f.sha256, region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } });
    assert.ok(sawCrop);
    assert.equal(sawCrop.region.width, 0.2);
    assert.ok(sawCrop.file.width < f.width);
    // The crop is bound to its own bytes so byte-verifying adapters (Gemini) accept it.
    assert.equal(sawCrop.file.sha256, sawCrop.actualSha256);
    assert.notEqual(sawCrop.file.sha256, f.sha256);
    await assert.rejects(tools('viewImage', { sha256: f.sha256, region: { x: 0, y: 0, width: 2, height: 1 } }), /REGION_MISMATCH/);
  } finally { await rm(dir, { recursive: true }); }
});

test('review gate still requires full viewImage of every file even with crops present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vera-full-'));
  try {
    const mk = async (name, color) => { const pth = join(dir, name); execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=1200x900`, '-frames:v', '1', pth]); return importMedia(pth, dir); };
    const f = await mk('a0.png', 'green');
    const f1 = await mk('a1.png', 'red');
    const f2 = await mk('a2.png', 'blue');
    const { crewRoles } = await import('../runtime/crew.mjs');
    const crew = { workers: Object.entries(crewRoles).map(([role, { name }]) => ({ role, name, workerId: `t-${role}`, modelVersion: 'm', capabilityVersion: 'c', execution: 'host' })) };
    let p = initialProject('crop-req', inputs, { workflowRevision: 4, reviewMode: 'supervised' });
    p.crew = crew;
    const okReview = { decision: 'approved', perception: 'direct-text', checks: [{ criterion: 'x', status: 'pass', location: 'x', evidence: 'x' }] };
    p.artifacts.push({ id: 'script@1', key: 'script', kind: 'script', version: 1, digest: 's', content: { beats: [1,2,3,4].map(i => ({ beat: i, durationSeconds: 15, narration: 'x', emotionalPurpose: 'c', sourceAnswers: ['scene1Childhood'] })), commonSenseChecks: [] }, dependencies: [], valid: true, authoredBy: 't', approvedBy: { message: 'm', at: new Date().toISOString() }, review: okReview });
    p.artifacts.push({ id: 'roster@1', key: 'roster', kind: 'roster', version: 1, digest: 'r', content: { characters: [{ id: 'alex', name: 'A', ageVariant: 'adult', important: true, references: [f], notes: 'x' }] }, dependencies: [], valid: true, authoredBy: 't', approvedBy: { message: 'm', at: new Date().toISOString() }, review: okReview, humanReview: { decision: 'approved', perception: 'direct-text', checks: [] } });
    p.artifacts.push({ id: 'characterPrompt:alex@1', key: 'characterPrompt:alex', kind: 'characterPrompt', version: 1, digest: 'c', content: { prompt: 'p', characterDigest: 'd', referenceHashes: [f.sha256], recipeSha256: 'h' }, dependencies: [], valid: true, authoredBy: 't', approvedBy: { message: 'm', at: new Date().toISOString() }, review: okReview, humanReview: { decision: 'approved', perception: 'direct-text', checks: [] } });
    const files = [f, f1, f2];
    p.artifacts.push({ id: 'candidates:alex@1', key: 'candidates:alex', kind: 'candidates', version: 1, digest: digest({ files, prompt: 'p' }), content: { files, prompt: 'p' }, dependencies: [], valid: true, authoredBy: 't-visual' });
    p.characterId = 'alex'; p.step = 'candidates'; p.gate = 'review';
    const task = taskFor(p);
    const verdict = { taskId: task.taskId, action: 'review', actor: 'reviewer', workerId: task.crewWorker.workerId, artifactId: task.artifact.id, artifactDigest: task.artifact.digest, review: { decision: 'approved', perception: 'direct-image', modelVersion: task.crewWorker.modelVersion, capabilityVersion: task.crewWorker.capabilityVersion, checks: task.criteria.map(criterion => ({ criterion, status: 'pass', location: 'x', evidence: 'x' })) } };
    // only crops, no full views -> must fail
    await assert.rejects(runCrewTask(p, task, { tools: { viewImage: async () => ({ perception: 'direct-image' }) }, runTask: async (_t, { callTool }) => { for (const fl of files) await callTool('viewImage', { sha256: fl.sha256, region: { x: 0, y: 0, width: 0.5, height: 0.5 } }); return verdict; } }), /PERCEPTION_NOT_PERFORMED/);
    // full views -> passes
    const ok = await runCrewTask(p, task, { tools: { viewImage: async () => ({ perception: 'direct-image' }) }, runTask: async (_t, { callTool }) => { for (const fl of files) await callTool('viewImage', { sha256: fl.sha256 }); return verdict; } });
    assert.equal(ok.review.decision, 'approved');
  } finally { await rm(dir, { recursive: true }); }
});

test('Codex host accepts and forwards a viewImage region from the live tool call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vera-host-region-'));
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = { end() {} }; child.kill = () => {};
  const host = new CodexHost({ cwd: dir, spawnProcess: () => child });
  const sent = []; host.send = m => sent.push(m);
  let received = null;
  host.active = { threadId: 'thread-1', turnId: 'turn-1', worker: { workerId: 'thread-1', name: 'Vera', role: 'visual-reviewer' }, callTool: async (name, parameters) => { received = { name, parameters }; return { perception: 'direct-image' }; }, resolve: () => {}, reject: () => {}, output: '', buffer: [], pendingTools: 0, finishedTools: [] };
  try {
    const region = { x: 0.5, y: 0.5, width: 0.25, height: 0.25 };
    await host.toolCall({ id: 7, params: { threadId: 'thread-1', turnId: 'turn-1', tool: 'wiggly_tool', arguments: { name: 'viewImage', sha256: 'a'.repeat(64), referenceSha256: null, region } } });
    assert.deepEqual(received, { name: 'viewImage', parameters: { sha256: 'a'.repeat(64), region } });
    assert.equal(sent[0].result.success, true);
  } finally { host.close(); await rm(dir, { recursive: true }); }
});
