import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hard safety: network calls prohibited
globalThis.fetch = () => { throw new Error('FETCH_PROHIBITED: Network calls are forbidden in guard tests.'); };
process.env.CODEX_TRACING = 'off';

// Hard safety: 60s unref file guard
const fileGuard = setTimeout(() => {
  console.error('GUARD_TIMEOUT: 60s file guard triggered in guidance-wiring.test.mjs');
  process.exit(1);
}, 60000);
fileGuard.unref();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const kitDir = resolve(__dirname, '..');
const repoRoot = resolve(kitDir, '../../..');

const { initialProject, taskFor } = await import('../runtime/workflow.mjs');
const { prepareCrewTask, buildWorkerPacket, crewRoles } = await import('../runtime/crew.mjs');
const { loadStudio } = await import('../runtime/instructions.mjs');
const { supervisedAudio, supervisedCharacters, supervisedBackgrounds, supervisedVideoReady, confirmed } = await import('./supervised-helpers.mjs');
const { videoPrompt, videoResult, soundPlan, editPlan } = await import('./studio-helpers.mjs');
const { author } = await import('./background-helpers.mjs');
const { inputs, answersLocked, authored, reviewed, approved, send, file } = await import('./helpers.mjs');

const crew = { workers: Object.keys(crewRoles).map(role => ({
  workerId: `host-${role}`,
  name: crewRoles[role].name,
  role,
  modelVersion: 'test-host',
  capabilityVersion: 'isolated-tools-v1',
  execution: 'host'
}))};

