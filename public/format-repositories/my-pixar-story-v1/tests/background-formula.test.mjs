// Location Prompt Formula: runtime checks on background prompts, Theo/Beau built skills,
// and the key light handed on to Cam (task.backgroundKeyLight).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backgroundPromptProblems, assertBackgroundPrompt, textElements, keyLightOf, backgroundBriefProblems, assertBackgroundBrief } from '../runtime/background-prompt.mjs';
import { backgroundMutedProblems } from '../build-skills.mjs';
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

// Regression cases: the two failing live prompts from Oct 2026 (bgq-old-prompts.txt).
// keyLightOf picked the camera sentence ("...facing the television glow") and the car
// sentence ("...windows rolled down ... no readable lettering") because "window(s)"
// counted as a direction and matching was first-hit per sentence.
const OLD_LIVING = `An empty living room interior from a feature-quality 3D animated film, production CG, not photorealistic and not flat cartoon. Cozy, lived-in feel. Camera: wide shot at chest height from the television side, looking toward the couch and shelf, with open rug floor kept clear in the centre for sitting together facing the television glow. The whole room reads to the frame edges. Room: a small deeply lived-in family living room in late afternoon, completely empty of people. A deeply worn couch with thick sagging cushions along the back wall facing a low rich warm wood television stand at the front, fabric creased and cushions sunk unevenly. A soft faded rug spread between them with saturated cobalt blue trading cards scattered in loose uneven spreads with curled edges, soft floor cushions near the couch tipped at angles and slightly scuffed. A low rich warm wood shelf on the back wall behind the couch holding a small science kit with glass jars and tools, plain framed family photos hung slightly crooked above, side window with simple curtains on the left wall, small side table with a drop lamp beside the couch. Secondary detail receding into depth: low rich warm wood television stand at the front edge, side table with drop lamp to the right, side window with simple curtains to the left, warm late-afternoon sun streaming through the left window laying long soft rectangles across the rug and floor. Light: late-afternoon sun through the left window, warm and soft, filling the room evenly. Bounce: warm bounce off cream walls. Practicals: one drop lamp beside the couch, off. Haze: no. Palette: muted warm woods and off-whites at roughly five to one. Accent: saturated cobalt blue on the scattered trading cards. Film accent kept out: warm amber lamplight.`;
const OLD_DRIVE = `An empty suburban driveway exterior from a feature-quality 3D animated film, production CG, not photorealistic and not flat cartoon. Hot, bright and sun-beaten. Camera: wide shot at driver-side height standing on the driveway, looking toward the coupe, with open driveway floor kept clear along the driver side for the driver-seat action. The whole driveway reads to the frame edges. Room: a sun-beaten suburban driveway on a hot afternoon, completely empty of people. A faded silver two-door coupe sits left of centre with nose toward the street, windows rolled down, roof and hood sun-bleached and dull, small saturated red aux cord resting on the plain dashboard by the radio with no readable lettering anywhere. Deeply cracked warm concrete with weeds along the edges runs under the car. Secondary detail receding into depth: basketball hoop fixed over the garage door behind to the right, coiled garden hose hanging on the garage wall, low hedge running along the side of the driveway, bright hot afternoon sun casting short hard shadow shapes straight down across the driveway from directly overhead. Light: bright hot afternoon sun overhead, harsh and direct, filling the driveway evenly. Bounce: pale bounce off cracked concrete and light house walls. Practicals: no. Haze: no. Palette: muted sun-bleached silvers and warm concretes at roughly five to one. Accent: the small saturated red aux cord on the dashboard. Film accent kept out: warm amber lamplight.`;

test('regression: keyLightOf returns the sun clause, not the camera/coupe sentence', () => {
  assert.match(keyLightOf(OLD_LIVING), /late-afternoon sun through the left window/);
  assert.doesNotMatch(keyLightOf(OLD_LIVING), /television glow/);
  assert.match(keyLightOf(OLD_DRIVE), /bright hot afternoon sun.*overhead/);
  assert.doesNotMatch(keyLightOf(OLD_DRIVE), /windows rolled down|no readable lettering/);
});

test('regression: the old prompts are now flagged (muted, kept out, filling evenly)', () => {
  for (const p of [OLD_LIVING, OLD_DRIVE]) {
    const problems = backgroundPromptProblems(p);
    assert.ok(problems.some(x => /muted/i.test(x)), `flags muted: ${problems.join('; ')}`);
    assert.ok(problems.some(x => /kept out/i.test(x)), `flags kept out: ${problems.join('; ')}`);
    assert.ok(problems.some(x => /evenly/i.test(x)), `flags filling evenly: ${problems.join('; ')}`);
    assert.throws(() => assertBackgroundPrompt(p), /BACKGROUND_PROMPT_FORMULA/);
  }
});

test('all five gold examples pass with a sensible key light', () => {
  assert.equal(examples.length, 5);
  for (const e of examples) {
    assert.deepEqual(backgroundPromptProblems(e), [], e.slice(0, 60));
    const k = keyLightOf(e);
    assert.ok(k && k.length > 20, `sensible key light for ${e.slice(0, 60)}`);
    assert.doesNotMatch(k, /television glow|windows rolled down/i);
  }
  assert.match(keyLightOf(examples[0]), /sunlight.*left/);
  assert.match(keyLightOf(examples[4]), /spotlight beam.*down/);
});

test('brief directions must never say muted', () => {
  assert.deepEqual(backgroundBriefProblems('A warm room. Light: morning sun through the window on the left. Palette: bright teal and sunflower-yellow.'), []);
  assert.match(backgroundBriefProblems('Palette: muted warm woods')[0], /muted/);
  assert.throws(() => assertBackgroundBrief('A muted palette room'), /BACKGROUND_BRIEF/);
  let p = approved(reviewed(author(backgroundProject(), registry)));
  assert.throws(() => author(p, { ...brief(p), direction: 'A warm room with a muted palette.' }), /BACKGROUND_BRIEF/);
});

test('build lint: beau/theo roles use muted only in never/not sentences', () => {
  assert.deepEqual(backgroundMutedProblems('A room with rich colour; never a muted room.'), []);
  assert.deepEqual(backgroundMutedProblems('Not a muted palette.'), []);
  assert.equal(backgroundMutedProblems('A muted palette with one accent.').length, 1);
});
