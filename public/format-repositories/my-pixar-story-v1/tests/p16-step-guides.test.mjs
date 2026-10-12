// P16 part 5: Sage per-step guides. The loader pins crew/<name>/steps/<step>.md,
// the current step's guide rides on the task as stepGuide, and every guide's
// criteria list matches runtime/contracts.mjs exactly. No network, no live
// models, no codex app-server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hard safety: network calls prohibited
globalThis.fetch = () => { throw new Error('FETCH_PROHIBITED: Network calls are forbidden in p16 tests.'); };
process.env.CODEX_TRACING = 'off';

// Hard safety: 60s unref file guard
const fileGuard = setTimeout(() => {
  console.error('GUARD_TIMEOUT: 60s file guard triggered in p16-step-guides.test.mjs');
  process.exit(1);
}, 60000);
fileGuard.unref();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const kitDir = resolve(__dirname, '..');

const { loadStudio, workerInstructions, StudioSnapshot } = await import('../runtime/instructions.mjs');
const { initialProject, taskFor } = await import('../runtime/workflow.mjs');
const { prepareCrewTask } = await import('../runtime/crew.mjs');
const { criteria, digest } = await import('../runtime/contracts.mjs');
const { inputs, script } = await import('./helpers.mjs');

const sha256 = s => createHash('sha256').update(s).digest('hex');
const stepFiles = () => readdirSync(resolve(kitDir, 'crew/sage/steps')).filter(f => f.endsWith('.md')).sort();

