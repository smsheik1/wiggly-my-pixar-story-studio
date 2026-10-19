// Story Director review step as an editor with a rubric (crew/story-director/REVIEW.md, critique call only), verdict
// parsing + early stop on SHIP, fix-only rewrites, and the cheap craft checks (verbatim share, cast never seen, props
// not in the answers). Scripted models and fixtures only: zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { deepAgentInvoke, REFLECTION, critiqueMessages, revisionMessage, parseVerdict, hasRubricFail, countFixes, shipsAsIs } from '../graph/deep-agent-node.mjs';
import { loadReview, loadSkill } from '../config/models.mjs';
import { validateStoryDirectorOutput } from '../crew/linter/check-stage-play.mjs';
import { checkPropsTraceable, objectNoun } from '../crew/linter/craft-checks.mjs';
import { runPatch } from '../scripts/patch.mjs';

class ScriptedModel extends BaseChatModel {
  constructor(script) { super({}); this.modelName = 'isolated-scripted-model'; this.script = script; this.calls = []; }
  getName() { return 'ChatOpenAI'; }
  _llmType() { return 'isolated-scripted-test'; }
  bindTools() { return this; }
  async _generate(messages) { this.calls.push(messages); const step = this.script.shift(); assert.ok(step, 'model called after expected termination'); return { generations: [{ text: '', message: step(messages) }] }; }
}
const call = (name, args) => new AIMessage({ content: '', tool_calls: [{ name, args, id: name + Math.random().toString(36).slice(2, 7), type: 'tool_call' }] });
const say = (t) => new AIMessage(t);
const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const text = (msgs) => msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
const SUBMIT = 'submit_story_director';
const titled = (t) => { const d = json('good-stage-play.json'); d.masthead.title = t; return d; };
async function tmp(run) { const d = await mkdtemp(join(tmpdir(), 'wiggly-v2-review-')); try { await run(d); } finally { await rm(d, { recursive: true, force: true }); } }
const INPUT = { subject: 'Test family', targetTotalRuntimeSec: 90, answers: { finale: 'I want her to know she can always call me.' } };
const SHIP = 'R1 Fidelity: PASS\nR2 Invented details: PASS\nR6 Finale: PASS\n\nFIXES:\n(none)\n\nWorks: the ending.\nVERDICT: SHIP';
const REVISE = 'R1 Fidelity: FAIL\n- 1.2 "x" → original: "y"\n\nFIXES:\n1. 1.2: restore the whole sentence.\n2. cut 2.3.\n\nWorks: the ending.\nVERDICT: REVISE';
const ANSWERS = json('good-answers.json');

// ---- the rubric ----
test('rubric: REVIEW.md lives with the Story Director, covers R1-R9, ends on VERDICT; other agents have none', () => {
  const r = loadReview('story-director');
  for (const k of ['R1 Fidelity', 'R2 Invented details', 'R3 Setup and payoff', 'R4 Cast in the scene', 'R5 Referents', 'R6 Finale', 'R7 Time framing', 'R8 Length', 'R9 Gate rules']) assert.match(r, new RegExp(k), k);
  assert.match(r, /editor/); assert.match(r, /never rewrite|do not rewrite/i); assert.match(r, /PASS or FAIL/); assert.match(r, /at most 8 fixes/i); assert.match(r, /VERDICT: SHIP\|REVISE/);
  assert.match(r, /FIXES:/); assert.match(r, /applies only\s+the fixes you list/); assert.match(r, /never adding/); assert.match(r, /targetTotalRuntimeSec/); assert.match(r, /big to small/); assert.match(r, /as a viewer/);
  for (const a of ['character-architect', 'location-scout', 'seedance-compiler']) assert.equal(loadReview(a), null, a);
  assert.ok(!/R1 Fidelity/.test(loadSkill('story-director')), 'the rubric is not part of the writer\'s skill');
  assert.match(loadSkill('story-director'), /Draft to the review checklist/, 'the writer\'s rules aim the first draft at the same checks');
});

test('critique with the rubric: editor framing, rubric, rules for reference, gate warnings, runtime vs target', () => {
  const draft = titled('Draft zero'); draft.shapeBar.totalRuntimeSec = 96;
  const [sys, user] = critiqueMessages({ agent: 'story-director', skill: 'WRITING RULES', review: loadReview('story-director'), input: INPUT, draft, round: 1, rounds: 2, firstRuntime: 88,
    gateIssues: [{ severity: 'warning', code: 'PROP_NOT_IN_ANSWERS', message: '"blanket" is not in the answers' }, { severity: 'error', code: 'PRESENT_NEVER_SEEN', message: 'Gran never seen', path: 'segments.0.scenes.1' }] });
  assert.match(sys.content, /reviewing your own draft/); assert.match(sys.content, /editor, not the writer/); assert.match(sys.content, /R4 Cast in the scene/); assert.match(sys.content, /WRITING RULES/);
  assert.match(user.content, /PRESENT_NEVER_SEEN \(segments\.0\.scenes\.1\)/); assert.match(user.content, /Gate warnings[\s\S]*blanket/);
  assert.match(user.content, /Runtime: this draft 96s; target 90s; first draft 88s/); assert.match(user.content, /R1 to R9/); assert.match(user.content, /VERDICT: REVISE or VERDICT: SHIP\.$/);
  const plain = critiqueMessages({ agent: 'location-scout', skill: 'r', input: {}, draft: {}, round: 1, rounds: 1 });
  assert.ok(!/R1 to R9|editor, not the writer/.test(text(plain)), 'no rubric: the generic focus list as before'); assert.match(text(plain), /Faithfulness/);
});

