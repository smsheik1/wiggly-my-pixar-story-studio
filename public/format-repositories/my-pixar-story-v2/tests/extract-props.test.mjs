import test from 'node:test';
import assert from 'node:assert/strict';
import { extractHeroProps, isHeroProp } from '../crew/prop-architect/extract-props.mjs';

test('isHeroProp identifies vehicles, instruments, sentimental items', () => {
  assert.equal(isHeroProp('the 2000 Honda Accord Coupe with faded paint'), true);
  assert.equal(isHeroProp('acoustic guitar resting on the stand'), true);
  assert.equal(isHeroProp('framed ultrasound photo on nightstand'), true);
  assert.equal(isHeroProp('coffee mug on table'), false);
});

test('extractHeroProps extracts hero props from stagePlay scenes', () => {
  const fakePlay = {
    segments: [
      {
        segmentId: 1,
        scenes: [
          { props: ['pile of Yugioh cards spread on rug'] }
        ]
      },
      {
        segmentId: 2,
        scenes: [
          { props: ['the 2000 Honda Accord Coupe parked in driveway', 'regular coffee cup'] }
        ]
      }
    ]
  };

  const props = extractHeroProps(fakePlay);
  assert.equal(props.length, 2);
  assert.equal(props[0].propTag, '@Prop 1');
  assert.equal(props[1].propTag, '@Prop 2');
  assert.match(props[1].name, /Honda Accord/i);
  assert.match(props[1].assetKey, /honda-accord/);
});
