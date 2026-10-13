import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function probe(path) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]);
  const p = JSON.parse(stdout); const audio = p.streams.find(s => s.codec_type === 'audio');
  const image = p.streams.find(s => s.codec_type === 'video');
  if (['.mp4', '.mov'].includes(extname(path).toLowerCase()) && image) { const durationSeconds = Number(image.duration ?? p.format.duration); const [n,d] = image.avg_frame_rate.split('/').map(Number); if (!(durationSeconds>0 && n/d>0)) throw new Error('Unmeasurable video.'); return {durationSeconds,width:image.width,height:image.height,fps:n/d,hasAudio:!!audio}; }
  if (audio) { const durationSeconds = Number(p.format.duration ?? audio.duration); if (!(durationSeconds > 0)) throw new Error('Unmeasurable audio duration.'); return { durationSeconds }; }
  if (image?.width && image?.height) return { width: image.width, height: image.height };
  throw new Error('No supported audio/image stream.');
}
export async function importMedia(source, runDir) {
  const extension = extname(source).toLowerCase();
  if (!['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mov'].includes(extension)) throw new Error('Import a supported audio or image file.');
  const bytes = await readFile(resolve(source)); const sha256 = sha(bytes);
  const path = join(runDir, 'assets', `${sha256}${extension}`); await mkdir(join(runDir, 'assets'), { recursive: true });
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  if (sha(await readFile(path)) !== sha256) throw new Error('Immutable asset collision/tampering.');
  return { path, sha256, bytes: bytes.length, ...await probe(path) };
}
// Generation only appends silence. Local repair is a separate recorded edit; never silently trim here.
export async function narrationWindow(file, runDir, outputPath) {
  await verifyFiles(file);
  if(file.durationSeconds>15)return {file,tailSilenceSeconds:0};
  if(file.durationSeconds===15)return {file,tailSilenceSeconds:0};
  await exec('ffmpeg',['-v','error','-y','-i',file.path,'-af','apad=whole_dur=15','-t','15','-ar','44100','-c:a','pcm_s16le',outputPath]);
  const padded=await importMedia(outputPath,runDir);
  if(padded.durationSeconds!==15)throw new Error('NARRATION_WINDOW_MISMATCH: silence-only padding must produce exactly 15 seconds.');
  return {file:padded,tailSilenceSeconds:15-file.durationSeconds};
}
export async function verifyFiles(value) {
  if (!value || typeof value !== 'object') return;
  if(value.evidenceDirectory&&value.qualified===true&&value.datasetDigest){await (await import('../evaluation/audio-qualification.mjs')).verifyAudioQualificationEvidence(value);return;}
  if(value.evidenceDirectory&&value.datasetDigest&&value.predictionDigest){await (await import('../evaluation/visual-qualification.mjs')).verifyQualificationEvidence(value);return;}
  if (value.path && value.sha256 && value.bytes) {
    const bytes = await readFile(value.path);
    if (sha(bytes) !== value.sha256 || bytes.length !== value.bytes) throw new Error(`ASSET_CHANGED: ${value.path}`);
    const actual = await probe(value.path);
    for (const [k, v] of Object.entries(actual)) if (value[k] !== v) throw new Error(`MEDIA_METADATA_MISMATCH: ${value.path} ${k}`);
    return;
  }
  for (const child of Object.values(value)) await verifyFiles(child);
}
// Background plates are judged from the image itself, not only from the prompt wording.
// ffmpeg signalstats SATAVG is the mean chroma saturation of the decoded plate (8-bit
// scale, 0 = grey). r5's washed-out muted plates measured below 10; the floor is a
// minimum, never a target, and Vera still judges the look with her own eyes.
export const BACKGROUND_MIN_SATURATION = 12;
export function parseSaturation(stderr) {
  const m = [...String(stderr).matchAll(/SATAVG=([0-9.]+)/g)];
  if (!m.length) throw new Error('PALETTE_UNMEASURABLE: ffmpeg signalstats returned no SATAVG.');
  return Number(m.at(-1)[1]);
}
export async function measurePalette(file) {
  await verifyFiles(file);
  const { stderr } = await exec('ffmpeg', ['-hide_banner', '-nostats', '-i', file.path, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.SATAVG', '-f', 'null', '-'], { maxBuffer: 2 ** 22 });
  return { sha256: file.sha256, saturation: parseSaturation(stderr), method: 'ffmpeg signalstats SATAVG (mean saturation, 8-bit)' };
}
// A passing background review must not pick a plate that measures muted or washed out.
export function assertBackgroundPalette({ step, review, files, saturation }) {
  if (!['backgroundCandidates', 'backgroundAngle'].includes(step)) return;
  if (!['approved', 'provisional'].includes(review?.decision)) return;
  const index = step === 'backgroundCandidates' && files.length > 1 ? review.recommendation?.selection ?? 0 : 0;
  const value = saturation[index];
  if (!(value >= BACKGROUND_MIN_SATURATION)) throw new Error(`BACKGROUND_PALETTE_MUTED: option ${index} measures mean saturation ${Number(value).toFixed(1)}, below the ${BACKGROUND_MIN_SATURATION} floor for a Pixar feature-film set. Fail \`style\` for that option (or pick an option that measures above the floor) and repair the prompt toward a rich, saturated palette.`);
}
export function parseMeasureAudioOutput(stderr) {
  const silenceSeconds = [...stderr.matchAll(/silence_duration: ([0-9.]+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  const summaryPart = stderr.split('Summary:')[1] || '';
  const integratedMatch = summaryPart.match(/I:\s+([-\d.]+)\s+LUFS/);
  const peakMatch = summaryPart.match(/Peak:\s+([-\d.]+)\s+dBFS/);
  return {
    silenceSeconds,
    integratedLufs: integratedMatch ? Number(integratedMatch[1]) : undefined,
    truePeakDb: peakMatch ? Number(peakMatch[1]) : undefined
  };
}

export async function measureAudio(file) {
  await verifyFiles(file);
  const { stderr } = await exec('ffmpeg', ['-hide_banner', '-nostats', '-i', file.path, '-af', 'silencedetect=noise=-40dB:d=0.3,ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { maxBuffer: 2 ** 20 });
  const parsed = parseMeasureAudioOutput(stderr);
  return { path: file.path, sha256: file.sha256, durationSeconds: file.durationSeconds, ...parsed,
    method: 'ffprobe duration; ffmpeg silencedetect -40dB, minimum 0.3s; ebur128' };
}
