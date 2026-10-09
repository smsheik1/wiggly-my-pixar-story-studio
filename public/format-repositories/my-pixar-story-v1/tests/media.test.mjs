import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMeasureAudioOutput } from '../runtime/media.mjs';

export async function test() {
  const fixturePath = join(new URL('.', import.meta.url).pathname, 'fixtures/ffmpeg-ebur128.txt');
  const stderr = readFileSync(fixturePath, 'utf8');

  // Test parseMeasureAudioOutput
  const parsed = parseMeasureAudioOutput(stderr);
  
  assert.equal(parsed.integratedLufs, -19.5);
  assert.equal(parsed.truePeakDb, -1.2);
  assert.equal(parsed.silenceSeconds, 0); // No silence in this fixture

  // Test with silence
  const stderrWithSilence = stderr + '\n[silencedetect @ 0x123] silence_start: 1.0\n[silencedetect @ 0x123] silence_end: 2.5 | silence_duration: 1.5\n[silencedetect @ 0x123] silence_duration: 0.5\n';
  const parsedWithSilence = parseMeasureAudioOutput(stderrWithSilence);
  assert.equal(parsedWithSilence.silenceSeconds, 2.0);
}
