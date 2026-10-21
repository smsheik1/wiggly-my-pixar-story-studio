import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retimeSegments, attachPanels } from '../crew/seedance-compiler/input.mjs';
import { withPanels, makeAnimaticApprovalNode } from '../graph/graph.mjs';

const seg = { segmentId: 1, targetDurationSec: 15, shots: [
  { sceneId: '1.1', shotNumber: 1, startSec: 0, endSec: 5 }, { sceneId: '1.2', shotNumber: 2, startSec: 5, endSec: 9 }, { sceneId: '1.3', shotNumber: 3, startSec: 9, endSec: 15 }] };

test('SC input is retimed to the approved animatic cut (whole seconds, contiguous, no drift)', () => {
  const [s] = retimeSegments([seg], [{ shotId: '1.1', durationSec: 3.76 }, { shotId: '1.2', durationSec: 2.735 }, { shotId: '1.3', durationSec: 0.3 }]);
  assert.deepEqual(s.shots.map((x) => [x.startSec, x.endSec]), [[0, 4], [4, 6], [6, 7]]);
  assert.equal(s.targetDurationSec, 7);
  assert.deepEqual(retimeSegments([seg], []), [seg]);
});

test('approved panels ride on SC input shots and on each compiled clip', () => {
  const segs = attachPanels([seg], { '1.1': 'storyboard:1.1', '1.3': 'storyboard:1.3' });
  assert.equal(segs[0].shots[0].storyboardPanel, 'storyboard:1.1');
  assert.equal(segs[0].shots[1].storyboardPanel, undefined);
  const out = withPanels({ segments: [{ clipId: '1a', shots: [{ sceneId: '1.1' }, { sceneId: '1.2' }] }, { clipId: '1b', shots: [{ sceneId: '1.3' }] }] }, { segments: segs });
  assert.deepEqual(out.segments.map((c) => c.storyboardPanels), [{ '1.1': 'storyboard:1.1' }, { '1.3': 'storyboard:1.3' }]);
});

test('animatic approval freezes the approved (scratch-led) timings and panels, not the planned ones', async () => {
  const shotTimings = [{ shotId: '1.1', startSec: 0, endSec: 3.76, durationSec: 3.76 }];
  const r = await makeAnimaticApprovalNode()({ storyDirector: { segments: [seg] }, animaticApproval: { decision: 'approve', shotTimings, panels: { '1.1': 'storyboard:1.1' } } });
  assert.deepEqual(r.approvedShotTimings, shotTimings);
  assert.deepEqual(r.approvedPanels, { '1.1': 'storyboard:1.1' });
  const p = await makeAnimaticApprovalNode()({ storyDirector: { segments: [seg] }, animaticApproval: { decision: 'approve' } });
  assert.equal(p.approvedShotTimings[0].durationSec, 5);
});
