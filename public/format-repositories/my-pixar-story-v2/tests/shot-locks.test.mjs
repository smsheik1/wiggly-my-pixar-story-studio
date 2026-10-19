// Change 5: four shot locks. Seedance renders every shot on its own, so whatever a shot does not restate drifts.
// (1) presence + signature-accessory + prop-state lock, (2) the speaker is on screen and leads, (3) minimum shot length per
// spoken line, (4) a visual tell between look-alike cast members. Fixtures only, no model calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateStoryDirectorOutput } from '../crew/linter/check-stage-play.mjs';
import { assembleCompiledPrompt } from '../crew/seedance-compiler/schema.mjs';
import { selectSeedanceCompilerInput } from '../crew/seedance-compiler/input.mjs';
import { validateSeedancePrompts } from '../crew/linter/check-seedance-prompts.mjs';
import { validateCharacterSheets } from '../crew/linter/check-character-sheets.mjs';
import { lockPhrases, lookAlikeReason, tellsDistinct, checkVisualTells, ageBand } from '../crew/linter/shot-locks.mjs';
import { secondsNeeded, budgetMessage } from '../crew/linter/speech.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const read = (f) => readFileSync(new URL(`../crew/${f}`, import.meta.url), 'utf8');
const answers = json('good-answers.json');
const sd = (fn = () => {}) => { const d = json('good-stage-play.json'); fn(d); return validateStoryDirectorOutput(d, answers).issues; };
const codes = (issues, sev = 'error') => issues.filter((i) => i.severity === sev).map((i) => i.code);
const has = (issues, code, msg) => assert.ok(issues.some((i) => i.code === code && (!msg || i.message.includes(msg))), `${code} expected in:\n${issues.map((i) => `${i.code}: ${i.message}`).join('\n')}`);

const state = () => ({ storyDirector: json('good-stage-play.json'), characterArchitect: { output: json('good-master-renders.json') },
  locationScout: { output: json('good-location-plates.json') }, approvedAssets: json('good-approved-assets.json') });
const out = () => json('good-seedance-prompts.json');
const shots = (d, i, fn) => { const s = d.segments[i]; s.tenBlocks.block5_shots = fn(s.tenBlocks.block5_shots); s.compiledPrompt = assembleCompiledPrompt(s.tenBlocks); return d; };
const sc = (d, st = state()) => validateSeedancePrompts(d, selectSeedanceCompilerInput(st)).issues;

// ---- Story Director: structured presence and scene locks
test('SD fixture passes every shot lock', () => assert.deepEqual(codes(sd()), []));
test('scene locks: missing, coverage, order, unknown present, empty prop', () => {
  has(sd((d) => { delete d.segments[0].scenes; }), 'SCENE_LOCK_MISSING');
  has(sd((d) => { d.segments[0].scenes[0].shots = [1, 2, 3, 4, 5]; }), 'SCENE_LOCK_COVERAGE', 'shot 6 is in no scene');
  has(sd((d) => { d.segments[0].scenes = [{ shots: [1, 3], present: ['@Shaz', '@Sister'] }, { shots: [2, 4, 5, 6], present: ['@Shaz', '@Sister', '@Mom'] }]; }), 'SCENE_LOCK_ORDER');
  has(sd((d) => { d.segments[0].scenes[0].present.push('@Ghost'); }), 'SCENE_PRESENT_UNKNOWN');
  has(sd((d) => { d.segments[0].scenes[0].props = ['  ']; }), 'PROP_LOCK_EMPTY');
});
test('onScreen: required, cast tags only, equal to the people in whatWeSee', () => {
  has(sd((d) => { delete d.segments[0].shots[0].onScreen; }), 'ONSCREEN_MISSING');
  has(sd((d) => { d.segments[0].shots[0].onScreen = ['@Shaz']; }), 'ONSCREEN_MISMATCH', 'whatWeSee shows [@Shaz, @Sister]');
  has(sd((d) => { d.segments[0].shots[0].onScreen.push('@Ghost'); }), 'ONSCREEN_UNKNOWN');
});
test('nobody appears or vanishes within a scene unless the story says so', () => {
  // @Mom is not in Part 2's scene: putting her in a shot fails
  has(sd((d) => { const s = d.segments[1].shots[2]; s.whatWeSee = '@Shaz and @Mom stand at the window.'; s.onScreen = ['@Shaz', '@Mom']; }), 'NOT_IN_SCENE');
  // @Mom enters in shot 5; showing her in shot 2 first fails
  has(sd((d) => { const s = d.segments[0].shots[0]; s.whatWeSee = '@Shaz slaps a card down across the table from @Sister while @Mom watches.'; s.onScreen = ['@Shaz', '@Sister', '@Mom']; }), 'APPEARS_BEFORE_ENTRANCE');
  has(sd((d) => { d.segments[0].shots[4].enters = ['@Sister']; }), 'ENTRANCE_NOT_SHOWN');
  has(sd((d) => { d.segments[0].shots[0].exits = ['@Sister']; }), 'SHOWN_AFTER_EXIT', 'on screen again in shot 1.3');
  has(sd((d) => { d.segments[0].shots[1].exits = ['@Sister']; }), 'EXIT_NOT_SHOWN');
  // a single that leaves a present character out of frame is fine
  assert.ok(!codes(sd()).includes('NOT_IN_SCENE'));
  assert.ok(sd((d) => { d.segments[1].scenes[0].present.push('@Mom'); }).some((i) => i.code === 'PRESENT_NEVER_SEEN' && i.severity === 'warning'));
});
test('SD: the speaker is on screen and leads, unless the line is voice-over', () => {
  has(sd((d) => { const s = d.segments[0].shots[2]; s.whatWeSee = '@Shaz waits for an answer.'; s.onScreen = ['@Shaz']; }), 'SPEAKER_NOT_ON_SCREEN');
  has(sd((d) => { const s = d.segments[0].shots[2]; s.whatWeSee = '@Shaz waits while @Sister stays unimpressed.'; s.onScreen = ['@Shaz', '@Sister']; }), 'SPEAKER_NOT_LEADING');
  assert.ok(!codes(sd((d) => { const s = d.segments[0].shots[2]; s.whatWeSee = '@Shaz waits for an answer.'; s.onScreen = ['@Shaz']; s.dialogue.isOffCamera = true; })).some((c) => c.startsWith('SPEAKER_')));
});

