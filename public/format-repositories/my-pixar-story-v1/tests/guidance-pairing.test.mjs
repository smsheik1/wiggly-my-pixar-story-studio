import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Hard safety: network calls prohibited
globalThis.fetch = () => { throw new Error('FETCH_PROHIBITED: Network calls are forbidden in guard tests.'); };
process.env.CODEX_TRACING = 'off';

// Hard safety: 60s unref file guard
const fileGuard = setTimeout(() => {
  console.error('GUARD_TIMEOUT: 60s file guard triggered in guidance-pairing.test.mjs');
  process.exit(1);
}, 60000);
fileGuard.unref();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const kitDir = resolve(__dirname, '..');
const repoRoot = resolve(kitDir, '../../..');

const { loadStudio } = await import('../runtime/instructions.mjs');
const { crewRoles } = await import('../runtime/crew.mjs');
const { defaultStyle } = await import('../runtime/bible.mjs');

test('safety self-check: no forbidden process, network or host imports in source', { timeout: 20000 }, async () => {
  const source = await readFile(__filename, 'utf8');
  assert.ok(!/(?:import\s+.*from\s+['"](?:node:)?child_process['"]|require\(['"](?:node:)?child_process['"]\))/.test(source), 'must not import child_process');
  assert.ok(!/(?:import\s+.*from\s+['"](?:node:)?worker_threads['"]|require\(['"](?:node:)?worker_threads['"]\))/.test(source), 'must not import worker_threads');
  assert.ok(!/(?:import\s+.*from\s+['"].*codex-host\.mjs['"])/.test(source), 'must not import codex-host.mjs');
  assert.ok(!/(?:import\s+.*from\s+['"].*openrouter-host\.mjs['"])/.test(source), 'must not import openrouter-host.mjs');
  assert.ok(!/(?<!['"])\brunCrewTask\s*\(/.test(source), 'must not call runCrewTask');
  assert.ok(!/['"]codex\s+app-server['"]/.test(source), 'must not mention starting codex app-server');
});

test('check 5: writer->reviewer pairing: checked-rule sections reach reviewers and reviewer rule IDs are real', { timeout: 20000 }, async () => {
  // Pair against the LIVE guide (not the frozen P14 contract), so a check tag added to
  // craft-guide.md later is enforced too.
  const guide = await readFile(resolve(kitDir, 'craft-guide.md'), 'utf8');
  const contract = { sections: [] };
  for (const line of guide.split('\n')) {
    const h = line.match(/^##\s*\[([a-z0-9-]+)\]/);
    if (h) { contract.sections.push({ id: h[1], rules: [] }); continue; }
    const r = line.trim().match(/^-\s*\[([A-Z0-9_-]+)\]\s*\(check:\s*([^)]*)\)/);
    if (r && contract.sections.length) contract.sections.at(-1).rules.push({ id: r[1], check: r[2].split(',').map(t => t.trim()) });
  }
  assert.ok(contract.sections.length >= 16 && contract.sections.flatMap(s => s.rules).length >= 83, 'craft guide parsed');
  const studio = loadStudio();

  // Reviewer text is the skill plus the rubric plus (for Sage) the per-step
  // guides. Short core skills no longer name every rule ID: the full rule
  // text reaches the packet via task.craft for every mapped section, and the
  // step guide carries the step's criteria.
  const { readdirSync } = await import('node:fs');
  let sageSteps = '';
  try {
    for (const f of readdirSync(resolve(kitDir, 'crew/sage/steps')).filter(f => f.endsWith('.md')).sort()) {
      sageSteps += '\n' + (await readFile(resolve(kitDir, 'crew/sage/steps', f), 'utf8'));
    }
  } catch {}
  const reviewerDocs = {
    vera: (await readFile(resolve(kitDir, 'crew/vera/SKILL.md'), 'utf8')) + '\n' + (await readFile(resolve(kitDir, 'evaluation/rubrics/visual.md'), 'utf8')),
    sage: (await readFile(resolve(kitDir, 'crew/sage/SKILL.md'), 'utf8')) + '\n' + (await readFile(resolve(kitDir, 'evaluation/rubrics/text.md'), 'utf8')) + '\n' + sageSteps,
    june: (await readFile(resolve(kitDir, 'crew/june/SKILL.md'), 'utf8')) + '\n' + (await readFile(resolve(kitDir, 'evaluation/rubrics/scene.md'), 'utf8')),
    ava: (await readFile(resolve(kitDir, 'crew/ava/SKILL.md'), 'utf8')) + '\n' + (await readFile(resolve(kitDir, 'evaluation/rubrics/audio.md'), 'utf8')),
    beau: await readFile(resolve(kitDir, 'crew/beau/SKILL.md'), 'utf8')
  };

  const tagToRole = {
    vera: 'visual-reviewer',
    sage: 'text-reviewer',
    june: 'scene-reviewer',
    ava: 'audio-reviewer',
    beau: 'background-product-owner'
  };

  const unmappedSections = [];

  for (const section of contract.sections) {
    for (const rule of section.rules) {
      for (const tag of rule.check) {
        if (tag === 'none') continue;
        // Verify reviewer has section mapped in studio.json
        const role = tagToRole[tag];
        const mappedSections = studio.config.craft?.sections[role] ?? [];
        if (!mappedSections.includes(section.id)) {
          unmappedSections.push({ ruleId: rule.id, sectionId: section.id, role });
        }
      }
    }
  }

  assert.deepEqual(unmappedSections, [], `reviewers must have rule sections mapped in studio.json: ${JSON.stringify(unmappedSections)}`);

  // Every rule ID a reviewer doc names must be a real rule in the guide
  // (no stale references after rewrites).
  const validIds = new Set(contract.sections.map(s => s.id).concat(contract.sections.flatMap(s => s.rules.map(r => r.id))));
  const staleRefs = [];
  for (const [tag, doc] of Object.entries(reviewerDocs)) {
    const seen = new Set();
    for (const m of doc.matchAll(/\[([A-Z][A-Z0-9_-]{2,})\]/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      if (!validIds.has(m[1])) staleRefs.push({ reviewerTag: tag, ruleId: m[1] });
    }
  }
  assert.deepEqual(staleRefs, [], `reviewer docs must only name real craft rule IDs: ${JSON.stringify(staleRefs)}`);
});

test('check 6: provenance: dan guide section mapping, rule targets, and craftSha256 match', { timeout: 20000 }, async () => {
  const manifest = JSON.parse(await readFile(resolve(kitDir, 'guidance-manifest.json'), 'utf8'));
  const craftGuide = await readFile(resolve(kitDir, 'craft-guide.md'), 'utf8');

  // Verify craftSha256 matches craft-guide.md hash
  const currentSha = createHash('sha256').update(craftGuide).digest('hex');
  assert.equal(manifest.craftSha256, currentSha, 'craftSha256 in manifest must match current craft-guide.md sha256');

  const validSectionIds = [...craftGuide.matchAll(/^## \[([a-zA-Z0-9_-]+)\]/gm)].map(m => m[1]);
  const validRuleIds = [...craftGuide.matchAll(/^[ \t]*-[ \t]*\[([A-Z0-9_-]+)\]/gm)].map(m => m[1]);

  const danSections = [
    '§0.1', '§0.2', '§0.3', '§0.4',
    '§1', '§2', '§3', '§4', '§5', '§6', '§7', '§8', '§9',
    '§10', '§11', '§12', '§13', '§14', '§15', '§16', '§17', '§18', '§19'
  ];

  const seenSections = new Set();
  const invalidTargets = [];

  for (const entry of manifest.provenance) {
    assert.ok(entry.sourceSection, 'provenance entry must have sourceSection');
    assert.ok(!seenSections.has(entry.sourceSection), `duplicate provenance for source section ${entry.sourceSection}`);
    seenSections.add(entry.sourceSection);

    assert.ok(['kept', 'changed', 'dropped'].includes(entry.decision), `valid decision required for ${entry.sourceSection}`);
    assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0, `reason required for ${entry.sourceSection}`);

    if (entry.decision === 'kept' || entry.decision === 'changed') {
      const targetValid = (entry.section && validSectionIds.includes(entry.section)) ||
                          (entry.rule && (validSectionIds.includes(entry.rule) || validRuleIds.includes(entry.rule)));
      if (!targetValid) {
        invalidTargets.push({ sourceSection: entry.sourceSection, rule: entry.rule, section: entry.section });
      }
    }
  }

  assert.deepEqual(invalidTargets, [], `all kept/changed rules must point at a valid section or rule ID in craft-guide.md: ${JSON.stringify(invalidTargets)}`);
  for (const s of danSections) {
    assert.ok(seenSections.has(s), `dan source section ${s} must appear once in provenance`);
  }
});

test('check 7: vendor-free writer packets: instruction parts contain no forbidden vendor terms', { timeout: 20000 }, async () => {
  const manifest = JSON.parse(await readFile(resolve(kitDir, 'guidance-manifest.json'), 'utf8'));
  const studio = loadStudio();
  const allowlist = manifest.allowlist ?? [];

  const forbiddenPattern = /\b(?:pixar|seedance|gpt[- ]image|higgsfield|dankieft|renderman|octane|unreal engine|nano banana|ratatouille|toy story|inside out|incredibles)\b/i;

  const writerRoles = [
    'script-writer', 'cast-designer', 'sheet-prompter', 'background-product-owner',
    'pixar-prompter', 'shot-planner', 'composition-writer', 'motion-director',
    'video-prompt-engineer', 'sound-designer', 'film-editor', 'generation-planner',
    'voice-director'
  ];

  const violations = [];

  for (const role of writerRoles) {
    const agent = studio.config.agents[role];
    if (!agent) continue;

    // Check skill
    let skillContent = studio.documents[agent.skill]?.content ?? '';
    // Apply allowlist for this agent's skill
    for (const item of allowlist) {
      if (item.path.toLowerCase() === agent.skill.toLowerCase()) {
        skillContent = skillContent.replaceAll(new RegExp(item.term, 'gi'), '');
      }
    }

    const skillMatch = skillContent.match(forbiddenPattern);
    if (skillMatch) {
      violations.push({ role, file: agent.skill, match: skillMatch[0] });
    }

    // Check craft sections assigned to this writer
    const craftSections = studio.config.craft?.sections[role] ?? [];
    for (const sectionEntry of craftSections) {
      const docKey = `${studio.config.craft.path}#${sectionEntry}`;
      let content = studio.documents[docKey]?.content ?? '';
      const match = content.match(forbiddenPattern);
      if (match) {
        violations.push({ role, craft: sectionEntry, match: match[0] });
      }
    }
  }

  // Check recipes
  const recipes = ['background-prompter.md', 'character-sheet-recipe.md'];
  for (const r of recipes) {
    const content = studio.documents[r]?.content ?? (await readFile(resolve(kitDir, r), 'utf8'));
    const match = content.match(forbiddenPattern);
    if (match) {
      violations.push({ file: r, match: match[0] });
    }
  }

  // Check default bible style
  const style = defaultStyle(studio);
  if (style) {
    const styleStr = JSON.stringify(style);
    const match = styleStr.match(forbiddenPattern);
    if (match) {
      violations.push({ file: 'bible.defaultStyle', match: match[0] });
    }
  }

  assert.deepEqual(violations, [], `writer instruction parts must be vendor-free: ${JSON.stringify(violations)}`);
});

test('check 8: duplication ratchet: shared sentences across model docs must not exceed baseline', { timeout: 20000 }, async () => {
  const manifest = JSON.parse(await readFile(resolve(kitDir, 'guidance-manifest.json'), 'utf8'));
  const craftGuide = await readFile(resolve(kitDir, 'craft-guide.md'), 'utf8');
  const modelFiles = manifest.files.filter(f => f.audience === 'model');

  const docs = [];
  for (const file of modelFiles) {
    let content = '';
    if (file.path.startsWith('craft-guide.md#')) {
      const secId = file.path.split('#')[1];
      const match = craftGuide.match(new RegExp(`## \\[${secId}\\][\\s\\S]*?(?=(?:## \\[|$))`, 'm'));
      content = match ? match[0] : '';
    } else {
      try {
        content = await readFile(resolve(kitDir, file.path), 'utf8');
      } catch {}
    }
    if (content) docs.push({ path: file.path, content });
  }

  const sentenceMap = new Map();
  for (const doc of docs) {
    const sentences = doc.content
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 70);

    const seenInDoc = new Set(sentences);
    for (const s of seenInDoc) {
      if (!sentenceMap.has(s)) sentenceMap.set(s, new Set());
      sentenceMap.get(s).add(doc.path);
    }
  }

  let dupCount = 0;
  for (const [, docPaths] of sentenceMap.entries()) {
    if (docPaths.size >= 2) {
      dupCount++;
    }
  }

  assert.ok(
    dupCount <= manifest.duplicationBaseline,
    `duplication count ${dupCount} exceeds baseline ${manifest.duplicationBaseline}`
  );
});

test('sheet skin: no zoning in craft, Pia, Vera or golden; r4 build wording restored (Shaz 2026-10-13)', async () => {
  const read = (p) => readFile(resolve(kitDir, p), 'utf8');
  const craft = await read('craft-guide.md');
  assert.ok(!/C-SKIN-ZONING|skin zoning/i.test(craft), 'craft guide must not carry skin zoning');
  assert.match(craft, /\[C-SKIN-NATURAL\][^\n]*no added redness on nose, ears or cheeks; dark skin stays rich, never grey/);
  assert.ok(!/long torso|short legs|low centre of gravity/i.test(craft), 'child rider must not say long torso / short legs');
  assert.match(craft, /approximately five heads tall/);
  for (const p of ['crew/pia/SKILL.md', 'crew/vera/SKILL.md', 'evaluation/rubrics/visual.md']) {
    assert.ok(!/zoning|plum-red|red-orange/i.test(await read(p)), `${p} must not mention zoning`);
  }
  const vera = await read('crew/vera/SKILL.md');
  assert.match(vera, /A clown nose or heavy blush that isn't in the reference fails `likeness`/); // #67: reference is the source of truth
  assert.match(vera, /chunkier or bigger-headed than its heads-tall rule/);
  const golden = await read('evaluation/dept-evals/golden.json');
  assert.ok(!golden.includes('names-skin-zoning'));
  assert.ok(golden.includes('"id": "no-zoning-colour-words"'));
});