test('verdict parsing: last VERDICT wins, rubric FAIL lines and the fix count are read', () => {
  assert.equal(parseVerdict(REVISE), 'REVISE'); assert.equal(parseVerdict(SHIP), 'SHIP'); assert.equal(parseVerdict('VERDICT: SHIP\nlater...\n**VERDICT:** **REVISE**'), 'REVISE');
  assert.equal(parseVerdict('no verdict'), null);
  assert.equal(hasRubricFail(REVISE), true); assert.equal(hasRubricFail(SHIP), false); assert.equal(hasRubricFail('**R6 Finale:** FAIL'), true);
  assert.equal(countFixes(REVISE), 2); assert.equal(countFixes(SHIP), 0);
  assert.equal(shipsAsIs(SHIP), true); assert.equal(shipsAsIs(REVISE), false);
  assert.equal(shipsAsIs(SHIP, [{ severity: 'error', code: 'X' }]), false, 'a gate error always gets a rewrite');
  assert.equal(shipsAsIs(SHIP, [{ severity: 'warning', code: 'X' }]), true);
  assert.equal(shipsAsIs('R4 Cast in the scene: FAIL\nVERDICT: SHIP'), false, 'SHIP with a FAIL item is not trusted');
});

test('rewrite message: apply only the listed fixes, change nothing else, no runtime growth', () => {
  const m = revisionMessage({ agent: 'story-director', draft: { a: 1 }, critique: REVISE, round: 1, rounds: 2 });
  assert.match(m, /Apply only the fixes your critique lists/); assert.match(m, /Change nothing else/); assert.match(m, /Do not make the output longer[\s\S]*totalRuntimeSec/); assert.match(m, /cut 2\.3/);
});

// ---- early stop ----
test('early stop: SHIP on a gate-clean draft skips the rewrite and every later round', () => tmp(async (runs) => {
  const seen = {};
  const m = new ScriptedModel([
    () => call(SUBMIT, titled('Draft zero')),
    (msgs) => { seen.c1 = text(msgs); return say(SHIP); },
  ]);
  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'ship' })({ agent: 'story-director', config: { model: 'isolated-scripted-model', reflectionRounds: 2 }, input: INPUT, attempt: 1, gate: () => ({ issues: [] }) });
  assert.equal(m.calls.length, 2, 'draft + one critique, no rewrite, no round 2');
  assert.equal(out.masthead.title, 'Draft zero');
  assert.match(seen.c1, /R1 Fidelity[\s\S]*R9 Gate rules/, 'the critique call gets the rubric');
  const r = out[REFLECTION];
  assert.equal(r.rounds, 2); assert.equal(r.roundsRun, 1); assert.equal(r.stoppedEarly, true);
  assert.equal(r.log[0].verdict, 'SHIP'); assert.equal(r.log[0].stoppedEarly, true); assert.equal(r.log[0].changed, false);
  const dir = join(runs, 'ship_attempt-1', 'story-director', 'reflection');
  assert.ok(!existsSync(join(dir, 'draft-1.json')));
  const saved = JSON.parse(await readFile(join(dir, 'reflection.json'), 'utf8'));
  assert.equal(saved.stoppedEarly, true); assert.equal(saved.roundsRun, 1); assert.equal(saved.rubric, true);
}));

test('no early stop when the gate fails or the critic says REVISE; the rewrite never sees the rubric', () => tmp(async (runs) => {
  const seen = {};
  const m = new ScriptedModel([
    () => call(SUBMIT, titled('Draft zero')),
    () => say(SHIP), // SHIP, but the gate has an error: the rewrite still runs
    (msgs) => { seen.r1 = text(msgs); return call(SUBMIT, titled('Revision one')); },
    () => say(REVISE),
    (msgs) => { seen.r2 = text(msgs); return call(SUBMIT, titled('Revision two')); },
  ]);
  const gate = (o) => ({ issues: o.masthead.title === 'Draft zero' ? [{ severity: 'error', code: 'PRESENT_NEVER_SEEN', message: 'never seen', path: 'segments.0.scenes.0' }] : [] });
  const out = await deepAgentInvoke({ createModel: async () => m, runsRoot: runs, runId: 'rev' })({ agent: 'story-director', config: { model: 'isolated-scripted-model', reflectionRounds: 2 }, input: INPUT, attempt: 1, gate });
  assert.equal(m.calls.length, 5); assert.equal(out.masthead.title, 'Revision two');
  const r = out[REFLECTION];
  assert.equal(r.stoppedEarly, false); assert.deepEqual(r.log.map((e) => e.verdict), ['SHIP', 'REVISE']); assert.equal(r.log[1].fixes, 2);
  assert.ok(r.log.every((e) => e.runtimeBefore === 30 || Number.isFinite(e.runtimeBefore)));
  for (const s of [seen.r1, seen.r2]) { assert.ok(!/R9 Gate rules|R4 Cast in the scene/.test(s), 'rubric only in the critique call'); assert.match(s, /Apply only the fixes/); }
}));

