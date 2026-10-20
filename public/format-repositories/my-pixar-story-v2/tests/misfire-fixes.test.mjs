// r5-dry1 misfire fixes: (1) optional signatureAccent, never invented; (2) OpenRouter key-limit / credit errors are
// fatal (no retries, whole run stops); (3) Story Director output cap (models.test.mjs + sd-finale.test.mjs).
// Fake models only: zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { parseStagePlay, accentOf } from '../crew/story-director/schema.mjs';
import { parseCharacterSheets } from '../crew/character-architect/schema.mjs';
import { validateStoryDirectorOutput } from '../crew/linter/check-stage-play.mjs';
import { validateSeedancePrompts } from '../crew/linter/check-seedance-prompts.mjs';
import { selectSeedanceCompilerInput } from '../crew/seedance-compiler/input.mjs';
import { assembleCompiledPrompt } from '../crew/seedance-compiler/schema.mjs';
import { lockPhrases } from '../crew/linter/shot-locks.mjs';
import { makeSubmitTool, deepAgentInvoke } from '../graph/deep-agent-node.mjs';
import { buildGraph, makeAgentNode, isTransient } from '../graph/graph.mjs';
import { isFatalProviderError, redactProviderMessage, FATAL_CODE } from '../graph/provider-errors.mjs';
import { GOOD_ANSWERS } from './fixtures/good-answers.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const read = (f) => readFileSync(new URL(`../crew/${f}`, import.meta.url), 'utf8');
const answers = json('good-answers.json');
const codes = (issues, sev = 'error') => issues.filter((i) => i.severity === sev).map((i) => i.code);

// ---------------- 1) signatureAccent optional ----------------
test('signatureAccent: missing, empty, whitespace or "none" all parse and mean no accessory (key dropped)', () => {
  for (const v of [undefined, '', '   ', 'none', 'None.', 'n/a', 'no accessory', 'No signature accent']) {
    const d = json('good-stage-play.json');
    if (v === undefined) delete d.cast[2].signatureAccent; else d.cast[2].signatureAccent = v;
    const p = parseStagePlay(d);
    assert.ok(!('signatureAccent' in p.cast[2]), JSON.stringify(v));
    assert.equal(accentOf(v), '');
  }
  const d = json('good-stage-play.json'); d.cast[1].signatureAccent = 'wears a hijab';
  assert.equal(parseStagePlay(d).cast[1].signatureAccent, 'wears a hijab', 'given wording kept as is');
});

test('signatureAccent: the submit tool does not require it, and the SD gate passes without it (no WEAK_SIGNATURE_ACCENT)', async () => {
  const subs = []; const t = makeSubmitTool('story-director', subs);
  assert.ok(!(t.schema.properties.cast.items.required ?? []).includes('signatureAccent'));
  const d = json('good-stage-play.json'); delete d.cast[2].signatureAccent; d.cast[1].signatureAccent = '';
  assert.match(await t.func(d), /submitted/); assert.equal(subs.length, 1);
  const r = validateStoryDirectorOutput(parseStagePlay(d), answers);
  assert.equal(r.isValid, true, codes(r.issues).join(', '));
  assert.ok(!codes(r.issues, 'warning').includes('WEAK_SIGNATURE_ACCENT'));
  const c = json('good-master-renders.json'); delete c.characters[0].signatureAccent; c.characters[1].signatureAccent = '';
  const ca = parseCharacterSheets(c);
  assert.ok(!('signatureAccent' in ca.characters[0]) && !('signatureAccent' in ca.characters[1]));
});

