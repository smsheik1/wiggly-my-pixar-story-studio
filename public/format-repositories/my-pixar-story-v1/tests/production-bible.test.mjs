// Frozen production bible (Oct 11 2026): one locked brief (script, cast, style, scene
// digest) the human signs ONCE; every crew packet carries its role slice; reviewers check
// against it; Sage may quote it; agents can never sign; signed versions are frozen.
// Invented fixtures only. No network, no providers, no real codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEvent, taskFor, current } from '../runtime/workflow.mjs';
import { digest } from '../runtime/contracts.mjs';
import { verifyReviewQuotes } from '../runtime/crew.mjs';
import { biblePacket, bibleSummary, bibleWaiting, staleAgainstBible, renderBibleMarkdown, parseBible, compileBible, BIBLE_SLICES, BIBLE_SCHEMA } from '../runtime/bible.mjs';
import { supervisedCharacters } from './supervised-helpers.mjs';
import { registry } from './background-helpers.mjs';
import { shotPlan } from './shot-helpers.mjs';

const kit = join(dirname(fileURLToPath(import.meta.url)), '..');
const T = { timeout: 20000 };
let base;
// A supervised project whose cast is locked and whose next department (shotIntentions)
// is after the script/cast stage.
function atShotIntentions(policy = 'required') {
  base ??= supervisedCharacters();
  assert.equal(base.step, 'shotIntentions');
  const p = structuredClone(base);
  if (policy) p.bible = { policy, versions: [] };
  return p;
}
const H = content => parseBible(content).hash;
const ev = (p, action, actor, extra = {}) => applyEvent(p, { taskId: taskFor(p).taskId, action, actor, ...extra });
const draft = (p, content, message = 'ISOLATED operator drafts the bible') => ev(p, 'bible-draft', 'human', { message, ...(content ? { content } : {}) });
const sign = (p, hash, by = 'isolated-human') => ev(p, 'bible-sign', 'human', { artifactDigest: hash, content: { by }, message: 'ISOLATED human signs at a terminal' });
function complete(p, tweak = {}) {
  const script = current(p, 'script'), sheet = current(p, 'sheet:alex');
  return {
    schema: BIBLE_SCHEMA, title: 'Invented production bible', logline: 'An invented parent tells Mia how a bicycle taught patience.',
    script: { source: { artifactId: script.id, digest: script.digest }, lockedPointer: `${script.id} in this run`, beats: script.content.beats.map(b => ({ beat: b.beat, narration: b.narration })), notes: [] },
    cast: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', minor: false, storyPurpose: 'The invented parent.', sheet: { artifactId: sheet.id, digest: sheet.digest, selection: 0, pick: 'ISOLATED pick' },
      lockedDescription: 'Invented adult in a green work apron.', continuity: ['Alex always wears the green work apron with a brass bell pin.'], referencePhoto: { status: 'reference-photo', note: 'Invented fixture photo.' } }],
    style: { look: 'Pixar-style 3D animated feature film.', sets: 'Lived-in, story-dressed sets; never empty generic rooms.', rules: ['No text anywhere in images.'] },
    scenes: [{ id: 'home-0', beat: 1, location: 'home', locationId: 'home', characterIds: ['alex'], timeOfDay: 'late afternoon', mood: 'warm, patient', keyProps: ['a red bicycle with a loose bell'], setDressing: ['tools hung on a pegboard'] }],
    openQuestions: [], ...tweak,
  };
}

test('1. bible-draft compiles a draft v1 from the locked script, roster and sheet picks, with a content hash', T, () => {
  const p = draft(atShotIntentions());
  const v = p.bible.versions[0];
  assert.equal(v.version, 1); assert.equal(v.state, 'draft'); assert.equal(v.hash, digest(v.content));
  assert.equal(v.content.script.source.artifactId, current(p, 'script').id);
  assert.equal(v.content.cast[0].sheet.artifactId, current(p, 'sheet:alex').id);
  assert.ok(parseBible(v.content).unresolved.length > 0, 'creative summaries are left UNRESOLVED, never invented');
  assert.equal(p.step, 'shotIntentions');
});

test('2. agents and reviewers can never draft over or sign the bible', T, () => {
  const p = draft(atShotIntentions(), complete(atShotIntentions()));
  for (const actor of ['agent', 'reviewer', 'runtime']) {
    assert.throws(() => ev(p, 'bible-sign', actor, { artifactDigest: p.bible.versions[0].hash, content: { by: 'shaz' }, message: 'agent tries' }), /human authority/);
    assert.throws(() => ev(p, 'bible-draft', actor, { message: 'agent tries', content: complete(p) }), /human authority/);
  }
});