// ---- craft checks ----

test('cast listed in a scene but never seen or heard is an error; on screen, voice-over or narration clears it', () => {
  const gate = (fn) => { const d = json('good-stage-play.json'); fn(d); return validateStoryDirectorOutput(d, ANSWERS).issues.filter((i) => i.code === 'PRESENT_NEVER_SEEN'); };
  assert.deepEqual(gate(() => {}), []);
  const never = (d) => { const s = d.segments[1].shots; for (const sh of s) { sh.onScreen = sh.onScreen.filter((t) => t !== '@Sister'); sh.whatWeSee = sh.whatWeSee.replaceAll('@Sister', 'someone'); } };
  const e = gate(never); assert.equal(e.length, 1); assert.equal(e[0].severity, 'error'); assert.match(e[0].message, /@Sister[\s\S]*voice-over/);
  // heard only: a voice-over line, or narration, from them in that scene
  assert.deepEqual(gate((d) => { never(d); const sh = d.segments[1].shots[0]; sh.narration = { ...sh.narration, speaker: '@Sister' }; }).length, 0);
});

test('props not in the answers: invented objects warn once per object; answer objects and set dressing do not', () => {
  assert.equal(objectNoun('a soft blanket draped over @Theo\'s shoulders'), 'blanket');
  assert.equal(objectNoun('a pair of sunglasses pushed up'), 'sunglasses'); assert.equal(objectNoun('a short stack of playing cards face up'), 'cards');
  assert.equal(objectNoun('the laptop open on the desk'), 'laptop'); assert.equal(objectNoun('the cursor blinking'), 'cursor');
  const d = json('good-stage-play.json');
  d.segments[1].scenes[0].props = ['a soft blanket over @Sister\'s knees', 'sunglasses pushed up on @Shaz\'s head', 'the couch by the window'];
  d.segments[1].shots[0].whatWeSee += ' A blanket slips. The laptop glows on the table.';
  const w = checkPropsTraceable(d, ANSWERS);
  const nouns = w.map((i) => /"([^"]+)"/.exec(i.message)[1]);
  assert.ok(nouns.includes('blanket') && nouns.includes('laptop'), nouns.join(','));
  assert.equal(nouns.filter((n) => n === 'blanket').length, 1, 'one warning per object, listing every place');
  assert.ok(!nouns.includes('sunglasses') && !nouns.includes('couch') && !nouns.includes('window') && !nouns.includes('table'));
  assert.ok(w.every((i) => i.severity === 'warning' && i.code === 'PROP_NOT_IN_ANSWERS'));
  assert.deepEqual(checkPropsTraceable(d, { answers: {} }), []);
});

// ---- patch mode can repair a gate error inside its target ----
test('patch: a prior with gate errors only inside the target part is patchable; elsewhere it is refused', () => tmp(async (root) => {
  const out = join(root, 'prior', 'outputs'); await mkdir(out, { recursive: true });
  const FIX = { 'story-director': 'good-stage-play.json', 'character-architect': 'good-master-renders.json', 'location-scout': 'good-location-plates.json', 'seedance-compiler': 'good-seedance-prompts.json' };
  for (const [a, f] of Object.entries(FIX)) await writeFile(join(out, `${a}.json`), JSON.stringify(json(f)));
  const sd = json(FIX['story-director']); sd.segments[0].scenes[0].present.push('@Mom'); // never seen in part 1? (Mom is in part 1) -> use part 2
  sd.segments[0].scenes[0].present = sd.segments[0].scenes[0].present.filter((t, i, a) => a.indexOf(t) === i);
  sd.segments[1].scenes[0].present.push('@Mom'); // listed in part 2 scene 1, never seen there
  await writeFile(join(out, 'story-director.json'), JSON.stringify(sd));
  await writeFile(join(out, 'state.json'), JSON.stringify({ status: 'done', approvedAssets: json('good-approved-assets.json') }));
  await writeFile(join(root, 'prior', 'project.json'), JSON.stringify({ inputs: { subject: ANSWERS.subject, answers: ANSWERS.answers } }));
  const logs = [];
  const ok = await runPatch({ from: 'prior', target: 'part:2', runsRoot: root, check: true, log: (l) => logs.push(l) });
  assert.deepEqual(ok.priorErrors, ['PRESENT_NEVER_SEEN']); assert.ok(logs.some((l) => /must fix it/.test(l)));
  await assert.rejects(runPatch({ from: 'prior', target: 'part:1', runsRoot: root, check: true, log: () => {} }), /PATCH_PRIOR_INVALID[\s\S]*PRESENT_NEVER_SEEN[\s\S]*outside part:1/);
}));

