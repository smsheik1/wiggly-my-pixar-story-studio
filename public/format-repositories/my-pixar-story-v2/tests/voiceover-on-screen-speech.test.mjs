import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSeedancePrompts } from '../crew/seedance-compiler/schema.mjs';
import { selectSeedanceCompilerInput } from '../crew/seedance-compiler/input.mjs';
import { validateSeedancePrompts, speechInAction } from '../crew/linter/check-seedance-prompts.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const LOCK = 'No one on screen speaks; every on-screen mouth stays closed.';
const shot = (action, line = '@Narrator, voiceover: {The summer we met.}') => `SHOT 1 | 0–6s\nCamera: medium, eye level, static.\nOn screen: @A, @B.\n${action}\n${line}\n${LOCK}\nHard cut.\n`;

test('speech verbs in a narration shot action are found (generic, any name)', () => {
  for (const [a, w] of [['@A sits on a bench talking with big hand gestures.', 'talking'], ['@B laughs at the joke.', 'laughs'],
    ['@A yells across the yard.', 'yells'], ['@B tells @A a story.', 'tells'], ['@A says goodbye.', 'says'], ['@B sings along.', 'sings'],
    ['@A is chatting with @B.', 'chatting'], ['@A shouts and waves.', 'shouts'], ['@B speaks softly.', 'speaks'], ['@A whispers to @B.', 'whispers']])
    assert.deepEqual(speechInAction(shot(a)), [w], a);
});
test('silent actions, negations, braces and lock lines do not trip the check', () => {
  for (const a of ['@A smiles with a closed-mouth smile, miming a roofline in the air.', '@A listens without saying a word.',
    '@B laughs silently, shoulders shaking, mouth closed.', '@A does not speak; @B nods.', '@A gestures, never talking.'])
    assert.deepEqual(speechInAction(shot(a, '@Narrator, voiceover: {you would tell me what you said}')), [], a);
});
test('gate: VOICEOVER_ON_SCREEN_SPEECH fails a voiceover shot whose action has someone talking; on-camera shots are untouched', () => {
  const st = { storyDirector: json('good-stage-play.json'), characterArchitect: { output: json('good-master-renders.json') },
    locationScout: { output: json('good-location-plates.json') }, approvedAssets: json('good-approved-assets.json') };
  const inp = selectSeedanceCompilerInput(st);
  const base = parseSeedancePrompts(json('good-seedance-prompts.json'));
  assert.ok(!validateSeedancePrompts(base, inp).issues.some((i) => i.code === 'VOICEOVER_ON_SCREEN_SPEECH'));
  const d = json('good-seedance-prompts.json');
  const seg = d.segments.find((s) => /,\s*voice[- ]?over\s*:/i.test(s.tenBlocks.block5_shots));
  assert.ok(seg, 'fixture has a voiceover shot');
  const blocks = seg.tenBlocks.block5_shots.split(/(?=SHOT\s+\d+\s*\|)/);
  const k = blocks.findIndex((b) => /,\s*voice[- ]?over\s*:/i.test(b));
  const before = blocks[k];
  blocks[k] = before.replace(/(\n@[\w_]+,\s*voice[- ]?over\s*:)/i, '\nEveryone on screen is talking and laughing.$1');
  const after = blocks.join('');
  seg.compiledPrompt = seg.compiledPrompt.replace(seg.tenBlocks.block5_shots, after); seg.tenBlocks.block5_shots = after;
  const r = validateSeedancePrompts(parseSeedancePrompts(d), inp);
  const hit = r.issues.find((i) => i.code === 'VOICEOVER_ON_SCREEN_SPEECH');
  assert.ok(hit && hit.severity === 'error', r.issues.map((i) => i.code).join(','));
  assert.match(hit.message, /"talking", "laughing"/); assert.match(hit.message, /closed-mouth smile/);
  assert.equal(r.isValid, false);
});
