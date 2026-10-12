// P16 run 1 scope C: Beau knownDetails quotes, Beau owner-review quotes, bible
// filmAccent. Invented fixtures only. No network, no providers, no real codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import { current, taskFor, applyEvent } from '../runtime/workflow.mjs';
import { verifyReviewQuotes } from '../runtime/crew.mjs';
import { biblePacket, parseBible, compileBible, BIBLE_SCHEMA } from '../runtime/bible.mjs';
import { reviewed, approved, send } from './helpers.mjs';
import { author, backgroundProject, registry, brief } from './background-helpers.mjs';
import { supervisedCharacters } from './supervised-helpers.mjs';

// Hard safety: network calls prohibited
globalThis.fetch = () => { throw new Error('FETCH_PROHIBITED: Network calls are forbidden in p16-beau-bible.test.mjs.'); };

const T = { timeout: 20000 };
function atBrief() {
  let p = backgroundProject();
  p = approved(reviewed(author(p, registry)));
  assert.equal(p.step, 'backgroundBrief');
  return p;
}
function sourcedBrief(p, entries) {
  const b = brief(p);
  return { ...b, knownDetails: entries };
}
function answersQuote(p) {
  const inputs = current(p, 'answers')?.content.inputs ?? p.inputs;
  const answers = inputs.answers;
  const answerKey = Object.keys(answers)[0], subKey = Object.keys(answers[answerKey])[0];
  return { field: `${answerKey}.${subKey}`, quote: answers[answerKey][subKey].slice(0, 24) };
}
function scriptQuote(p) {
  return current(p, 'script').content.beats[0].narration.slice(0, 24);
}

test('answers-sourced knownDetail with a word-for-word quote is accepted', T, () => {
  const p = atBrief(), { field, quote } = answersQuote(p);
  const q = author(p, sourcedBrief(p, [{ detail: 'the remembered bicycle corner', quote, source: 'answers', field }]), 'background-owner');
  assert.equal(q.gate, 'review');
});

test('script-sourced knownDetail with a word-for-word quote is accepted', T, () => {
  const p = atBrief(), quote = scriptQuote(p);
  const q = author(p, sourcedBrief(p, [{ detail: 'the bicycle the narration names', quote, source: 'script', field: 'beats[0].narration' }]), 'background-owner');
  assert.equal(q.gate, 'review');
});

test('invented answers quote is rejected with KNOWN_DETAIL_UNSOURCED', T, () => {
  const p = atBrief(), { field } = answersQuote(p);
  assert.throws(() => author(p, sourcedBrief(p, [{ detail: 'the invented trophy shelf', quote: 'a trophy shelf never mentioned anywhere', source: 'answers', field }]), 'background-owner'), /KNOWN_DETAIL_UNSOURCED.*trophy shelf/);
});

test('invented script quote and unknown answer field are rejected', T, () => {
  const p = atBrief();
  assert.throws(() => author(p, sourcedBrief(p, [{ detail: 'the invented parade', quote: 'a parade never mentioned anywhere', source: 'script', field: 'beats[0].narration' }]), 'background-owner'), /KNOWN_DETAIL_UNSOURCED/);
  const { quote } = answersQuote(p);
  assert.throws(() => author(p, sourcedBrief(p, [{ detail: 'the misfiled corner', quote, source: 'answers', field: 'nope.not-here' }]), 'background-owner'), /KNOWN_DETAIL_UNSOURCED/);
});

test('old string-array briefs still parse and submit', T, () => {
  const p = atBrief(), b = brief(p);
  assert.ok(b.knownDetails.every(d => typeof d === 'string'));
  const q = author(p, b, 'background-owner');
  assert.equal(q.gate, 'review');
});

const ownerReview = quotes => ({ decision: 'approved', checks: [{ criterion: 'brief-fit', status: 'pass', evidence: 'ISOLATED', location: 'prompt', quotes }] });
const ownerTask = () => ({ artifact: { content: { prompt: 'A small warm kitchen in late afternoon with a blue crock.' } }, dependencies: [{ content: { direction: 'A small warm kitchen in late afternoon.', knownDetails: ['blue crock'] } }] });