test('safety self-check: no forbidden process, network or host imports in source', { timeout: 20000 }, async () => {
  const source = await readFile(__filename, 'utf8');
  assert.ok(!/(?:import\s+.*from\s+['"](?:node:)?child_process['"]|require\(['"](?:node:)?child_process['"]\))/.test(source), 'must not import child_process');
  assert.ok(!/(?:import\s+.*from\s+['"](?:node:)?worker_threads['"]|require\(['"](?:node:)?worker_threads['"]\))/.test(source), 'must not import worker_threads');
  assert.ok(!/(?:import\s+.*from\s+['"].*codex-host\.mjs['"])/.test(source), 'must not import codex-host.mjs');
  assert.ok(!/(?:import\s+.*from\s+['"].*openrouter-host\.mjs['"])/.test(source), 'must not import openrouter-host.mjs');
  assert.ok(!/(?<!['"])\brunCrewTask\s*\(/.test(source), 'must not call runCrewTask');
  assert.ok(!/['"]codex\s+app-server['"]/.test(source), 'must not mention starting codex app-server');
});

test('loader pins every sage step guide with the same shape skill uses', { timeout: 20000 }, async () => {
  const studio = loadStudio();
  const files = stepFiles();
  assert.equal(files.length, 16, 'sixteen sage step guides');
  for (const f of files) {
    const path = `crew/sage/steps/${f}`;
    const doc = studio.documents[path];
    assert.ok(doc, `document pinned for ${path}`);
    assert.deepEqual(Object.keys(doc).sort(), ['content', 'sha256'], `${path} has the skill shape {content, sha256}`);
    assert.equal(doc.sha256, sha256(doc.content), `sha256 matches for ${path}`);
    assert.equal(doc.content, await readFile(resolve(kitDir, path), 'utf8'), `pinned content matches disk for ${path}`);
  }
});

test('every step guide names a real step and its criteria match contracts.mjs exactly', { timeout: 20000 }, async () => {
  // Guides list criteria in a `Criteria: a, b, c.` line plus `- name:` bullets
  // (no backticked IDs); both forms must agree with contracts.mjs as sets.
  const mismatches = [];
  for (const f of stepFiles()) {
    const step = f.replace(/\.md$/, '');
    const content = await readFile(resolve(kitDir, 'crew/sage/steps', f), 'utf8');
    if (!criteria[step]) {
      mismatches.push({ step, problem: 'not a real contracts.criteria step' });
      continue;
    }
    const listed = content.split('\n').find(l => l.startsWith('Criteria:'));
    const listedSet = new Set((listed ?? '').replace(/^Criteria:\s*/, '').split(',').map(s => s.trim().replace(/[`.\s]+$/g, '').replace(/^`/, '')).filter(Boolean));
    const expectedSet = new Set(criteria[step]);
    const missing = [...expectedSet].filter(c => !listedSet.has(c));
    const extra = [...listedSet].filter(c => !expectedSet.has(c));
    if (missing.length || extra.length) mismatches.push({ step, missing, extra });
    for (const line of content.split('\n')) {
      const bullet = line.match(/^-\s*([^:]+):/);
      if (!bullet || line.startsWith('- [')) continue;
      for (const name of bullet[1].split(',').map(s => s.trim().replace(/^`|`$/g, ''))) {
        if (name && !expectedSet.has(name)) mismatches.push({ step, problem: `bullet names unknown criterion ${name}` });
      }
    }
  }
  assert.deepEqual(mismatches, [], `step-guide criteria must match contracts.mjs: ${JSON.stringify(mismatches)}`);
});

test('shots.md first paragraph carries the plate-fidelity sentence', { timeout: 20000 }, async () => {
  const content = await readFile(resolve(kitDir, 'crew/sage/steps/shots.md'), 'utf8');
  const head = content.split('\n- ')[0];
  assert.match(head, /You may look at the plates for context, but plate fidelity is the visual reviewer's call\./);
  assert.match(head, /Never claim to have checked a plate\./);
});

test('taskFor attaches stepGuide for sage steps, omits it otherwise, and the tamper check covers it', { timeout: 20000 }, async () => {
  // Sage review task: script/review is text-reviewer work on a guided step.
  let p = initialProject('p16-stepguide', inputs, { workflowRevision: 2 });
  p.artifacts.push({ id: 'script@1', key: 'script', kind: 'script', version: 1, digest: digest(script), content: script, dependencies: [], valid: true, authoredBy: 't' });
  p.step = 'script'; p.gate = 'review';
  const task = taskFor(p);
  assert.equal(task.formatRole, 'text-reviewer');
  assert.ok(task.stepGuide, 'sage review task carries stepGuide');
  assert.equal(task.stepGuide.path, 'crew/sage/steps/script.md');
  assert.equal(task.stepGuide.sha256, loadStudio().documents['crew/sage/steps/script.md'].sha256);
  assert.ok(task.stepGuide.content.includes('Criteria: facts, relationship, clarity, emotional-purpose, timing, common-sense.'));

  // Untouched task prepares fine; a tampered stepGuide is rejected.
  await prepareCrewTask(p, task);
  const tampered = { ...task, stepGuide: { path: task.stepGuide.path, content: 'tampered', sha256: '0'.repeat(64) } };
  await assert.rejects(() => prepareCrewTask(p, tampered), /TASK_INPUT_MISMATCH: stepGuide is missing, changed or stale/);

  // Non-sage work has no guide: answers/author is script-writer work.
  const plain = taskFor(initialProject('p16-noguide', inputs, { workflowRevision: 2 }));
  assert.equal(plain.formatRole, 'script-writer');
  assert.equal('stepGuide' in plain, false, 'no stepGuide key when the role has no steps/<step>.md');

  // Old snapshots without step documents still load and carry no stepGuide.
  const studio = loadStudio();
  const legacyConfig = structuredClone(studio.config);
  delete legacyConfig.craft;
  const legacyDocuments = {};
  for (const [k, v] of Object.entries(studio.documents)) {
    if (!k.includes('/steps/') && !k.startsWith('craft-guide.md#')) legacyDocuments[k] = v;
  }
  const legacyStudio = StudioSnapshot.parse({ config: legacyConfig, documents: legacyDocuments, sha256: digest({ config: legacyConfig, documents: legacyDocuments }) });
  const legacyTask = taskFor(initialProject('p16-legacy', inputs, { studio: legacyStudio, workflowRevision: 2 }));
  assert.equal('stepGuide' in legacyTask, false, 'legacy snapshot task has no stepGuide');
});

test('text rubric drops the child-language rule and the Shaz wording', { timeout: 20000 }, async () => {
  const textRubric = await readFile(resolve(kitDir, 'evaluation/rubrics/text.md'), 'utf8');
  assert.doesNotMatch(textRubric, /language a child can understand/);
  assert.doesNotMatch(textRubric, /Shaz's/);
  assert.match(textRubric, /the maker's locked answers/);
});
