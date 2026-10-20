import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scratchLines, estimateUsd, oddities, overruns, mixArgs } from '../scripts/lib/scratch-audio.mjs';
const sd = { segments: [{ segmentId: 1, shots: [{ shotNumber: 1, startSec: 0, endSec: 4, narration: { speaker: '@N', line: '{Hello there.}' } }, { shotNumber: 2, startSec: 4, endSec: 6, dialogue: { speaker: '@K', line: '{Me first!}' } }] },
  { segmentId: 2, shots: [{ shotNumber: 1, startSec: 0, endSec: 3 }] }] };
test('scratchLines: braces stripped, absolute timeline start, shot length', () => {
  assert.deepEqual(scratchLines(sd).map((l) => [l.shotId, l.kind, l.speaker, l.text, l.atSec, l.shotSec]), [['1.1', 'narration', '@N', 'Hello there.', 0, 4], ['1.2', 'dialogue', '@K', 'Me first!', 4, 2]]);
  assert.ok(Math.abs(estimateUsd(scratchLines(sd)) - 21 * 65e-6) < 1e-9);
});
test('oddities + overruns', () => {
  assert.deepEqual(oddities('a 2000 car, no A/C, watched GX & more'), ['abbreviation "A/C"', 'abbreviation "GX"', 'symbol "/"', 'symbol "&"', 'number "2000"']);
  assert.deepEqual(overruns([{ shotId: '1.1', durSec: 5.3, shotSec: 4 }, { shotId: '1.2', durSec: 1.9, shotSec: 2 }]), [{ shotId: '1.1', overSec: 1.3, durSec: 5.3, shotSec: 4 }]);
});
test('mixArgs: delays in ms, no normalisation, exact total', () => {
  const a = mixArgs([{ path: 'a.wav', atSec: 0 }, { path: 'b.wav', atSec: 4.5 }], 9, 'm.wav');
  const fc = a[a.indexOf('-filter_complex') + 1];
  assert.ok(fc.includes('adelay=4500:all=1') && fc.includes('amix=inputs=2:normalize=0') && fc.includes('atrim=0:9'));
});
