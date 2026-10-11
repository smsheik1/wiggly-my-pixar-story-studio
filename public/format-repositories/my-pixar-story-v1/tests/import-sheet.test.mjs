import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initialProject, taskFor, current } from '../runtime/workflow.mjs';
import { importMedia } from '../runtime/media.mjs';
import { criteria, digest } from '../runtime/contracts.mjs';
import { inputs, script, file, send, reviewed, approved, produce } from './helpers.mjs';
import { image, sheetImage } from './background-helpers.mjs';
import { characterSheet } from '../runtime/gates.mjs';

async function realSheet(dir, name = 'outside.png', size = '1200x900') {
  const path = join(dir, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=purple:s=${size}`, '-frames:v', '1', path]);
  return importMedia(path, dir);
}

function rev4AtSheet() {
  // minimal rev4 project at sheet step with locked sheetPrompt
  let p = initialProject('imp4', inputs, { workflowRevision: 4, reviewMode: 'supervised' });
  p.artifacts.push({ id: 'script@1', key: 'script', kind: 'script', version: 1, digest: 's', content: { beats: [1,2,3,4].map(i => ({ beat: i, durationSeconds: 15, narration: 'x', emotionalPurpose: 'c', sourceAnswers: ['scene1Childhood'] })), commonSenseChecks: [] }, dependencies: [], valid: true, authoredBy: 't', approvedBy: { message: 'm', at: new Date().toISOString() }, review: { decision: 'approved', perception: 'direct-text', checks: [{ criterion: 'x', status: 'pass', location: 'x', evidence: 'x' }] } });
  p.artifacts.push({ id: 'roster@1', key: 'roster', kind: 'roster', version: 1, digest: 'r', content: { characters: [{ id: 'alex', name: 'A', ageVariant: 'adult', important: true, references: [image(1)], notes: 'x' }] }, dependencies: [], valid: true, authoredBy: 't', approvedBy: { message: 'm', at: new Date().toISOString() }, review: { decision: 'approved', perception: 'direct-text', checks: [{ criterion: 'x', status: 'pass', location: 'x', evidence: 'x' }] } });
  p.artifacts.push({ id: 'characterPrompt:alex@1', key: 'characterPrompt:alex', kind: 'characterPrompt', version: 1, digest: 'c', content: { prompt: 'character', characterDigest: 'd', referenceHashes: [image(1).sha256], recipeSha256: 'h' }, dependencies: [], valid: true, authoredBy: 't', approvedBy: { message: 'm', at: new Date().toISOString() }, review: { decision: 'approved', perception: 'direct-text', checks: [{ criterion: 'x', status: 'pass', location: 'x', evidence: 'x' }] } });
  const candFiles = [1, 2, 3].map(n => ({ path: `/isolated-test/sheet-${n}.png`, sha256: file(n).sha256, bytes: 100, width: 1200, height: 900 }));
  p.artifacts.push({ id: 'candidates:alex@1', key: 'candidates:alex', kind: 'candidates', version: 1, digest: digest({ files: candFiles, prompt: 'character' }), content: { files: candFiles, prompt: 'character' }, dependencies: [], valid: true, authoredBy: 't', approvedBy: { message: 'm', at: new Date().toISOString() }, review: { decision: 'approved', perception: 'direct-image', checks: criteria.candidates.map(criterion => ({ criterion, status: 'pass', location: 'x', evidence: 'x' })) }, selection: 0, humanReview: { decision: 'approved', perception: 'direct-image', checks: criteria.candidates.map(criterion => ({ criterion, status: 'pass', location: 'x', evidence: 'x' })) } });
  p.artifacts.push({ id: 'sheetPrompt:alex@1', key: 'sheetPrompt:alex', kind: 'sheetPrompt', version: 1, digest: 'sp', content: { prompt: 'sheet prompt', recipeSha256: 'h', referenceSha256: candFiles[0].sha256, turnaround: ['front', 'three-quarter', 'profile', 'back'], expressions: Array(8).fill('e') }, dependencies: [], valid: true, authoredBy: 't', approvedBy: { message: 'm', at: new Date().toISOString() }, review: { decision: 'approved', perception: 'direct-text', checks: [{ criterion: 'x', status: 'pass', location: 'x', evidence: 'x' }] } });
  p.characterId = 'alex'; p.step = 'sheet'; p.gate = 'produce';
  return p;
}

function rev5AtCandidates() {
  let p = initialProject('imp5', inputs, { workflowRevision: 5, reviewMode: 'supervised' });
  p.artifacts.push({ id: 'script@1', key: 'script', kind: 'script', version: 1, digest: 's', content: { beats: [1,2,3,4].map(i => ({ beat: i, durationSeconds: 15, narration: 'x', emotionalPurpose: 'c', sourceAnswers: ['scene1Childhood'] })), commonSenseChecks: [] }, dependencies: [], valid: true, authoredBy: 't', approvedBy: { message: 'm', at: new Date().toISOString() }, review: { decision: 'approved', perception: 'direct-text', checks: [{ criterion: 'x', status: 'pass', location: 'x', evidence: 'x' }] } });
  p.artifacts.push({ id: 'roster@1', key: 'roster', kind: 'roster', version: 1, digest: 'r', content: { characters: [{ id: 'alex', name: 'A', ageVariant: 'adult', important: true, references: [image(1)], notes: 'x' }] }, dependencies: [], valid: true, authoredBy: 't', approvedBy: { message: 'm', at: new Date().toISOString() }, review: { decision: 'approved', perception: 'direct-text', checks: [{ criterion: 'x', status: 'pass', location: 'x', evidence: 'x' }] } });
  p.artifacts.push({ id: 'characterPrompt:alex@1', key: 'characterPrompt:alex', kind: 'characterPrompt', version: 1, digest: 'c', content: { prompt: 'rev5 sheet prompt', characterDigest: 'd', referenceHashes: [image(1).sha256], recipeSha256: 'h' }, dependencies: [], valid: true, authoredBy: 't', approvedBy: { message: 'm', at: new Date().toISOString() }, review: { decision: 'approved', perception: 'direct-text', checks: [{ criterion: 'x', status: 'pass', location: 'x', evidence: 'x' }] } });
  p.characterId = 'alex'; p.step = 'candidates'; p.gate = 'produce';
  return p;
}

test('rev-4 import-sheet records provenance, costs nothing, and routes to Vera review', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imp4-'));
  try {
    const outside = join(dir, 'outside-sheet.png');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=purple:s=1200x900', '-frames:v', '1', outside]);
    const imported = await importMedia(outside, dir);
    let p = rev4AtSheet();
    const jobsBefore = p.jobs.length;
    p = send(p, 'import-sheet', { actor: 'human', characterId: 'alex', importFile: imported, importProvenance: { source: 'operator-import', originalPath: basename(outside), sha256: imported.sha256, importedAt: new Date().toISOString(), message: 'ISOLATED outside sheet' }, message: 'ISOLATED outside sheet' });
    assert.equal(p.step, 'sheet'); assert.equal(p.gate, 'review');
    const a = current(p);
    assert.equal(a.content.files.length, 1);
    assert.equal(a.content.files[0].sha256, imported.sha256);
    assert.equal(a.content.provenance.source, 'operator-import');
    assert.equal(a.content.provenance.originalPath, 'outside-sheet.png');
    assert.equal(p.jobs.length, jobsBefore);
    // Vera review then human approval like generated media
    p = send(p, 'review', { workerId: 'vera', artifactId: a.id, artifactDigest: a.digest, review: { decision: 'approved', perception: 'direct-image', checks: criteria.sheet.map(criterion => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED import' })), toolEvidence: [{ tool: 'viewImage', sha256: imported.sha256 }] } });
    assert.equal(p.gate, 'human');
    p = send(p, 'approve', { artifactId: a.id, artifactDigest: a.digest, message: 'ISOLATED approve import', humanReview: { decision: 'approved', perception: 'crew-review', checks: [] } });
    assert.equal(characterSheet(p, 'alex').sha256, imported.sha256);
  } finally { await rm(dir, { recursive: true }); }
});

test('rev-5 import-sheet creates 3-option candidates from one outside file with same provenance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imp5-'));
  try {
    const outside = join(dir, 'outside5.png');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=1200x900', '-frames:v', '1', outside]);
    const imported = await importMedia(outside, dir);
    let p = rev5AtCandidates();
    p = send(p, 'import-sheet', { actor: 'human', characterId: 'alex', importFile: imported, importProvenance: { source: 'operator-import', originalPath: basename(outside), sha256: imported.sha256, importedAt: new Date().toISOString(), message: 'ISOLATED rev5 import' }, message: 'ISOLATED rev5 import' });
    assert.equal(p.step, 'candidates'); assert.equal(p.gate, 'review');
    const a = current(p);
    assert.equal(a.content.files.length, 3);
    assert.ok(a.content.files.every(f => f.sha256 === imported.sha256));
    assert.equal(a.content.provenance.source, 'operator-import');
    p = send(p, 'review', { workerId: 'vera', artifactId: a.id, artifactDigest: a.digest, review: { decision: 'approved', perception: 'direct-image', checks: criteria.sheet.map(criterion => ({ criterion, status: 'pass', location: 'ISOLATED', evidence: 'ISOLATED' })), recommendation: { selection: 0, ranking: [0, 1, 2], reason: 'ISOLATED identical imports; option 1 is fine.' }, toolEvidence: [{ tool: 'viewImage', sha256: imported.sha256 }] } });
    // toolEvidence needs every file (same sha, one receipt covers all three since same sha)
    assert.equal(p.gate, 'human');
    p = send(p, 'approve', { artifactId: a.id, artifactDigest: a.digest, message: 'ISOLATED pick', selection: 0, humanReview: { decision: 'approved', perception: 'crew-review', checks: [] } });
    assert.equal(characterSheet(p, 'alex').sha256, imported.sha256);
  } finally { await rm(dir, { recursive: true }); }
});

test('import-sheet rejects wrong step, wrong aspect, and non-image', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imp-neg-'));
  try {
    const good = await realSheet(dir, 'good.png', '1200x900');
    const wide = await realSheet(dir, 'wide.png', '1600x900');
    let p = rev4AtSheet();
    assert.throws(() => send(p, 'import-sheet', { actor: 'human', characterId: 'bob', importFile: good, message: 'x' }), /current sheet step/);
    assert.throws(() => send(p, 'import-sheet', { actor: 'human', characterId: 'alex', importFile: wide, message: 'x' }), /4:3/);
    let q = rev5AtCandidates();
    q.step = 'characterPrompt';
    assert.throws(() => send(q, 'import-sheet', { actor: 'human', characterId: 'alex', importFile: good, message: 'x' }), /current candidates step/);
  } finally { await rm(dir, { recursive: true }); }
});