test('Beau owner-review: a real prompt or brief quote is accepted, a made-up one rejected', T, () => {
  const task = ownerTask();
  assert.doesNotThrow(() => verifyReviewQuotes({ role: 'background-product-owner', task, review: ownerReview(['A small warm kitchen in late afternoon']), outputs: new Map() }));
  assert.doesNotThrow(() => verifyReviewQuotes({ role: 'background-product-owner', task, review: ownerReview(['blue crock']), outputs: new Map() }));
  assert.throws(() => verifyReviewQuotes({ role: 'background-product-owner', task, review: ownerReview(['a chrome spaceship never described anywhere']), outputs: new Map() }), /REVIEW_QUOTE_NOT_FOUND/);
});

function complete(p, tweak = {}) {
  const script = current(p, 'script'), sheet = current(p, 'sheet:alex');
  return {
    schema: BIBLE_SCHEMA, title: 'Invented production bible', logline: 'An invented parent tells Mia how a bicycle taught patience.',
    script: { source: { artifactId: script.id, digest: script.digest }, lockedPointer: `${script.id} in this run`, beats: script.content.beats.map(b => ({ beat: b.beat, narration: b.narration })), notes: [] },
    cast: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', minor: false, storyPurpose: 'The invented parent.', sheet: { artifactId: sheet.id, digest: sheet.digest, selection: 0, pick: 'ISOLATED pick' },
      lockedDescription: 'Invented adult in a green work apron.', continuity: ['Alex always wears the green work apron.'], referencePhoto: { status: 'reference-photo', note: 'Invented fixture photo.' } }],
    style: { look: 'Pixar-style 3D animated feature film.', sets: 'Lived-in, story-dressed sets.', rules: ['No text anywhere in images.'] },
    scenes: [{ id: 'home-0', beat: 1, location: 'home', locationId: 'home', characterIds: ['alex'], timeOfDay: 'late afternoon', mood: 'warm, patient', keyProps: ['a red bicycle with a loose bell'], setDressing: ['tools hung on a pegboard'] }],
    filmAccent: { colour: 'deep green', keyProp: 'the brass bell' },
    openQuestions: [], ...tweak,
  };
}
function atShotIntentions() {
  const p = structuredClone(supervisedCharacters());
  p.bible = { policy: 'required', versions: [] };
  return p;
}
const ev = (p, action, actor, extra = {}) => applyEvent(p, { taskId: taskFor(p).taskId, action, actor, ...extra });

test('filmAccent validates and reaches Beau and Theo packets only', T, () => {
  let p = atShotIntentions();
  const content = complete(p);
  p = ev(p, 'bible-draft', 'human', { message: 'ISOLATED draft with accent', content });
  assert.equal(p.bible.versions[0].content.filmAccent.colour, 'deep green');
  p = ev(p, 'bible-sign', 'human', { artifactDigest: parseBible(content).hash, content: { by: 'isolated-human' }, message: 'ISOLATED sign' });
  assert.deepEqual(biblePacket(p, 'background-product-owner', 'author', null).filmAccent, { colour: 'deep green', keyProp: 'the brass bell' });
  assert.deepEqual(biblePacket(p, 'pixar-prompter', 'author', null).filmAccent, { colour: 'deep green', keyProp: 'the brass bell' });
  assert.ok(!('filmAccent' in biblePacket(p, 'shot-planner', 'author', null)));
});

test('bibles without filmAccent still load; compileBible drafts it UNRESOLVED', T, () => {
  let p = atShotIntentions();
  const { filmAccent: _dropped, ...legacy } = complete(p);
  p = ev(p, 'bible-draft', 'human', { message: 'ISOLATED legacy draft', content: legacy });
  p = ev(p, 'bible-sign', 'human', { artifactDigest: parseBible(legacy).hash, content: { by: 'isolated-human' }, message: 'ISOLATED sign' });
  assert.ok(!('filmAccent' in biblePacket(p, 'background-product-owner', 'author', null)));
  assert.deepEqual(compileBible(atShotIntentions()).filmAccent, { colour: 'UNRESOLVED', keyProp: 'UNRESOLVED' });
});