test('3. required policy: departments after the cast stage wait (no agent work accepted) until a signed bible exists', T, () => {
  const p = atShotIntentions('required');
  assert.equal(bibleWaiting(p), true);
  const packet = taskFor(p).productionBible;
  assert.equal(packet.status, 'unsigned'); assert.equal(packet.blocking, true); assert.match(packet.warning, /NO SIGNED PRODUCTION BIBLE/);
  assert.throws(() => ev(p, 'artifact', 'agent', { workerId: 'shot-planner', content: { ...registry, ...shotPlan } }), /BIBLE_NOT_SIGNED/);
  const signed = sign(draft(p, complete(p)), H(complete(p)));
  assert.equal(bibleWaiting(signed), false);
  const next = ev(signed, 'artifact', 'agent', { workerId: 'shot-planner', content: { ...registry, ...shotPlan } });
  assert.deepEqual(current(next, 'shotIntentions').bible, { version: 1, hash: H(complete(p)) });
});

test('4. advisory policy runs with a loud warning instead of waiting', T, () => {
  const p = atShotIntentions('advisory');
  const packet = taskFor(p).productionBible;
  assert.equal(packet.blocking, false); assert.match(packet.warning, /NO SIGNED PRODUCTION BIBLE/);
  const next = ev(p, 'artifact', 'agent', { workerId: 'shot-planner', content: { ...registry, ...shotPlan } });
  assert.equal(current(next, 'shotIntentions').bible, undefined);
  assert.match(bibleSummary(next).message ?? '', /WARNING|no signed/i);
});

test('5. signing binds the exact reviewed hash and refuses open questions, unresolved fields and unlocked sources', T, () => {
  const p = atShotIntentions();
  assert.throws(() => sign(draft(p), 'f'.repeat(64)), /BIBLE_HASH_MISMATCH/);
  const compiled = draft(p);
  assert.throws(() => sign(compiled, compiled.bible.versions[0].hash), /BIBLE_UNRESOLVED/);
  const asked = draft(p, complete(p, { openQuestions: ['Which wrist is the watch on?'] }));
  assert.throws(() => sign(asked, asked.bible.versions[0].hash), /BIBLE_OPEN_QUESTIONS/);
  const bad = complete(p); bad.cast[0].sheet.artifactId = 'sheet:alex@99';
  assert.throws(() => draft(p, bad), /BIBLE_SOURCE_INVALID/);
  const ok = sign(draft(p, complete(p)), H(complete(p)), 'shaz');
  assert.equal(ok.bible.versions[0].state, 'signed'); assert.equal(ok.bible.versions[0].signature.by, 'shaz');
  assert.throws(() => sign(draft(p, complete(p)), H(complete(p)), '  '), /BIBLE_SIGNER_REQUIRED/);
});

test('6. a signed version is frozen: changes make a new draft that is not in force until signed again', T, () => {
  const p = atShotIntentions();
  let s = sign(draft(p, complete(p)), H(complete(p)));
  assert.throws(() => sign(s, H(complete(p))), /BIBLE_ALREADY_SIGNED/);
  assert.throws(() => draft(s, complete(p)), /BIBLE_UNCHANGED/);
  const changed = complete(p, { logline: 'A revised invented logline.' });
  s = draft(s, changed);
  assert.deepEqual(s.bible.versions.map(v => [v.version, v.state]), [[1, 'signed'], [2, 'draft']]);
  assert.equal(s.bible.versions[0].content.logline, complete(p).logline, 'signed content never mutates');
  const packet = taskFor(s).productionBible;
  assert.equal(packet.version, 1); assert.match(packet.note, /Draft v2 is unsigned/);
  assert.equal(sign(s, H(changed)).bible.versions[1].state, 'signed');
});

test('7. every role gets its slice; reviewers get the check-against-bible instruction', T, () => {
  const p = sign(draft(atShotIntentions(), complete(atShotIntentions())), H(complete(atShotIntentions())));
  for (const [role, keys] of Object.entries(BIBLE_SLICES)) {
    const slice = biblePacket(p, role, 'author', null);
    assert.deepEqual(Object.keys(slice.sections), keys, role);
    assert.equal(slice.status, 'signed'); assert.equal(slice.version, 1);
  }
  for (const role of ['visual-reviewer', 'scene-reviewer', 'text-reviewer']) assert.match(biblePacket(p, role, 'review', null).instruction, /Check the deliverable against this SIGNED production bible/);
  assert.ok(!('script' in biblePacket(p, 'visual-reviewer', 'review', null).sections));
  assert.match(biblePacket(p, 'shot-planner', 'author', null).instruction, /Follow it exactly/);
  assert.deepEqual(taskFor(p).productionBible.sections.cast, complete(atShotIntentions()).cast);
});

