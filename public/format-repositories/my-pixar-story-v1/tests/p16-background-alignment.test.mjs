// P16 parts 6-8: background/craft/rubric alignment. Locks the reworded craft
// rules, the background recipe, the visual rubric and the neutral prescreen
// wording, and proves Vera can open roster reference photos through task
// dependencies. No network, no live models, no codex app-server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hard safety: network calls prohibited
globalThis.fetch = () => { throw new Error('FETCH_PROHIBITED: Network calls are forbidden in p16 tests.'); };
process.env.CODEX_TRACING = 'off';

// Hard safety: 60s unref file guard
const fileGuard = setTimeout(() => {
  console.error('GUARD_TIMEOUT: 60s file guard triggered in p16-background-alignment.test.mjs');
  process.exit(1);
}, 60000);
fileGuard.unref();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const kitDir = resolve(__dirname, '..');

const { initialProject, taskFor } = await import('../runtime/workflow.mjs');
const { crewTools } = await import('../runtime/crew.mjs');
const { digest } = await import('../runtime/contracts.mjs');
const { importMedia } = await import('../runtime/media.mjs');
const { inputs } = await import('./helpers.mjs');

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('safety self-check: no forbidden process, network or host imports in source', { timeout: 20000 }, async () => {
  const source = await readFile(__filename, 'utf8');
  assert.ok(!/(?:import\s+.*from\s+['"].*codex-host\.mjs['"])/.test(source), 'must not import codex-host.mjs');
  assert.ok(!/(?:import\s+.*from\s+['"].*openrouter-host\.mjs['"])/.test(source), 'must not import openrouter-host.mjs');
  assert.ok(!/(?<!['"])\brunCrewTask\s*\(/.test(source), 'must not call runCrewTask');
  assert.ok(!/['"]codex\s+app-server['"]/.test(source), 'must not mention starting codex app-server');
});

test('craft locations: bible filmAccent example, camera side, shots-first tag, dressed and no-text rules', { timeout: 20000 }, async () => {
  const guide = await read('../craft-guide.md');
  assert.match(guide, /Film accent kept out: <the bible's filmAccent colour>/);
  assert.doesNotMatch(guide, /Film accent kept out: deep red/);
  assert.match(guide, /\[L-CAMERA-SIDE\] \(check: vera, beau\) The camera stays on the same side of the action line as the master for the whole location; turning within that half is fine\./);
  assert.match(guide, /\[L-SHOTS-FIRST\] \(check: beau, sage\)/);
  assert.match(guide, /\[L-ACCENT-OUT\] \(check: vera, sage\) Keep the production bible's `filmAccent` colour out of the room entirely\./);
  assert.match(guide, /production bible's `filmAccent` colour kept out/);
  const dressed = guide.split('\n').find(l => l.startsWith('- [L-DRESSED]'));
  assert.match(dressed, /Empty of people only, never an empty set \(a writer rule, not prompt text\)/);
  assert.match(dressed, /from the brief's known and proposed details/);
  assert.match(dressed, /Neutral era-consistent dressing is fine/i);
  assert.match(dressed, /generic catalog room still fails/i);
  assert.doesNotMatch(dressed, /hobbies, dreams/);
  const minText = guide.split('\n').find(l => l.startsWith('- [L-MIN-TEXT]'));
  assert.match(minText, /No readable text in plates/);
  assert.doesNotMatch(minText, /4 names/);
});

test('background recipe: one empty-of-people clause, brief-only dressing, whole spec block, house look', { timeout: 20000 }, async () => {
  const recipe = await read('../background-prompter.md');
  assert.match(recipe, /the room is empty of people/);
  assert.equal(recipe.match(/the room is empty of people/g).length, 1, 'exactly one empty-of-people clause');
  assert.doesNotMatch(recipe, /zero people|zero crowds|zero silhouettes|silhouette|humans|crowds/i);
  assert.doesNotMatch(recipe, /\(era, age, hobbies, dreams\)/);
  assert.doesNotMatch(recipe, /feature-quality/i);
  assert.match(recipe, /house look in `craft-guide\.md#house-style`/);
  assert.match(recipe, /knownDetails and proposedDetails only/);
  assert.match(recipe, /Copy the brief's lighting and colour spec block whole as the last part of every prompt/);
  assert.match(recipe, /"Film accent kept out: <bible colour>" line/);
});

test('visual rubric: neutral dressing, no feature wording, no video section, exact fail mapping', { timeout: 20000 }, async () => {
  const visual = await read('../evaluation/rubrics/visual.md');
  assert.doesNotMatch(visual, /hobbies, dreams/);
  assert.doesNotMatch(visual, /feature-quality 3D/);
  assert.doesNotMatch(visual, /contact sheet|final film/i);
  assert.match(visual, /stylized animated feature/);
  assert.match(visual, /Neutral, era-consistent dressing is fine and is never a failure/);
  assert.match(visual, /anything held in the hands \(`turnaround`, and only `turnaround`\)/);
  assert.match(visual, /on a character sheet fails `style` \(\[R-SHEET-NO-TEXT\]\)/);
  assert.match(visual, /in a background plate fails `story-specific-set` \(\[L-MIN-TEXT\]\)/);
});

test('decisions prescreen uses neutral style wording', { timeout: 20000 }, async () => {
  const { PRESCREEN_QUESTIONS } = await import('../runtime/decisions-prescreen.mjs');
  assert.doesNotMatch(JSON.stringify(PRESCREEN_QUESTIONS), /Pixar-like/);
  assert.match(PRESCREEN_QUESTIONS.style.instructions, /stylized 3D animated-feature look/);
});

test('Vera opens roster reference photos via dependencies in a replayed rev-4 candidates task', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p16-vera-refs-'));
  try {
    const mk = async name => {
      const pth = join(dir, name);
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1600x900', '-frames:v', '1', pth]);
      return importMedia(pth, dir);
    };
    const photo = await mk('roster-photo.png');
    const files = [await mk('opt0.png'), await mk('opt1.png'), await mk('opt2.png')];
    let p = initialProject('p16-vera-refs', inputs, { workflowRevision: 4, reviewMode: 'supervised' });
    p.artifacts.push({ id: 'script@1', key: 'script', kind: 'script', version: 1, digest: 's', content: { beats: [1, 2, 3, 4].map(i => ({ beat: i, durationSeconds: 15, narration: 'x', emotionalPurpose: 'c', sourceAnswers: ['scene1Childhood'] })), commonSenseChecks: [] }, dependencies: [], valid: true, authoredBy: 't' });
    p.artifacts.push({ id: 'roster@1', key: 'roster', kind: 'roster', version: 1, digest: digest({ photo: photo.sha256 }), content: { characters: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', important: true, references: [photo], notes: 'x' }] }, dependencies: [], valid: true, authoredBy: 't' });
    p.artifacts.push({ id: 'characterPrompt:alex@1', key: 'characterPrompt:alex', kind: 'characterPrompt', version: 1, digest: 'c', content: { prompt: 'character', characterDigest: 'd', referenceHashes: [photo.sha256], recipeSha256: 'h' }, dependencies: [], valid: true, authoredBy: 't' });
    p.artifacts.push({ id: 'candidates:alex@1', key: 'candidates:alex', kind: 'candidates', version: 1, digest: digest({ files, prompt: 'character' }), content: { files, prompt: 'character' }, dependencies: [], valid: true, authoredBy: 'provider-runtime' });
    p.characterId = 'alex'; p.step = 'candidates'; p.gate = 'review';
    const task = taskFor(p);
    assert.equal(task.formatRole, 'visual-reviewer');
    assert.ok(task.dependencies.some(a => a.key === 'roster'), 'roster rides along as a locked dependency');
    const tools = crewTools(task, { name: 'Vera', role: 'visual-reviewer' }, { viewImage: async () => ({ perception: 'direct-image' }) }, () => {});
    // The roster photo is in scope through dependencies, not just the artifact.
    const seen = await tools('viewImage', { sha256: photo.sha256 });
    assert.equal(seen.perception, 'direct-image');
    for (const f of files) assert.equal((await tools('viewImage', { sha256: f.sha256 })).perception, 'direct-image');
    await assert.rejects(tools('viewImage', { sha256: '0'.repeat(64) }), /ASSET_SCOPE_DENIED/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
