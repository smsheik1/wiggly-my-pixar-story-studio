// Location Prompt Formula: runtime checks on background prompts, Theo/Beau built skills,
// and the key light handed on to Cam (task.backgroundKeyLight).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backgroundPromptProblems, assertBackgroundPrompt, textElements, keyLightOf } from '../runtime/background-prompt.mjs';
import { taskFor } from '../runtime/workflow.mjs';
import { backgroundProject, registry, author, brief, prompt } from './background-helpers.mjs';
import { approved, reviewed } from './helpers.mjs';
import { keyframeProject } from './shot-helpers.mjs';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const examples = [...read('crew/theo/role.md').matchAll(/```text\n([\s\S]*?)\n```/g)].map(m => m[1]);

test('the five studio examples are in Theo verbatim, summarised for Beau, with no brand or tool names', () => {
  assert.equal(examples.length, 5);
  const beau = read('crew/beau/SKILL.md'), theo = read('crew/theo/SKILL.md');
  for (const e of examples) assert.ok(theo.includes(e));
  assert.match(beau, /Theo's skill carries five studio prompts/);
  for (const s of [theo, beau]) assert.doesNotMatch(s, /pixar|seedance/i);
  assert.match(theo, /The Location Prompt Formula \(hard rule\)/);
  assert.match(read('crew/cam/SKILL.md'), /task\.backgroundKeyLight/);
});

test('every studio example and Theo worked output passes the formula checks', () => {
  for (const e of examples) assert.deepEqual(backgroundPromptProblems(e), [], e.slice(0, 60));
  for (const m of read('crew/theo/role.md').matchAll(/"prompt": "(.*?)",\n/g)) assert.deepEqual(backgroundPromptProblems(m[1]), []);
});

test('a prompt without "empty of people" is rejected', () => {
  assert.throws(() => assertBackgroundPrompt('An empty kitchen interior. Warm sun through the window on the left.'), /BACKGROUND_PROMPT_FORMULA: say the room is "completely empty of people"/);
});

test('more than one piece of text is rejected; one hand-lettered banner and the CG acronym are fine', () => {
  assert.deepEqual(textElements('production CG. A hand-lettered banner reading MY FAMILY above a TV.'), ['MY FAMILY']);
  assert.deepEqual(textElements('A sign reading "Open" and a poster saying "Hello"'), ['OPEN', 'HELLO']);
  const two = 'Room, completely empty of people, a banner reading MY FAMILY and a sign reading EXIT. Sun through the window on the left.';
  assert.throws(() => assertBackgroundPrompt(two), /at most one piece of rendered text.*found 2: MY FAMILY, EXIT/);
});

test('a prompt with no named light and direction is rejected', () => {
  assert.throws(() => assertBackgroundPrompt('A cosy room, completely empty of people. Warm and bright.'), /name one key light source with its direction/);
  assert.equal(keyLightOf('An empty hallway in a house fire from a feature-quality 3D animated film. Nothing else.'), null);
  assert.equal(keyLightOf(examples[0]), 'soft morning sunlight casting long gentle shadows across the floor from unseen tall windows on the left.');
});

test('the runtime rejects a formula-breaking background prompt from Theo', () => {
  let p = approved(reviewed(author(backgroundProject(), registry)));
  p = approved(reviewed(author(p, brief(p))));
  const bad = { ...prompt(p), prompt: 'A warm workshop with a workbench by the doorway.' };
  assert.throws(() => author(p, bad, 'pixar-prompter'), /BACKGROUND_PROMPT_FORMULA/);
  author(p, prompt(p), 'pixar-prompter');
});

test('Cam receives the background key light in the keyframe task', () => {
  const task = taskFor(keyframeProject());
  assert.equal(task.step, 'keyframePrompt');
  assert.match(task.backgroundKeyLight, /^(?:Same w|W)arm morning sunlight through the window on the left\.$/);
});