test('8. work made before signing, or against an older signed version, is flagged stale', T, () => {
  const p = atShotIntentions('advisory');
  let s = ev(p, 'artifact', 'agent', { workerId: 'shot-planner', content: { ...registry, ...shotPlan } });
  s = sign(draft(s, complete(atShotIntentions())), H(complete(atShotIntentions())));
  assert.deepEqual(staleAgainstBible(s).map(x => x.artifactId), [current(s, 'shotIntentions').id]);
  assert.match(staleAgainstBible(s)[0].reason, /before any signed bible/);
  const packet = taskFor(s).productionBible;
  assert.match(packet.staleWarning, /without a signed bible/);
  const v2 = complete(atShotIntentions(), { logline: 'Second invented logline.' });
  s = sign(draft(s, v2), H(v2));
  assert.equal(bibleSummary(s).signed.version, 2);
  assert.equal(staleAgainstBible(s).length, 1);
});

test('9. Sage evidence: quoting the SIGNED bible is valid; an unsigned draft never counts', T, () => {
  const p = sign(draft(atShotIntentions(), complete(atShotIntentions())), H(complete(atShotIntentions())));
  const task = { artifact: { content: { prompt: 'unrelated' } }, dependencies: [], productionBible: biblePacket(p, 'text-reviewer', 'review', null) };
  const review = { decision: 'rejected', checks: [{ criterion: 'continuity', status: 'fail', quotes: ['always wears the green work apron with a brass bell pin'] }] };
  assert.doesNotThrow(() => verifyReviewQuotes({ role: 'text-reviewer', task, review, outputs: new Map() }));
  const unsigned = { ...task, productionBible: { status: 'unsigned', sections: task.productionBible.sections } };
  assert.throws(() => verifyReviewQuotes({ role: 'text-reviewer', task: unsigned, review, outputs: new Map() }), /REVIEW_QUOTE_NOT_FOUND/);
});

test('10. historical projects without a bible keep byte-identical packets', T, () => {
  const p = atShotIntentions(null);
  assert.equal('productionBible' in taskFor(p), false);
  assert.equal(bibleSummary(p), null);
  const next = ev(p, 'artifact', 'agent', { workerId: 'shot-planner', content: { ...registry, ...shotPlan } });
  assert.equal('bible' in current(next, 'shotIntentions'), false);
});

test('11. markdown render: unsigned banner, questions at the top, the human sign command; signed banner', T, () => {
  const p = atShotIntentions();
  const asked = draft(p, complete(p, { openQuestions: ['Which wrist is the watch on?'] }));
  const md = renderBibleMarkdown(asked.bible.versions[0], { runDir: '/runs/x' });
  assert.match(md, /UNSIGNED DRAFT v1\. NOT IN FORCE/);
  assert.ok(md.indexOf('Which wrist') < md.indexOf('## Logline'));
  assert.match(md, /Not signable yet/); assert.doesNotMatch(md, /bible-sign --run/);
  const ready = draft(p, complete(p));
  assert.match(renderBibleMarkdown(ready.bible.versions[0], { runDir: '/runs/x' }), /bible-sign --run \/runs\/x --by <your name> --hash [0-9a-f]{12}/);
  const s = sign(ready, H(complete(p)), 'shaz');
  assert.match(renderBibleMarkdown(s.bible.versions[0]), /\*\*SIGNED\*\* v1 by shaz/);
  assert.throws(() => parseBible(complete(p, { scenes: [{ ...complete(p).scenes[0], characterIds: ['nobody'] }] })), /unknown cast member/);
  assert.ok(compileBible(p).cast.length >= 1);
});

test('12. runner: new runs require a bible; respond cannot carry bible events; bible-sign refuses non-interactive callers', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bible-runner-'));
  try {
    const run = join(dir, 'run'), node = (...a) => spawnSync(process.execPath, ['runner.mjs', ...a], { cwd: kit, encoding: 'utf8', timeout: 30000, input: '' });
    const init = node('init', 'examples/parent.json', '--run', run);
    assert.equal(init.status, 0, init.stderr);
    assert.equal(JSON.parse(init.stdout).productionBible.policy, 'required');
    const status = JSON.parse(node('status', '--run', run).stdout);
    const ev = join(dir, 'sign.json');
    await writeFile(ev, JSON.stringify({ taskId: status.pending.taskId, action: 'bible-sign', actor: 'human', artifactDigest: 'x', content: { by: 'agent' }, message: 'agent forging a signature' }));
    const forged = node('respond', ev, '--run', run);
    assert.notEqual(forged.status, 0); assert.match(forged.stderr, /BIBLE_COMMAND_REQUIRED/);
    const piped = node('bible-sign', '--run', run, '--by', 'shaz', '--hash', 'a'.repeat(12));
    assert.notEqual(piped.status, 0); assert.match(piped.stderr, /BIBLE_SIGN_NEEDS_HUMAN_TERMINAL/);
    const file = join(dir, 'bible.json');
    await writeFile(file, JSON.stringify({ ...complete(atShotIntentions()), openQuestions: ['Q?'] }));
    const v = node('bible-validate', '--file', file);
    assert.equal(v.status, 0, v.stderr); assert.equal(JSON.parse(v.stdout).signable, false);
    const r = node('bible-render', '--file', file);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /UNSIGNED DRAFT\. NOT IN FORCE/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
