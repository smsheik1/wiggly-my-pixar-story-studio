import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadStudio, workerInstructions, StudioSnapshot } from '../runtime/instructions.mjs';
import { initialProject, taskFor } from '../runtime/workflow.mjs';
import { prepareCrewTask, buildWorkerPacket, WORKER_PACKET_INSTRUCTION } from '../runtime/crew.mjs';
import { compileBible, defaultStyle, LEGACY_DEFAULT_STYLE, PIPELINE_STYLE_RULES } from '../runtime/bible.mjs';
import { roleFingerprint } from '../evaluation/dept-evals.mjs';
import { digest } from '../runtime/contracts.mjs';
import { inputs } from './helpers.mjs';

const sha256 = s => createHash('sha256').update(s).digest('hex');

test('1. split, pin and sha: loadStudio pins all sections and rule-level entries with correct sha256', { timeout: 20000 }, async () => {
  const studio = loadStudio();
  assert.ok(studio.config.craft, 'craft block exists in studio.json');
  assert.equal(studio.config.craft.path, 'craft-guide.md');

  // Verify all 16 contracted sections are pinned
  const expectedSections = [
    'house-style', 'script-craft', 'character-design', 'prompt-rules',
    'identity', 'character-sheet', 'edit-prompts', 'locations',
    'composition', 'video-sources', 'video-animation', 'video-architecture',
    'video-blocks', 'video-transitions', 'video-failures', 'working-method'
  ];

  for (const id of expectedSections) {
    const key = `craft-guide.md#${id}`;
    const doc = studio.documents[key];
    assert.ok(doc, `document pinned for ${key}`);
    assert.ok(doc.content.startsWith(`## [${id}]`), `content starts with heading for ${id}`);
    assert.equal(doc.sha256, sha256(doc.content), `sha256 matches for ${key}`);
  }

  // Verify rule-level entry script-craft#S-REACTION is pinned
  const ruleKey = 'craft-guide.md#script-craft#S-REACTION';
  const ruleDoc = studio.documents[ruleKey];
  assert.ok(ruleDoc, `document pinned for ${ruleKey}`);
  assert.ok(ruleDoc.content.startsWith('- [S-REACTION]'), `rule content is rule line: ${ruleDoc.content}`);
  assert.equal(ruleDoc.sha256, sha256(ruleDoc.content));
});

