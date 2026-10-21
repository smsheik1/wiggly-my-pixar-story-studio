import test from 'node:test';
import assert from 'node:assert/strict';
import { fullLookLine, splitPropState, finalizeShotBlock, fullPropNames, dedupeScale, finalizeClip } from '../crew/seedance-compiler/finalize.mjs';
import { heldPropStated } from '../crew/linter/shot-locks.mjs';

test('Look line carries the full approved outfit, near-duplicate hijab items merged', () => {
  assert.deepEqual(fullLookLine(['hijab fully covering the hair and hairline with no visible hair', 'green hijab fully covering the hair and hairline'], 'green hijab fully covering the hair and hairline, long green abaya'),
    ['green hijab fully covering the hair and hairline with no visible hair', 'long green abaya']);
  assert.deepEqual(fullLookLine(['red cap pushed back', 'blue t-shirt'], 'blue t-shirt, grey shorts, white sneakers, red cap pushed back'),
    ['red cap pushed back', 'blue t-shirt', 'grey shorts', 'white sneakers']);
  assert.deepEqual(fullLookLine(['grey hijab fully covering the hair and hairline', 'white hoodie'], 'white hoodie, black trousers, soft grey hijab'),
    ['soft grey hijab fully covering the hair and hairline', 'white hoodie', 'black trousers']);
});

test('prop state splits into name and state', () => {
  assert.deepEqual(splitPropState('black sedan with dented bumper parked by the gate'), { name: 'black sedan with dented bumper', rest: 'parked by the gate' });
  assert.deepEqual(splitPropState('marbles scattered across the floor'), { name: 'marbles', rest: 'scattered across the floor' });
});

test('actions name the prop plainly; a held prop is stated on the Props line', () => {
  const blk = 'SHOT 1 | 0–3s\nCamera: medium.\nOn screen: @Kid.\nProps: marbles scattered across the floor.\n@Kid clutches the marbles scattered across the floor to his chest.\nHard cut.';
  const out = finalizeShotBlock(blk, { props: ['marbles scattered across the floor'] });
  assert.match(out, /@Kid clutches the marbles to his chest\./);
  assert.match(out, /Props: marbles in @Kid's hands; more scattered across the floor\./);
  assert.ok(heldPropStated(out, 'marbles scattered across the floor'));
  const rest = finalizeShotBlock('SHOT 1 | 0–3s\nProps: marbles scattered across the floor.\n@Kid looks at the marbles scattered across the floor.\nHard cut.', { props: ['marbles scattered across the floor'] });
  assert.match(rest, /looks at the marbles\./);
  assert.match(rest, /Props: marbles scattered across the floor\./);
});

test('full prop name replaces bare head-noun mentions, once per line, never inside spoken lines or tags', () => {
  const n = ['black sedan with dented bumper'];
  assert.equal(fullPropNames('He waits by the old sedan, then pats the sedan.', n), 'He waits by the black sedan with dented bumper, then pats the sedan.');
  assert.equal(fullPropNames('beside the black sedan with dented bumper, then inside the black sedan with dented bumper.', n), 'beside the black sedan with dented bumper, then inside the sedan.');
  assert.equal(fullPropNames('tactile rug and faded sedan paint', ['red sedan with faded paint']), 'tactile rug and red sedan with faded paint');
  assert.equal(fullPropNames('@Dad: {My old sedan.}', n), '@Dad: {My old sedan.}');
  assert.equal(fullPropNames('inside @old_sedan_interior, the sedan interior plate', n), 'inside @old_sedan_interior, the sedan interior plate');
  assert.equal(fullPropNames('the black 2003 Ford Focus sedan with dents', ['black Ford Focus sedan with dents']), 'the black 2003 Ford Focus sedan with dents');
});

test('a Props line that already says the prop is in hand keeps the rest as "more …"', () => {
  const out = finalizeShotBlock("SHOT 1 | 0–3s\nProps: marbles in @Kid's hands; marbles scattered across the floor.\n@Kid holds the marbles.\nHard cut.", { props: ['marbles scattered across the floor'] });
  assert.match(out, /Props: marbles in @Kid's hands; more scattered across the floor\./);
});

test('scale stated once', () => {
  assert.equal(dedupeScale('@A is a child at 5 heads tall. @B is an adult at 7 heads tall. Toddler is 4 heads tall, child is 5 heads tall, adult is 7 heads tall. Costume stays fixed.'),
    '@A is a child at 5 heads tall. @B is an adult at 7 heads tall. Costume stays fixed.');
});

test('finalizeClip uses input outfits and scene props', () => {
  const seg = { shots: [{ shotNumber: 1, sceneId: '1.1', action: '@Kid grips the marbles scattered across the floor.' }], tenBlocks: {
    block3_goal: 'Kid by the sedan.', block5_shots: 'SHOT 1 | 0–3s\nOn screen: @Kid.\nLook @Kid: blue t-shirt.\nProps: marbles scattered across the floor.\n@Kid grips the marbles scattered across the floor.\nHard cut.', block10_maintainConsistency: 'x.' } };
  const input = { characters: [{ elementTag: '@Kid', mainOutfit: 'blue t-shirt, grey shorts, white sneakers' }], segments: [{ shots: [{ shotNumber: 1, sceneId: '1.1' }], scenes: [{ shots: [1], props: ['marbles scattered across the floor'] }] }] };
  const f = finalizeClip(seg, input);
  assert.match(f.tenBlocks.block5_shots, /Look @Kid: blue t-shirt; grey shorts; white sneakers\./);
  assert.match(f.tenBlocks.block5_shots, /Props: marbles in @Kid's hands; more scattered across the floor\./);
  assert.equal(f.shots[0].action, '@Kid grips the marbles.');
});
