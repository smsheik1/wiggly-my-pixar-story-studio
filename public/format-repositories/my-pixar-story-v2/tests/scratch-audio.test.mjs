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

test('TTS transcript: terminal punctuation, hyphenated letters spoken as letters, no SSML', async () => {
  const { ttsTranscript } = await import('../scripts/lib/scratch-audio.mjs');
  assert.equal(ttsTranscript('I go first!'), 'I go first!');
  assert.equal(ttsTranscript('But it was mine'), 'But it was mine.');
  assert.equal(ttsTranscript('Because at that time in my life,'), 'Because at that time in my life,');
  assert.equal(ttsTranscript('The faded paint and no A-C.'), 'The faded paint and no A. C.');
  assert.equal(ttsTranscript('We watched T-V and Yugioh GX'), 'We watched T. V. and Yugioh GX.');
  assert.ok(!/</.test(ttsTranscript('Hi.')));
});

test('scratch-led timing: speech + beat, silent shots capped, holds kept, clips trimmed to speech', async () => {
  const { speechSpan, placeLines } = await import('../scripts/lib/scratch-audio.mjs');
  assert.deepEqual(speechSpan('silence_start: 0\nsilence_end: 0.12\nsilence_start: 0.9\nsilence_end: 1.1\nsilence_start: 2.6', 3), { leadSec: 0.12, speechSec: 2.48 });
  assert.deepEqual(speechSpan('', 2), { leadSec: 0, speechSec: 2 });
  const sd2 = { segments: [{ segmentId: 1, shots: [{ shotNumber: 1, startSec: 0, endSec: 6 }, { shotNumber: 2, startSec: 6, endSec: 11 }, { shotNumber: 3, startSec: 11, endSec: 16, hold: true }, { shotNumber: 4, startSec: 16, endSec: 20 }] }] };
  const lines = [{ shotId: '1.1', path: 'a.wav', speechSec: 2, leadSec: 0.1 }, { shotId: '1.1', path: 'b.wav', speechSec: 1, leadSec: 0 }, { shotId: '1.4', path: 'c.wav', speechSec: 3, leadSec: 0 }];
  const { timeline, placed, totalSec } = placeLines(sd2, lines);
  assert.deepEqual(timeline.map((t) => [t.shotId, t.durationSec, t.timelineStartSec]), [['1.1', 3.65, 0], ['1.2', 3, 3.65], ['1.3', 5, 6.65], ['1.4', 3.4, 11.65]]);
  assert.deepEqual(placed.map((l) => l.atSec), [0, 2.25, 11.65]);
  assert.equal(totalSec, 15.05);
  const fc = mixArgs(placed, totalSec, 'o.wav').join(' ');
  assert.ok(fc.includes('atrim=0.1:2.15') && !fc.includes('apad=pad_dur'));
});