test('signatureAccent: an empty one is left out of the per-shot Look lock; a given one is still locked word for word', () => {
  assert.deepEqual(lockPhrases({ signatureAccent: '', signatureAccessories: ['wears a hijab'] }).map((p) => p.text), ['wears a hijab']);
  assert.deepEqual(lockPhrases({ signatureAccent: 'none', signatureAccessories: [' ', 'none'] }), []);
  assert.deepEqual(lockPhrases({}), []);
  // SC gate: strip @Sister's accent wording from the prompts. Locked on the card -> ACCESSORY_MISSING; empty on the card -> not required.
  const strip = () => { const d = json('good-seedance-prompts.json');
    for (const s of d.segments) { s.tenBlocks.block5_shots = s.tenBlocks.block5_shots.replaceAll('Look @Sister: yellow hoodie strings; ', 'Look @Sister: '); s.compiledPrompt = assembleCompiledPrompt(s.tenBlocks); }
    return d; };
  const state = (accent) => { const sd = json('good-stage-play.json'); const sis = sd.cast.find((c) => c.elementTag === '@Sister');
    if (accent === undefined) delete sis.signatureAccent; else sis.signatureAccent = accent;
    return { storyDirector: parseStagePlay(sd), characterArchitect: { output: json('good-master-renders.json') }, locationScout: { output: json('good-location-plates.json') }, approvedAssets: json('good-approved-assets.json') }; };
  const sisterAccessory = (st) => validateSeedancePrompts(strip(), selectSeedanceCompilerInput(st)).issues.filter((i) => /^ACCESSORY_/.test(i.code) && /hoodie/.test(i.message));
  assert.ok(sisterAccessory(state('yellow hoodie strings')).length > 0, 'baseline: a given accent is locked');
  assert.equal(sisterAccessory(state(undefined)).length, 0);
  assert.equal(sisterAccessory(state('')).length, 0);
});

test('signatureAccent rules: never invent accessory details, use the given wording, empty = none (SD, CA, SC roles)', () => {
  const sd = read('story-director/3-script-writer.md'), ca = read('character-architect/role.md'), sc = read('seedance-compiler/role.md');
  assert.match(sd, /Never invent accessory details/); assert.match(sd, /"wears a hijab" stays "wears a hijab"/); assert.match(sd, /`signatureAccent` is optional/);
  assert.match(ca, /Never invent identity facts/); assert.match(ca, /none on the card means no signature item/); assert.match(ca, /Outfit colours they leave open are yours to choose/);
  assert.match(sc, /empty accent means no accessory and is skipped/); assert.match(sc, /never adding a colour or detail the card does not give/);
  assert.ok(!/navy hijab fully covering/.test(readFileSync(new URL('../crew/story-director/schema.mjs', import.meta.url), 'utf8')), 'schema example no longer models an invented colour');
});

// ---------------- 2) fatal provider errors ----------------
const KEY_MSG = '403 Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/default/keys/abc123def456 $5.01 of $5.00 used; does not reset.';
const err = (message, status) => Object.assign(new Error(message), status ? { status } : {});

test('fatal classifier: 403 key limit and 402 credits are fatal; other 403s, 429 and 5xx are not', () => {
  assert.ok(isFatalProviderError(err(KEY_MSG)));
  assert.ok(isFatalProviderError(err('Key limit exceeded', 403)));
  assert.ok(isFatalProviderError(err('402 Insufficient credits. Add more using https://openrouter.ai/settings/credits')));
  assert.ok(isFatalProviderError(err('Payment Required', 402)));
  for (const m of ['403 Forbidden: this model is not available in your region', '429 rate limit', '503 overloaded', 'fetch failed', 'model call timed out'])
    assert.ok(!isFatalProviderError(err(m)), m);
  assert.ok(!isTransient(err(KEY_MSG)), 'never a transient retry');
  assert.ok(!redactProviderMessage(KEY_MSG).includes('/keys/'), 'key settings URL is not logged');
});