// ---- minimum shot length per spoken line
test('speech budget: 3 words/sec plus a 1s pad; the message says lengthen or split, never cut', () => {
  assert.deepEqual([1, 3, 4, 6, 7, 12, 18].map(secondsNeeded), [2, 2, 3, 3, 4, 5, 7]);
  const m = budgetMessage('Shot 1.2', 12, 3);
  assert.match(m, /lengthen this shot to 5s/); assert.match(m, /split the line/); assert.match(m, /Never shorten or paraphrase/);
  has(sd((d) => { const s = d.segments[0].shots[1]; s.dialogue.line = '{I am a scientist and I have proof right here.}'; }), 'DIALOGUE_TIMING_BUDGET', '10 spoken words need 5s');
  has(sd((d) => { d.segments[0].shots[1].dialogue.line = `{${'word '.repeat(19).trim()}}`; }), 'DIALOGUE_TIMING_BUDGET', 'split it across two shots');
});
test('SC copies the staged timecodes and part totals; the speech budget uses the staged words', () => {
  has(sc(((d) => { d.segments[0].shots[1].endSec = 8; return d; })(out())), 'SHOT_TIMING_NOT_AS_STAGED');
  has(sc(((d) => { d.segments[0].totalDurationSec = 28; return d; })(out())), 'SEGMENT_DURATION_NOT_AS_STAGED');
});

// ---- Seedance Compiler: locked wording repeated in every SHOT block
test('SC fixture passes every shot lock', () => assert.deepEqual(codes(sc(out())), []));
test('SC: "On screen:" line and structured cast match the staged onScreen', () => {
  has(sc(shots(out(), 0, (t) => t.replace('On screen: @Shaz.\n', ''))), 'PRESENCE_NOT_STATED', 'no "On screen:" line');
  has(sc(shots(out(), 0, (t) => t.replace('On screen: @Shaz.\n', 'On screen: @Shaz, @Sister.\n'))), 'PRESENCE_NOT_STATED');
  const d = out(); d.segments[0].shots[1].cast = ['@Shaz', '@Sister']; has(sc(d), 'CAST_NOT_AS_STAGED');
});
test('SC: each scene\'s prop state is repeated word for word in every shot', () => {
  has(sc(shots(out(), 0, (t) => t.replace('Props: a short stack of playing cards face up in the middle of the kitchen table.\n', ''))), 'PROP_STATE_MISSING');
  has(sc(shots(out(), 0, (t) => t.replace('a short stack of playing cards face up in the middle', 'some playing cards scattered across the middle'))), 'PROP_STATE_REWORDED');
});
test('SC: the visual tell is part of the locked Look line', () => {
  const st = state(); st.characterArchitect.output.characters[2].visualTell = 'mustard yellow scarf over one shoulder';
  const r = sc(out(), st); has(r, 'VISUAL_TELL_MISSING', 'mustard yellow scarf over one shoulder');
  assert.equal(lockPhrases(st.storyDirector.cast[2], st.characterArchitect.output.characters[2]).at(-1).kind, 'tell');
});
test('SC: eyes stay visible even inside the lock lines', () => {
  has(sc(shots(out(), 0, (t) => t.replace('Look @Shaz: red plastic sunglasses pushed up on his forehead.', 'Look @Shaz: red plastic sunglasses pushed up on his forehead; sunglasses covering his eyes.'))), 'EYES_HIDDEN');
});
test('SC: the speaker is on screen and leads the action', () => {
  const d = out(); d.segments[0].shots[2].cast = ['@Shaz']; has(sc(d), 'SPEAKER_NOT_ON_SCREEN');
  has(sc(shots(out(), 0, (t) => t.replace('@Sister stays unimpressed, one slow blink.', 'Across the table @Shaz waits; @Sister gives one slow blink.'))), 'SPEAKER_NOT_LEADING', '@Sister speaks, so the action leads with @Sister (it starts with @Shaz)');
});

