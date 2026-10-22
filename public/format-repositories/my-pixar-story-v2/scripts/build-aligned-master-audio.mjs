import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Video clip boundaries in the stitched video:
// Clip 1: 0 to 19.041667s
// Clip 2: 19.041667s to 49.083334s
// Clip 3: 49.083334s to 72.125000s
const CLIP1_DUR = 19.041667;
const CLIP2_DUR = 30.041667;
const CLIP3_DUR = 23.041667;
const TOTAL_DUR = CLIP1_DUR + CLIP2_DUR + CLIP3_DUR; // 72.125s

const RUN_DIR = '/Users/shaz/Projects/wiggly-my-pixar-story-studio/public/format-repositories/my-pixar-story-v2/runs/r6-live';
const SCRATCH_DIR = join(RUN_DIR, 'scratch');
const LINES_DIR = join(SCRATCH_DIR, 'lines');

const rep = JSON.parse(await readFile(join(SCRATCH_DIR, 'scratch-report.json'), 'utf8'));

// The 21 lines in linesDir:
// 01 to 07 = Act 1 (Shot 1.1 to 1.7)
// 08 to 14 = Act 2 (Shot 2.1 to 2.7)
// 15 to 21 = Act 3 (Shot 3.1 to 3.6)
const lines = [
  { file: '01-1.1-narration.wav', shot: '1.1', act: 1, relStart: 0 },
  { file: '02-1.2-dialogue.wav', shot: '1.2', act: 1, relStart: 3.68 },
  { file: '03-1.3-narration.wav', shot: '1.3', act: 1, relStart: 5.68 },
  { file: '04-1.4-narration.wav', shot: '1.4', act: 1, relStart: 7.44 },
  { file: '05-1.5-dialogue.wav', shot: '1.5', act: 1, relStart: 10.907 },
  { file: '06-1.6-narration.wav', shot: '1.6', act: 1, relStart: 12.03 },
  { file: '07-1.7-dialogue.wav', shot: '1.7', act: 1, relStart: 16.256 },

  { file: '08-2.1-narration.wav', shot: '2.1', act: 2, relStart: 0 },
  { file: '09-2.2-narration.wav', shot: '2.2', act: 2, relStart: 21.672 - 17.992 },
  { file: '10-2.3-narration.wav', shot: '2.3', act: 2, relStart: 27.112 - 17.992 },
  { file: '11-2.4-narration.wav', shot: '2.4', act: 2, relStart: 30.152 - 17.992 },
  { file: '12-2.5-narration.wav', shot: '2.5', act: 2, relStart: 33.838 - 17.992 },
  { file: '13-2.6-narration.wav', shot: '2.6', act: 2, relStart: 37.358 - 17.992 },
  { file: '14-2.7-narration.wav', shot: '2.7', act: 2, relStart: 42.718 - 17.992 },

  { file: '15-3.1-narration.wav', shot: '3.1', act: 3, relStart: 0 },
  { file: '16-3.2-narration.wav', shot: '3.2', act: 3, relStart: 51.291 - 48.567 },
  { file: '17-3.3-narration.wav', shot: '3.3', act: 3, relStart: 54.339 - 48.567 },
  { file: '18-3.4-narration.wav', shot: '3.4', act: 3, relStart: 58.875 - 48.567 },
  { file: '19-3.5-narration.wav', shot: '3.5', act: 3, relStart: 62.315 - 48.567 },
  { file: '20-3.6-narration.wav', shot: '3.6', act: 3, relStart: 66.315 - 48.567 },
  { file: '21-3.6-dialogue.wav', shot: '3.6', act: 3, relStart: 66.315 - 48.567 + 2.1 } // Wife with kiss SFX
];

const ACT_OFFSETS = {
  1: 0,
  2: CLIP1_DUR,
  3: CLIP1_DUR + CLIP2_DUR
};

const placed = lines.map((l) => {
  const absTime = ACT_OFFSETS[l.act] + l.relStart;
  return {
    ...l,
    path: join(LINES_DIR, l.file),
    absTime
  };
});

console.log('Placed lines count:', placed.length);
for (const p of placed) {
  console.log(`  Act ${p.act} | Shot ${p.shot} | ${p.file.padEnd(24)} -> ${p.absTime.toFixed(3)}s`);
}

// Build ffmpeg filter complex to mix all 21 lines at their exact absTime
const rate = 48000;
const ffmpegInputs = [];
const filterParts = [];
const mixInputs = [];

for (let i = 0; i < placed.length; i++) {
  const p = placed[i];
  ffmpegInputs.push('-i', p.path);
  const delayMs = Math.round(p.absTime * 1000);
  filterParts.push(`[${i}:a]aresample=${rate},aformat=channel_layouts=stereo,adelay=${delayMs}|${delayMs}[a${i}]`);
  mixInputs.push(`[a${i}]`);
}

filterParts.push(`${mixInputs.join('')}amix=inputs=${placed.length}:normalize=0:dropout_transition=0,apad,atrim=0:${TOTAL_DUR.toFixed(3)}[vo_clean]`);

const outWav = join(SCRATCH_DIR, 'aligned-cartesia-vo-master.wav');
const cmdArgs = [
  '-y',
  '-loglevel', 'error',
  ...ffmpegInputs,
  '-filter_complex', filterParts.join(';'),
  '-map', '[vo_clean]',
  '-c:a', 'pcm_s16le',
  '-ar', String(rate),
  outWav
];

console.log('Synthesizing aligned Cartesia master VO wav...');
execFileSync('ffmpeg', cmdArgs);
console.log('Generated aligned Cartesia master VO wav:', outWav);