test('2. validation: loadStudio rejects duplicate sections, duplicate rules, unknown sections, unknown rules, and unknown roles', { timeout: 20000 }, async () => {
  const studio = loadStudio();
  const baseConfig = structuredClone(studio.config);
  const realGuide = await readFile(new URL('../craft-guide.md', import.meta.url), 'utf8');

  const makeDir = async (config, craftContent) => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-test-'));
    await writeFile(join(dir, 'studio.json'), JSON.stringify(config));
    await writeFile(join(dir, 'craft-guide.md'), craftContent);
    for (const [path, doc] of Object.entries(studio.documents)) {
      if (!path.includes('#')) {
        await mkdir(join(dir, path, '..'), { recursive: true });
        await writeFile(join(dir, path), doc.content);
      }
    }
    return dir;
  };

  // 1. Duplicate section ID in craft guide
  const dupSecGuide = `
## [house-style] House Style
- [H-STYLE] Style line
## [house-style] Duplicate House Style
- [H-STYLE-2] Another line
`;
  let dir = await makeDir(baseConfig, dupSecGuide);
  try {
    assert.throws(() => loadStudio(pathToFileURL(dir + '/')), /CRAFT_DUPLICATE_SECTION/);
  } finally { await rm(dir, { recursive: true, force: true }); }

  // 2. Duplicate rule ID across sections in craft guide
  const dupRuleGuide = `
## [house-style] House Style
- [H-STYLE] Style line
## [locations] Locations
- [H-STYLE] Duplicate rule id
`;
  dir = await makeDir(baseConfig, dupRuleGuide);
  try {
    assert.throws(() => loadStudio(pathToFileURL(dir + '/')), /CRAFT_DUPLICATE_RULE/);
  } finally { await rm(dir, { recursive: true, force: true }); }

  // 3. Unknown section in role mapping
  const badSectionCfg = structuredClone(baseConfig);
  badSectionCfg.craft.sections['script-writer'] = ['unknown-section'];
  dir = await makeDir(badSectionCfg, realGuide);
  try {
    assert.throws(() => loadStudio(pathToFileURL(dir + '/')), /CRAFT_UNKNOWN_SECTION/);
  } finally { await rm(dir, { recursive: true, force: true }); }

  // 4. Unknown rule in role mapping
  const badRuleCfg = structuredClone(baseConfig);
  badRuleCfg.craft.sections['shot-planner'] = ['script-craft#UNKNOWN-RULE'];
  dir = await makeDir(badRuleCfg, realGuide);
  try {
    assert.throws(() => loadStudio(pathToFileURL(dir + '/')), /CRAFT_UNKNOWN_RULE/);
  } finally { await rm(dir, { recursive: true, force: true }); }

  // 5. Unknown role in craft mapping (role not in config.agents)
  const badRoleCfg = structuredClone(baseConfig);
  badRoleCfg.craft.sections['non-existent-agent'] = ['house-style'];
  dir = await makeDir(badRoleCfg, realGuide);
  try {
    assert.throws(() => loadStudio(pathToFileURL(dir + '/')), /CRAFT_UNKNOWN_ROLE/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('3. workerInstructions: returns craft sections in mapping order, including rule-level pinning for shot-planner', { timeout: 20000 }, async () => {
  const p = initialProject('craft-test-p1', inputs);

  // shot-planner gets rule-level entry script-craft#S-REACTION
  const sam = workerInstructions(p, 'shot-planner');
  assert.ok(sam.craft, 'sam has craft');
  assert.equal(sam.craft.length, 1);
  assert.equal(sam.craft[0].id, 'script-craft#S-REACTION');
  assert.ok(sam.craft[0].content.startsWith('- [S-REACTION]'));
  assert.equal(sam.craft[0].sha256, sha256(sam.craft[0].content));

  // sheet-prompter gets 7 sections in exact mapping order
  const pia = workerInstructions(p, 'sheet-prompter');
  assert.ok(pia.craft, 'pia has craft');
  assert.deepEqual(
    pia.craft.map(c => c.id),
    ['house-style', 'character-design', 'prompt-rules', 'identity', 'character-sheet', 'edit-prompts', 'working-method']
  );
  for (const c of pia.craft) {
    assert.ok(c.content.startsWith(`## [${c.id}]`));
    assert.equal(c.sha256, sha256(c.content));
  }

  // sound-designer has empty mapping []
  const finn = workerInstructions(p, 'sound-designer');
  assert.ok(finn.craft, 'finn has craft array');
  assert.deepEqual(finn.craft, []);
});

test('4. backwards compatibility: historical snapshot without craft produces byte-identical packets and instructions', { timeout: 20000 }, async () => {
  const studio = loadStudio();

  // Create historical snapshot without craft block
  const legacyConfig = structuredClone(studio.config);
  delete legacyConfig.craft;
  const legacyDocuments = {};
  for (const [k, v] of Object.entries(studio.documents)) {
    if (!k.startsWith('craft-guide.md#')) {
      legacyDocuments[k] = v;
    }
  }
  const legacyStudio = StudioSnapshot.parse({
    config: legacyConfig,
    documents: legacyDocuments,
    sha256: digest({ config: legacyConfig, documents: legacyDocuments }),
  });

  const legacyProject = initialProject('legacy-p1', inputs, { studio: legacyStudio });
  const role = 'script-writer';

  // workerInstructions must omit craft key entirely
  const legacyInstr = workerInstructions(legacyProject, role);
  assert.equal(legacyInstr.craft, undefined);
  assert.equal('craft' in legacyInstr, false);

  // taskFor must omit craft key entirely
  const legacyTask = taskFor(legacyProject);
  assert.equal(legacyTask.craft, undefined);
  assert.equal('craft' in legacyTask, false);

  // buildWorkerPacket must use unadorned WORKER_PACKET_INSTRUCTION
  const worker = { workerId: 'w-1', name: 'Leo', role: 'script-writer', modelVersion: 'm1', capabilityVersion: 'c1', execution: 'host' };
  const packetJson = buildWorkerPacket(legacyTask, worker);
  const parsedPacket = JSON.parse(packetJson);
  assert.equal(parsedPacket.instruction, WORKER_PACKET_INSTRUCTION);
  assert.equal(parsedPacket.task.craft, undefined);
  assert.doesNotMatch(parsedPacket.instruction, /task\.craft sections are house craft rules/);
});

test('5. worker packet and prepareCrewTask: craft field is in digest check and craft sentence is added to instruction', { timeout: 20000 }, async () => {
  const p = initialProject('craft-task-p1', inputs);
  const task = taskFor(p);
  assert.ok(task.craft, 'task has craft');

  // Verify buildWorkerPacket adds the exact house craft sentence
  const worker = { workerId: 'w-1', name: 'Leo', role: 'script-writer', modelVersion: 'm1', capabilityVersion: 'c1', execution: 'host' };
  const packetJson = buildWorkerPacket(task, worker);
  const parsed = JSON.parse(packetJson);
  const expectedSentence = 'task.craft sections are house craft rules; your skill says how to apply them to this task; the no-invented-facts rule wins any conflict.';
  assert.ok(parsed.instruction.endsWith(expectedSentence));
  assert.equal(parsed.instruction, `${WORKER_PACKET_INSTRUCTION} ${expectedSentence}`);
  assert.deepEqual(parsed.task.craft, task.craft);

  // Verify prepareCrewTask validates craft in fields
  const prepared = await prepareCrewTask(p, task);
  assert.ok(prepared);

  // Tampering with craft causes TASK_INPUT_MISMATCH
  const tamperedTask = { ...task, craft: [{ id: 'fake', content: 'tampered', sha256: 'deadbeef' }] };
  await assert.rejects(
    () => prepareCrewTask(p, tamperedTask),
    /TASK_INPUT_MISMATCH: craft is missing, changed or stale/
  );
});

test('6. bible default style: compileBible extracts style from pinned house-style and L-SETS-DEFAULT when craft is present, falls back to LEGACY_DEFAULT_STYLE when absent', { timeout: 20000 }, async () => {
  const p = initialProject('bible-style-p1', inputs);
  const compiled = compileBible(p);

  // Craft-enabled project: extracted from pinned sections (wording-independent, so Muse can
  // rewrite the guide without touching this test).
  const st0 = loadStudio();
  const rulesOf = key => st0.documents[`craft-guide.md#${key}`].content.split('\n').map(l => l.trim().match(/^-\s*\[([A-Z0-9_-]+)\](?:\s*\([^)]*\))?\s*(.*)$/)).filter(Boolean).map(m => ({ id: m[1], text: m[2].trim() }));
  const house = rulesOf('house-style');
  assert.equal(compiled.style.look, house.find(r => r.id === 'H-STYLE').text);
  assert.equal(compiled.style.sets, rulesOf('locations').find(r => r.id === 'L-SETS-DEFAULT').text);
  const minText = rulesOf('locations').find(r => r.id === 'L-MIN-TEXT').text;
  assert.deepEqual(compiled.style.rules, [...house.filter(r => r.id !== 'H-STYLE').map(r => r.text), ...PIPELINE_STYLE_RULES, `Location plates: ${minText}`]);
  assert.ok(compiled.style.rules.some(r => /no text.*character sheets and keyframes/i.test(r)), 'sheets and keyframes never carry text (Shaz)');
  assert.ok(/Pixar-style/.test(compiled.style.look), 'r5 #2: craft-era bible look names the Pixar target look again');

  // A craft snapshot missing H-STYLE fails loudly instead of falling back
  const broken = structuredClone(st0);
  broken.documents['craft-guide.md#house-style'] = { content: '## [house-style] House style\n', sha256: 'x' };
  assert.throws(() => defaultStyle(broken), /BIBLE_STYLE_MISSING: \[H-STYLE\]/);

  // Project without craft: explicitly falls back to LEGACY_DEFAULT_STYLE
  const studio = loadStudio();
  const legacyConfig = structuredClone(studio.config);
  delete legacyConfig.craft;
  const legacyDocuments = {};
  for (const [k, v] of Object.entries(studio.documents)) {
    if (!k.startsWith('craft-guide.md#')) {
      legacyDocuments[k] = v;
    }
  }
  const legacyStudio = StudioSnapshot.parse({
    config: legacyConfig,
    documents: legacyDocuments,
    sha256: digest({ config: legacyConfig, documents: legacyDocuments }),
  });
  const legacyProject = initialProject('bible-legacy-p1', inputs, { studio: legacyStudio });
  const legacyCompiled = compileBible(legacyProject);
  assert.deepEqual(legacyCompiled.style, LEGACY_DEFAULT_STYLE);

  // defaultStyle direct call
  assert.deepEqual(defaultStyle(null), LEGACY_DEFAULT_STYLE);
  assert.deepEqual(defaultStyle(legacyStudio), LEGACY_DEFAULT_STYLE);
  assert.deepEqual(defaultStyle(studio), compiled.style);
});

test('7. dept-evals roleFingerprint: includes role-scoped craft map and restricts recipes to the role\'s actual usage', { timeout: 20000 }, async () => {
  const studio = loadStudio();

  // 1. sheet-prompter (Pia): has mapped craft sections + character-sheet-recipe.md only
  const piaFp = await roleFingerprint('sheet-prompter', studio);
  assert.ok(piaFp.parts.craft);
  assert.deepEqual(
    Object.keys(piaFp.parts.craft),
    ['house-style', 'character-design', 'prompt-rules', 'identity', 'character-sheet', 'edit-prompts', 'working-method']
  );
  assert.deepEqual(Object.keys(piaFp.parts.recipes), ['character-sheet-recipe.md']);

  // 2. cast-designer (Cleo): has character-prompter.md only
  const cleoFp = await roleFingerprint('cast-designer', studio);
  assert.deepEqual(Object.keys(cleoFp.parts.recipes), ['character-prompter.md']);

  // 3. pixar-prompter (Theo): background-prompter.md only (master + angle stages share it)
  const theoFp = await roleFingerprint('pixar-prompter', studio);
  assert.deepEqual(Object.keys(theoFp.parts.recipes), ['background-prompter.md']);

  // 3b. reviewers who see a recipe in their task carry it: Sage reviews all prompt steps,
  // Beau owner-reviews Theo's background prompts.
  const sageFp = await roleFingerprint('text-reviewer', studio);
  assert.deepEqual(Object.keys(sageFp.parts.recipes).sort(), ['background-prompter.md', 'character-prompter.md', 'character-sheet-recipe.md']);
  const beauFp = await roleFingerprint('background-product-owner', studio);
  assert.deepEqual(Object.keys(beauFp.parts.recipes), ['background-prompter.md']);

  // 4. shot-planner (Sam): has script-craft#S-REACTION and NO recipes
  const samFp = await roleFingerprint('shot-planner', studio);
  assert.deepEqual(Object.keys(samFp.parts.craft), ['script-craft#S-REACTION']);
  assert.deepEqual(samFp.parts.recipes, {});

  // 5. visual-reviewer (Vera): reviewer has craft sections and NO recipes
  const veraFp = await roleFingerprint('visual-reviewer', studio);
  assert.deepEqual(
    Object.keys(veraFp.parts.craft),
    ['house-style', 'character-design', 'identity', 'character-sheet', 'locations']
  );
  assert.deepEqual(veraFp.parts.recipes, {});
});