test('fatal: a node that hits a key-limit 403 stops after ONE call: no transient retry, no attempts 2-3, clear message', async () => {
  let calls = 0;
  const node = makeAgentNode('story-director', async () => { calls++; throw err(KEY_MSG); }, { skill: () => 'skill' });
  const s = await node({ inputs: { subject: 'Shaz', answers: GOOD_ANSWERS, targetTotalRuntimeSec: 60 } });
  assert.equal(calls, 1);
  assert.equal(s.status, 'failed'); assert.equal(s.attempts['story-director'], 1);
  const issue = s.escalations[0].issues[0];
  assert.equal(issue.code, FATAL_CODE);
  assert.match(issue.message, /key limit \/ credits exhausted - run stopped immediately, no retries/);
  assert.match(s.escalations[0].reason, /fatal provider error \(no retries\)/);
  assert.ok(!issue.message.includes('/keys/'));
});

test('fatal: in the graph, CA hitting the key limit aborts the parallel Location Scout and the compiler never runs', async () => {
  const calls = [];
  let lsAborted = false;
  const invoke = async (req) => {
    calls.push(req.agent);
    if (req.agent === 'story-director') return JSON.stringify(json('good-stage-play.json'));
    if (req.agent === 'character-architect') { await new Promise((r) => setTimeout(r, 20)); throw err(KEY_MSG); }
    if (req.agent === 'location-scout') {
      // a long call that only ends when the run is stopped
      return new Promise((_, reject) => { req.signal.addEventListener('abort', () => { lsAborted = true; reject(req.signal.reason); }, { once: true }); });
    }
    throw new Error(`unexpected ${req.agent}`);
  };
  const s = await buildGraph({ invoke }).invoke({ inputs: { subject: 'Shaz', answers: GOOD_ANSWERS, targetTotalRuntimeSec: 60, settingSeed: 'suburban home' }, approvedAssets: json('good-approved-assets.json') });
  assert.equal(s.status, 'failed');
  assert.ok(lsAborted, 'the in-flight sibling call was aborted');
  assert.deepEqual(calls.sort(), ['character-architect', 'location-scout', 'story-director'], 'one call each, no retries, no compiler');
  assert.ok(s.escalations.length === 2 && s.escalations.every((e) => e.issues[0].code === FATAL_CODE && e.attempts === 1), JSON.stringify(s.escalations));
  assert.match(s.escalations.find((e) => e.agent === 'location-scout').issues[0].message, /run stopped: character-architect hit a fatal provider error/);
});

class ScriptedModel extends BaseChatModel {
  constructor(script) { super({}); this.modelName = 'isolated-scripted-model'; this.script = script; this.calls = 0; }
  getName() { return 'ChatOpenAI'; }
  _llmType() { return 'isolated-scripted-test'; }
  bindTools() { return this; }
  async _generate(messages) { this.calls++; const step = this.script.shift(); assert.ok(step, 'model called after expected termination'); return { generations: [{ text: '', message: step(messages) }] }; }
}
test('fatal: a key-limit error during a self-review rewrite is not swallowed as a failed rewrite', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'wiggly-v2-fatal-'));
  try {
    const call = (name, args) => new AIMessage({ content: '', tool_calls: [{ name, args, id: name + Math.random().toString(36).slice(2, 7), type: 'tool_call' }] });
    const m = new ScriptedModel([
      () => call('submit_story_director', json('good-stage-play.json')),
      () => new AIMessage('1. Tighten the finale.\nVERDICT: REVISE'),
      () => { throw err(KEY_MSG); },
    ]);
    await assert.rejects(deepAgentInvoke({ finalReview: false, createModel: async () => m, runsRoot: runs, runId: 'fatal' })({ agent: 'story-director', config: { model: 'isolated-scripted-model', reflectionRounds: 2 }, input: { answers: {} }, attempt: 1 }),
      (e) => isFatalProviderError(e));
    assert.equal(m.calls, 3, 'stopped at the failing rewrite: no round 2');
  } finally { await rm(runs, { recursive: true, force: true }); }
});

// ---------------- r5-dry2 misfires ----------------
import { SeedanceSegmentSchema } from '../crew/seedance-compiler/schema.mjs';
import { parseStringifiedFields } from '../graph/deep-agent-node.mjs';
import { lookAlikeReason } from '../crew/linter/shot-locks.mjs';

