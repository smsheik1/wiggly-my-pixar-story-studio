import test from 'node:test';
import assert from 'node:assert/strict';
import {initialProject,characterRecipeSha256,validateArtifactContent,FIXED_SHEET_EXPRESSIONS} from '../runtime/workflow.mjs';
import {digest} from '../runtime/contracts.mjs';
import {inputs} from './helpers.mjs';
import {image} from './background-helpers.mjs';
import {assertPromptPhotoLikeness,photoFaceLabels} from '../runtime/identity.mjs';

const WARM_EIGHT = ['neutral', 'warm smile', 'pure joy', 'thoughtful concentration', 'determined resolve', 'gentle surprise', 'tender concern', 'playful mischief'];
const EIGHT_LIST = WARM_EIGHT.join(', ');

function piaProject({photo = true, mustKeep = undefined} = {}) {
  const p = initialProject('pia-likeness', inputs, {workflowRevision: 5});
  const cast = {id: 'alex', name: 'Alex', ageVariant: 'adult', important: true, references: photo ? [image(1)] : [], notes: 'ISOLATED', ...(mustKeep ? {mustKeep} : {})};
  p.artifacts.push({id: 'roster@1', key: 'roster', kind: 'roster', version: 1, digest: 'd', content: {characters: [cast]}, dependencies: [], valid: true, authoredBy: 'test',
    approvedBy: {message: 'ok', at: new Date().toISOString()}, review: {decision: 'approved', perception: 'direct-text', checks: []}});
  p.artifacts.push({id: 'script@1', key: 'script', kind: 'script', version: 1, digest: 's',
    content: {beats: [1, 2, 3, 4].map(i => ({beat: i, durationSeconds: 15, narration: 'x', emotionalPurpose: 'c', sourceAnswers: ['scene1Childhood']})), commonSenseChecks: []},
    dependencies: [], valid: true, authoredBy: 'test'});
  p.step = 'characterPrompt'; p.gate = 'author'; p.characterId = 'alex';
  return {p, cast};
}
const contentFor = (cast, prompt) => ({prompt, characterDigest: digest(cast), referenceHashes: cast.references.map(f => f.sha256), recipeSha256: characterRecipeSha256});
const photoPrompt = (labelLine) => `Stylized animated feature character sheet. Subject: the adult man in the attached photos. Match the face, likeness and skin tone of the attached reference photo exactly. ${labelLine} Wardrobe: navy shirt, mustard vest. Background: flat #B5B5B5. No text, labels, captions, expression names or watermarks anywhere in the image. Expressions in order: ${EIGHT_LIST}.`;

test('the fixed eight is the warmer set', () => {
  assert.deepEqual(FIXED_SHEET_EXPRESSIONS, WARM_EIGHT);
});

test('photo attached: each labelled face line from notes is rejected', () => {
  const {p, cast} = piaProject();
  for (const label of ['Face:', 'Eyes:', 'Eyebrows:', 'Skin:', 'Hair:']) {
    const content = contentFor(cast, photoPrompt(`${label} some written trait from notes.`));
    assert.throws(() => validateArtifactContent(p, content, 'pia'), /CHARACTER_PROMPT_PHOTO_LIKENESS_REQUIRED/, label);
  }
  assert.deepEqual(photoFaceLabels('Face: x\nEyes: y'), ['Face', 'Eyes']);
  assert.deepEqual(photoFaceLabels('Fully cover all hair; same likeness in every figure.'), []);
});

test('photo attached: match-the-photo prompt with the eight in order passes', () => {
  const {p, cast} = piaProject();
  const prompt = `Stylized animated feature character sheet. Subject: the adult man in the attached photos, approximately seven heads tall. Match the face, likeness and skin tone of the attached reference photo exactly; use the photos for the face only, adult proportions as written. Wardrobe: navy shirt, mustard vest, same in every figure. Materials: smooth matte stylised skin with gentle subsurface scattering, tactile fabrics with broad natural folds. Light: soft three-point studio lighting, even exposure. Top row: four full-body views, front, three-quarter, profile and back, at one height on one baseline. Below: eight portraits in two rows of four, in this order: ${EIGHT_LIST}. Background: flat #B5B5B5. No text, labels, captions, expression names or watermarks anywhere in the image.`;
  const content = contentFor(cast, prompt);
  assert.doesNotThrow(() => validateArtifactContent(p, content, 'pia'));
});

test('photo attached: covering and likeness words without labels pass', () => {
  const {p, cast} = piaProject({mustKeep: ['dusty-rose hijab']});
  const prompt = `Stylized sheet. Subject: the woman in the attached photo wearing a dusty-rose hijab. Match the face, likeness and skin tone of the attached reference photo exactly. Fully cover all hair and the entire neck in every turnaround and every portrait, including profile and back. Same likeness, age and outfit in every figure. Expressions in order: ${EIGHT_LIST}. Background: flat #B5B5B5. No text, labels, captions, expression names or watermarks anywhere in the image.`;
  assert.doesNotThrow(() => validateArtifactContent(p, contentFor(cast, prompt), 'pia'));
  assert.doesNotThrow(() => assertPromptPhotoLikeness(prompt, cast));
});

test('no photo: the full written face from notes still passes', () => {
  const {p, cast} = piaProject({photo: false});
  const prompt = `Stylized sheet. Subject: an adult man at an unspecified age. Face: broad square planes, strong jaw. Eyes: dark brown. Eyebrows: graphic, thick. Skin: rich deep brown, even natural colour. Hair: short tight coils. Wardrobe: navy shirt. Expressions in order: ${EIGHT_LIST}. Background: flat #B5B5B5. No text, labels, captions, expression names or watermarks anywhere in the image.`;
  assert.doesNotThrow(() => validateArtifactContent(p, contentFor(cast, prompt), 'pia'));
});

test('the old expression set no longer satisfies the rev 5 order check', () => {
  const {p, cast} = piaProject();
  const old = contentFor(cast, photoPrompt('').replace(EIGHT_LIST, 'neutral, happy, delighted, sad, surprised, confused, angry, talking'));
  assert.throws(() => validateArtifactContent(p, old, 'pia'), /SHEET_EXPRESSIONS_ORDER_REQUIRED/);
  const shuffled = contentFor(cast, photoPrompt('').replace('pure joy, thoughtful concentration', 'thoughtful concentration, pure joy'));
  assert.throws(() => validateArtifactContent(p, shuffled, 'pia'), /SHEET_EXPRESSIONS_ORDER_REQUIRED/);
});

test('photo on the cast entry: text-only prose face from the photo passes (Flow, nothing attached)', () => {
  const {p, cast} = piaProject();
  const prompt = `Create ONE complete cinematic stylized 3D animated-feature character model sheet of an adult man, approximately seven heads tall. His face is a broad square with a strong rounded jaw; his eyes are dark-brown ovals under thick straight black brows; his skin is a warm medium-brown, even natural colour; his hair is short black and wavy with no fringe. Wardrobe: navy shirt, mustard vest, same in every figure. Eight portraits in this order: ${EIGHT_LIST}. Background is flat #B5B5B5. No text, labels, captions, expression names or watermarks anywhere in the image.`;
  assert.doesNotThrow(() => validateArtifactContent(p, contentFor(cast, prompt), 'pia'));
});