// ---- Character Architect: visual tells between look-alikes
test("look-alike heuristic: same gender, same age band, and similar build or both in the maker's family with the same skin tone", () => {
  assert.deepEqual([5, 12, 13, 29, 30, 49, 50].map(ageBand), ['child', 'child', 'young adult', 'young adult', 'adult', 'adult', 'older adult']);
  const c = (age, headsTall, extra = {}) => ({ elementTag: '@X', age, gender: 'male', family: false, skinTone: 'deep brown', designSpecs: { headsTall }, ...extra });
  assert.ok(lookAlikeReason(c(8, 5), c(6, 5)));            // two boys, same build
  assert.equal(lookAlikeReason(c(8, 5), c(8, 5, { gender: 'female' })), null);
  assert.equal(lookAlikeReason(c(8, 5), c(35, 7.5)), null); // different age band
  assert.equal(lookAlikeReason(c(35, 7.5), c(45, 8.5)), null); // adults, different build, not family
  assert.ok(lookAlikeReason(c(35, 7.5, { family: true }), c(45, 8.5, { family: true }))); // both in the maker's family, same skin tone
  assert.equal(lookAlikeReason(c(35, 7.5, { family: true }), c(45, 8.5, { family: true, skinTone: 'pale peach' })), null);
  assert.ok(tellsDistinct('mustard yellow scarf', 'bright green rain boots'));
  assert.ok(!tellsDistinct('blue scarf', 'light blue scarf'));
  assert.ok(!tellsDistinct('Blue scarf.', 'blue scarf'));
});
test('CA gate: LOOKALIKE_NO_TELL, LOOKALIKE_TELLS_TOO_SIMILAR, TELL_NOT_IN_RENDER; distinct tells pass', () => {
  const twins = () => { const m = json('good-master-renders.json'); const b = structuredClone(m.characters[0]);
    Object.assign(b, { characterId: 'bro', name: 'Bro', elementTag: '@Bro', age: 6 }); m.characters.push(b); return m; };
  const gate = (m) => validateCharacterSheets(m, json('good-stage-play.json')).issues.filter((i) => /TELL/.test(i.code));
  let m = twins(); has(gate(m), 'LOOKALIKE_NO_TELL'); assert.equal(gate(m).length, 2, 'both of the pair need a tell');
  m = twins(); m.characters[0].visualTell = 'blue scarf'; m.characters[3].visualTell = 'light blue scarf';
  m.characters[0].masterRenderPrompt.promptText += ' He wears a blue scarf.'; m.characters[3].masterRenderPrompt.promptText += ' He wears a light blue scarf.';
  has(gate(m), 'LOOKALIKE_TELLS_TOO_SIMILAR');
  m.characters[3].visualTell = 'bright green rain boots'; has(gate(m), 'TELL_NOT_IN_RENDER');
  m.characters[3].masterRenderPrompt.promptText += ' He wears bright green rain boots.'; assert.deepEqual(gate(m), []);
  assert.deepEqual(checkVisualTells(json('good-master-renders.json').characters), []); // no look-alikes in the fixture
});

// ---- role files say it
test('roles teach the four locks', () => {
  const sdRole = read('story-director/role.md'), scRole = read('seedance-compiler/role.md'), caRole = read('character-architect/role.md');
  for (const w of ['onScreen', 'scenes', 'enters', 'exits', 'ceil(words / 3 + 1)', 'The speaker is on screen and leads']) assert.ok(sdRole.includes(w), `SD role: ${w}`);
  for (const w of ['On screen:', 'Look @', 'Props:', 'word for word', 'ACCESSORY_REWORDED', 'SPEAKER_NOT_LEADING', 'SHOT_TIMING_NOT_AS_STAGED']) assert.ok(scRole.includes(w), `SC role: ${w}`);
  for (const w of ['visualTell', 'LOOKALIKE_NO_TELL', 'LOOKALIKE_TELLS_TOO_SIMILAR', 'TELL_NOT_IN_RENDER', 'headsTall` within 0.5']) assert.ok(caRole.includes(w), `CA role: ${w}`);
});