test('Seedance schema: a voice-over / off-camera speaker needs no picture attached to the part; an on-camera one still does', () => {
  const seg = () => structuredClone(json('good-seedance-prompts.json').segments[0]);
  const speakerIssues = (s) => { const r = SeedanceSegmentSchema.safeParse(s); return r.success ? [] : r.error.issues.filter((i) => i.path.join('.').endsWith('dialogue.speaker')); };
  for (const mode of ['voiceover', 'off-camera']) {
    const s = seg(); s.shots[0].dialogue = { speaker: '@Narrator', line: '{When I was 8 years old, I wanted to be a scientist.}', mode };
    assert.deepEqual(speakerIssues(s), [], mode);
  }
  const s = seg(); s.shots[0].dialogue = { speaker: '@Narrator', line: '{When I was 8 years old, I wanted to be a scientist.}', mode: 'on-camera' };
  const iss = speakerIssues(s); assert.equal(iss.length, 1); assert.match(iss[0].message, /speaks on camera but is not a bound cast reference.*voiceover/);
  const d = seg(); d.shots[0].dialogue = { speaker: '@Narrator', line: '{Hi there.}' }; // mode defaults to on-camera
  assert.equal(speakerIssues(d).length, 1);
});

test('Seedance gate: a heard-only speaker must still be in the stage-play cast', () => {
  const d = json('good-seedance-prompts.json'); const s = d.segments[0];
  s.shots[0].dialogue = { speaker: '@Nobody', line: '{A line.}', mode: 'voiceover' };
  const st = { storyDirector: json('good-stage-play.json'), characterArchitect: { output: json('good-master-renders.json') }, locationScout: { output: json('good-location-plates.json') }, approvedAssets: json('good-approved-assets.json') };
  assert.ok(validateSeedancePrompts(d, selectSeedanceCompilerInput(st)).issues.some((i) => i.code === 'SPEAKER_NOT_IN_CAST'));
});

test('submit tool: segments sent as a JSON string are parsed; non-JSON strings and wrong types are left for the schema to reject', async () => {
  const js = { type: 'object', properties: { segments: { type: 'array' }, meta: { anyOf: [{ type: 'object' }, { type: 'null' }] }, title: { type: 'string' } } };
  assert.deepEqual(parseStringifiedFields({ segments: '[{"a":1}]', meta: '{"b":2}', title: '[not parsed]' }, js), { segments: [{ a: 1 }], meta: { b: 2 }, title: '[not parsed]' });
  assert.deepEqual(parseStringifiedFields({ segments: '{"a":1}' }, js), { segments: '{"a":1}' }, 'object where an array is wanted: untouched');
  assert.deepEqual(parseStringifiedFields({ segments: '[broken' }, js), { segments: '[broken' });
  const good = json('good-seedance-prompts.json');
  const subs = []; const t = makeSubmitTool('seedance-compiler', subs);
  assert.match(await t.func({ ...good, segments: JSON.stringify(good.segments) }), /submitted/);
  assert.equal(subs.length, 1); assert.ok(Array.isArray(subs[0].segments) && subs[0].segments.length === good.segments.length);
  const subs2 = []; const t2 = makeSubmitTool('seedance-compiler', subs2);
  assert.match(await t2.func({ ...good, segments: 'not json' }), /SUBMISSION REJECTED.*\n- segments: Invalid input: expected array/);
});

test("look-alike reason: 'in the maker's family' is not described as blood resemblance", () => {
  const c = (extra) => ({ elementTag: '@X', age: 25, gender: 'female', family: true, skinTone: 'light olive', designSpecs: { headsTall: 6 }, ...extra });
  const why = lookAlikeReason(c({ designSpecs: { headsTall: 7.5 } }), c({ designSpecs: { headsTall: 6 } }));
  assert.match(why, /both in the maker's family with the same skin tone/); assert.ok(!/resemblance/.test(why));
  assert.ok(!/same family resemblance/.test(read('character-architect/role.md')));
});