test('safety self-check: no forbidden process, network or host imports in source', { timeout: 20000 }, async () => {
  const source = await readFile(__filename, 'utf8');
  assert.ok(!/(?:import\s+.*from\s+['"](?:node:)?child_process['"]|require\(['"](?:node:)?child_process['"]\))/.test(source), 'must not import child_process');
  assert.ok(!/(?:import\s+.*from\s+['"](?:node:)?worker_threads['"]|require\(['"](?:node:)?worker_threads['"]\))/.test(source), 'must not import worker_threads');
  assert.ok(!/(?:import\s+.*from\s+['"].*codex-host\.mjs['"])/.test(source), 'must not import codex-host.mjs');
  assert.ok(!/(?:import\s+.*from\s+['"].*openrouter-host\.mjs['"])/.test(source), 'must not import openrouter-host.mjs');
  assert.ok(!/(?<!['"])\brunCrewTask\s*\(/.test(source), 'must not call runCrewTask');
  assert.ok(!/['"]codex\s+app-server['"]/.test(source), 'must not mention starting codex app-server');
});

test('check 1: packet-content load detection across rev 5 and rev 4 workflow states', { timeout: 20000 }, async () => {
  const manifest = JSON.parse(await readFile(resolve(kitDir, 'guidance-manifest.json'), 'utf8'));
  const studio = loadStudio();
  const packets = [];
  const readPaths = new Set();

  // Questionnaire is directly opened by runtime instructions / workflow
  readPaths.add('questionnaire.json');

  async function tryCapture(project, step, gate, params = {}) {
    const p = structuredClone(project);
    p.crew = crew;
    p.step = step;
    p.gate = gate;
    Object.assign(p, params);
    try {
      const task = taskFor(p);
      if (!task) return false;
      const prepared = await prepareCrewTask(p, task);
      const worker = p.crew.workers.find(w => w.role === task.formatRole);
      const packet = buildWorkerPacket(prepared, worker);
      packets.push(packet);
      return true;
    } catch (e) {
      if (e.message.includes('TASK_INPUT_MISSING') && ['review', 'owner-review'].includes(gate)) {
        const art = p.artifacts.findLast(a => a.kind === step && a.valid);
        if (art) {
          const draft = structuredClone(art);
          delete draft.approvedBy;
          delete draft.review;
          draft.id = `${art.key}@99`;
          p.artifacts.push(draft);
          try {
            const task2 = taskFor(p);
            const prepared2 = await prepareCrewTask(p, task2);
            const worker2 = p.crew.workers.find(w => w.role === task2.formatRole);
            const packet2 = buildWorkerPacket(prepared2, worker2);
            packets.push(packet2);
            return true;
          } catch {}
        }
      }
      return false;
    }
  }

  const baseVid = supervisedVideoReady();

  for (const rev of [5, 4]) {
    const v = structuredClone(baseVid);
    v.workflowRevision = rev;

    // 1. Script & Intake
    await tryCapture(v, 'answers', 'author');
    await tryCapture(v, 'answers', 'review');
    await tryCapture(v, 'script', 'author');
    await tryCapture(v, 'script', 'review');

    // 2. Audio
    await tryCapture(v, 'audition', 'produce');
    await tryCapture(v, 'narration', 'produce');
    await tryCapture(v, 'narration', 'author');

    // 3. Cast & Characters
    await tryCapture(v, 'roster', 'author');
    await tryCapture(v, 'roster', 'review');
    await tryCapture(v, 'characterPrompt', 'author', { characterId: 'alex' });
    await tryCapture(v, 'characterPrompt', 'review', { characterId: 'alex' });
    await tryCapture(v, 'candidates', 'produce', { characterId: 'alex' });
    await tryCapture(v, 'candidates', 'review', { characterId: 'alex' });
    await tryCapture(v, 'sheetPrompt', 'author', { characterId: 'alex' });
    await tryCapture(v, 'sheetPrompt', 'review', { characterId: 'alex' });
    await tryCapture(v, 'sheet', 'produce', { characterId: 'alex' });
    await tryCapture(v, 'sheet', 'review', { characterId: 'alex' });

    // 4. Backgrounds & Locations
    await tryCapture(v, 'backgrounds', 'author');
    await tryCapture(v, 'backgrounds', 'review');
    await tryCapture(v, 'backgroundBrief', 'author', { locationId: 'home' });
    await tryCapture(v, 'backgroundBrief', 'review', { locationId: 'home' });
    await tryCapture(v, 'backgroundPrompt', 'author', { locationId: 'home' });
    await tryCapture(v, 'backgroundPrompt', 'owner-review', { locationId: 'home' });
    await tryCapture(v, 'backgroundPrompt', 'review', { locationId: 'home' });
    await tryCapture(v, 'backgroundCandidates', 'produce', { locationId: 'home' });
    await tryCapture(v, 'backgroundCandidates', 'review', { locationId: 'home' });
    await tryCapture(v, 'backgroundAngleBrief', 'author', { locationId: 'home', angleId: 'reverse' });
    await tryCapture(v, 'backgroundAngleBrief', 'review', { locationId: 'home', angleId: 'reverse' });
    await tryCapture(v, 'backgroundAnglePrompt', 'author', { locationId: 'home', angleId: 'reverse' });
    await tryCapture(v, 'backgroundAnglePrompt', 'owner-review', { locationId: 'home', angleId: 'reverse' });
    await tryCapture(v, 'backgroundAnglePrompt', 'review', { locationId: 'home', angleId: 'reverse' });
    await tryCapture(v, 'backgroundAngle', 'produce', { locationId: 'home', angleId: 'reverse' });
    await tryCapture(v, 'backgroundAngle', 'review', { locationId: 'home', angleId: 'reverse' });

    // 5. Shots & Keyframes
    await tryCapture(v, 'shotIntentions', 'author');
    await tryCapture(v, 'shotIntentions', 'review');
    await tryCapture(v, 'shots', 'author');
    await tryCapture(v, 'shots', 'review');
    await tryCapture(v, 'keyframePrompt', 'author', { shotId: 'home-0-wide' });
    await tryCapture(v, 'keyframePrompt', 'review', { shotId: 'home-0-wide' });
    await tryCapture(v, 'keyframe', 'produce', { shotId: 'home-0-wide' });
    await tryCapture(v, 'keyframe', 'review', { shotId: 'home-0-wide' });

    // 6. Video Plan
    await tryCapture(v, 'videoPlan', 'author');
    await tryCapture(v, 'videoPlan', 'review');
  }

  // 7. VideoPrompt (Vin), SoundPlan (Finn), Music Review (Ava), EditPlan (Eli)
  let pWalk = structuredClone(baseVid);
  while (pWalk.step !== 'soundPlan') {
    const pWithCrew = structuredClone(pWalk);
    pWithCrew.crew = crew;
    const t = taskFor(pWithCrew);
    if (t) {
      const prep = await prepareCrewTask(pWithCrew, t);
      const worker = pWithCrew.crew.workers.find(w => w.role === t.formatRole);
      packets.push(buildWorkerPacket(prep, worker));
    }
    pWalk = approved(reviewed(author(pWalk, videoPrompt(pWalk), 'video-engineer')));
    const res = videoResult(pWalk);
    pWalk = send(pWalk, 'plan', { plan: { provider: 'replicate', operation: 'video', estimatedCostUsd: 0.05, parameters: { prompt: res.prompt } } });
    const j = pWalk.jobs.at(-1);
    pWalk = send(pWalk, 'authorize', { jobId: j.id, artifactDigest: j.digest, message: 'ISOLATED human exact spending authorization' });
    pWalk = send(pWalk, 'begin', { jobId: j.id, artifactDigest: j.digest });
    pWalk = send(pWalk, 'receipt', { jobId: j.id, artifactDigest: j.digest, result: res });
    pWalk = confirmed(reviewed(pWalk));
  }

  // Sound plan authoring -> Finn
  const pSound = structuredClone(pWalk);
  pSound.crew = crew;
  const tSound = taskFor(pSound);
  if (tSound) {
    const prep = await prepareCrewTask(pSound, tSound);
    const worker = pSound.crew.workers.find(w => w.role === tSound.formatRole);
    packets.push(buildWorkerPacket(prep, worker));
  }
  pWalk = approved(reviewed(author(pWalk, soundPlan, 'sound-designer')));

  // Music authoring & review -> Ava
  pWalk = author(pWalk, { files: [file(60, 60)], prompt: soundPlan.music.prompt, provenance: soundPlan.music.provenance }, 'composer');
  const pMusicRev = structuredClone(pWalk);
  pMusicRev.crew = crew;
  const tMusicRev = taskFor(pMusicRev);
  if (tMusicRev) {
    const prep = await prepareCrewTask(pMusicRev, tMusicRev);
    const worker = pMusicRev.crew.workers.find(w => w.role === tMusicRev.formatRole);
    packets.push(buildWorkerPacket(prep, worker));
  }
  pWalk = confirmed(reviewed(pWalk));
  pWalk = confirmed(reviewed(author(pWalk, { files: [file(61, 1)], prompt: soundPlan.effects[0].prompt, provenance: soundPlan.effects[0].provenance }, 'sound-designer')));

  // Edit plan authoring -> Eli
  const pEdit = structuredClone(pWalk);
  pEdit.crew = crew;
  const tEdit = taskFor(pEdit);
  if (tEdit) {
    const prep = await prepareCrewTask(pEdit, tEdit);
    const worker = pEdit.crew.workers.find(w => w.role === tEdit.formatRole);
    packets.push(buildWorkerPacket(prep, worker));
  }

  assert.ok(packets.length >= 60, `expected at least 60 packets, got ${packets.length}`);

  // Validate manifest coverage
  const modelFiles = manifest.files.filter(f => f.audience === 'model');
  const unreached = [];

  for (const entry of modelFiles) {
    if (readPaths.has(entry.path)) continue;

    let content = '';
    if (entry.path.startsWith('craft-guide.md#')) {
      content = studio.documents[entry.path]?.content;
    } else {
      content = await readFile(resolve(kitDir, entry.path), 'utf8');
    }
    assert.ok(content, `content must exist for ${entry.path}`);

    const chunk = content.slice(0, 200);
    const sha = studio.documents[entry.path]?.sha256;
    const isReached = packets.some(pkt => pkt.includes(chunk) || (sha && pkt.includes(sha)));

    if (!isReached) {
      unreached.push(entry.path);
    }
  }

  assert.deepEqual(unreached, [], `all audience: model entries must be reached in packets: ${unreached.join(', ')}`);

  // Validate legacy entries removeBy dates
  const legacyEntries = manifest.files.filter(f => f.status === 'legacy' || f.audience === 'legacy');
  const now = new Date();
  for (const entry of legacyEntries) {
    assert.ok(entry.removeBy, `legacy entry ${entry.path} must specify removeBy`);
    const removeDate = new Date(entry.removeBy);
    assert.ok(now <= removeDate, `legacy entry ${entry.path} is past removeBy ${entry.removeBy}`);
  }
});

test('check 2: missing paths referenced in model and operator documents', { timeout: 20000 }, async () => {
  const manifest = JSON.parse(await readFile(resolve(kitDir, 'guidance-manifest.json'), 'utf8'));
  const targetDocs = manifest.files.filter(f => ['model', 'operator'].includes(f.audience));
  const missing = [];

  const ignoreList = new Set([
    'state.json', 'progress.json', 'finalized.json', 'quota.json',
    'dataset.json/predictions.json/report.json'
  ]);

  for (const doc of targetDocs) {
    let content = '';
    if (doc.path.startsWith('craft-guide.md#')) {
      continue;
    }
    content = await readFile(resolve(kitDir, doc.path), 'utf8');

    const matches = content.matchAll(/\b([\w./-]+\.(?:md|json|mjs))\b/g);
    for (const match of matches) {
      const raw = match[1];
      if (raw.startsWith('/absolute/') || raw.startsWith('absolute/') || raw.startsWith('http:') || raw.startsWith('https:') || raw.includes('<') || raw.includes('>')) continue;
      if (ignoreList.has(raw) || raw.startsWith('host-workspace/')) continue;

      const existsInKit = existsSync(resolve(kitDir, raw));
      const existsInRepo = existsSync(resolve(repoRoot, raw));
      const existsInRubrics = existsSync(resolve(kitDir, 'evaluation/rubrics', raw));
      const existsInCrew = existsSync(resolve(kitDir, 'crew', raw));

      if (!existsInKit && !existsInRepo && !existsInRubrics && !existsInCrew) {
        missing.push({ doc: doc.path, referenced: raw });
      }
    }
  }

  assert.deepEqual(missing, [], `found missing referenced paths: ${JSON.stringify(missing)}`);
});

test('check 3: example hashes in skills use valid placeholders or match actual recipe hashes', { timeout: 20000 }, async () => {
  const manifest = JSON.parse(await readFile(resolve(kitDir, 'guidance-manifest.json'), 'utf8'));
  const skills = manifest.files.filter(f => f.kind === 'skill' && f.path.startsWith('crew/'));
  const badHashes = [];

  for (const skill of skills) {
    const content = await readFile(resolve(kitDir, skill.path), 'utf8');
    const matches = content.matchAll(/(?:recipeSha256|recipe\.sha256)[^a-zA-Z0-9_-]*([a-zA-Z0-9_<>.-]+)/gi);
    for (const match of matches) {
      const val = match[1].trim();
      if (/^<.*>$/.test(val)) continue; // placeholder pattern <...>
      if (/^[0-9a-f]{64}$/i.test(val)) {
        // Must be repeating digits or empty-string hash or match real file
        const isRepeating = /^([0-9a-f])\1{63}$/i.test(val);
        const isEmptySha = val === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
        if (!isRepeating && !isEmptySha) {
          badHashes.push({ skill: skill.path, hash: val });
        }
      }
    }
  }

  assert.deepEqual(badHashes, [], `skills must not copy stale example hashes: ${JSON.stringify(badHashes)}`);
});

test('check 4: reviewer and partner names in skills match authoritative roles', { timeout: 20000 }, async () => {
  const beauSkill = await readFile(resolve(kitDir, 'crew/beau/SKILL.md'), 'utf8');
  const camSkill = await readFile(resolve(kitDir, 'crew/cam/SKILL.md'), 'utf8');
  const piaSkill = await readFile(resolve(kitDir, 'crew/pia/SKILL.md'), 'utf8');
  const theoSkill = await readFile(resolve(kitDir, 'crew/theo/SKILL.md'), 'utf8');
  const eliSkill = await readFile(resolve(kitDir, 'crew/eli/SKILL.md'), 'utf8');

  // Beau: prompts are authored by Theo, not Pia
  assert.ok(beauSkill.includes('Theo'), 'Beau must name Theo');
  assert.ok(!/Pia.*(?:prompt|background)/i.test(beauSkill), 'Beau must not name Pia for background prompts');

  // Cam: reviewer is June, not Vera
  assert.ok(camSkill.includes('June'), 'Cam must name June');
  assert.ok(!/Vera.*(?:reviews?|reviewer)/i.test(camSkill), 'Cam must not name Vera as scene reviewer');

  // Pia & Theo: Vera reviews images, Sage reviews prompts
  assert.ok(!/Vera\s+(?:reviews?|rejects?)\s+(?:your\s+)?prompt/i.test(piaSkill), 'Pia must not say Vera reviews/rejects prompts');
  assert.ok(!/Vera\s+(?:reviews?|rejects?)\s+(?:your\s+)?prompt/i.test(theoSkill), 'Theo must not say Vera reviews/rejects prompts');

  // Eli: gate is author
  assert.ok(eliSkill.includes('author'), 'Eli skill must name author gate');
});
