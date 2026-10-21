// House storyboard style: canonical file matches code, shot-size mix gate, panel output spec, padding detector, panel prompts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shotFamily, checkShotMix, checkPanelSize, paddingBands, PANEL_IMAGE, DEFAULT_PANEL_MODEL, STYLE_FILE } from '../crew/storyboard-artist/style.mjs';
import { PANEL_HEAD, PANEL_TAIL, compilePanels } from '../crew/storyboard-artist/compile.mjs';
import { readGray } from '../scripts/lib/panel-detect.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (sizes) => sizes.map((s, i) => ({ shotId: `1.${i + 1}`, shotSizeAndAngle: `${s}, eye level` }));
const codes = (iss) => iss.map((i) => i.code).sort();

test('canonical style file carries the exact prompt blocks, output spec and default model the code uses', () => {
  const md = readFileSync(join(root, STYLE_FILE), 'utf8');
  assert.ok(md.includes(PANEL_HEAD), 'PANEL_HEAD verbatim'); assert.ok(md.includes(PANEL_TAIL), 'PANEL_TAIL verbatim');
  assert.ok(md.includes(DEFAULT_PANEL_MODEL) && /16:9/.test(md) && /1920/.test(md) && /2K/.test(md) && /<part>\.<shot>\.png/.test(md));
  assert.deepEqual({ ...PANEL_IMAGE }, { engine: 'nano-banana-2.1', aspect: '16:9', resolution: '2K', minWidth: 1920 });
  assert.match(readFileSync(join(root, 'crew/storyboard-artist/role.md'), 'utf8'), /storyboard-style\.md/);
});
test('style text is generic: no family names or user-specific details', () => {
  const t = [STYLE_FILE, 'crew/storyboard-artist/style-anchors/README.md', 'crew/storyboard-artist/style.mjs'].map((f) => readFileSync(join(root, f), 'utf8')).join('\n');
  for (const w of ['Shaz', 'Mia', 'Yu-Gi-Oh', 'Yugioh', 'Accord', 'hijab', 'Dallas', 'Chicago']) assert.ok(!t.includes(w), w);
});
test('shotFamily: house vocabulary', () => {
  assert.deepEqual(['Wide shot', 'Medium wide shot', 'Full shot', 'Medium shot', 'Two-shot', 'Over-the-shoulder', 'Medium close-up', 'Close-up', 'Extreme close-up', 'Insert of the keys', 'Establishing shot', 'Dutch'].map(shotFamily),
    ['wide', 'full', 'full', 'medium', 'medium', 'medium', 'close', 'close', 'insert', 'insert', 'wide', 'unknown']);
});
test('checkShotMix: the r5 pattern (all medium) fails; the old-sheet ladder passes', () => {
  assert.deepEqual(codes(checkShotMix(P(['Medium shot', 'Medium shot', 'Medium shot', 'Wide shot', 'Medium shot', 'Medium shot']))), ['SB_NO_CLOSE', 'SB_ONE_SIZE', 'SB_SIZE_RUN']);
  assert.deepEqual(checkShotMix(P(['Wide shot', 'Full shot', 'Medium two-shot', 'Close-up', 'Full shot', 'Medium shot', 'Medium close-up', 'Medium two-shot'])), []);
  assert.deepEqual(codes(checkShotMix(P(['Wide shot', 'Wide shot', 'Close-up']))), ['SB_TOO_MANY_WIDE']);
  assert.deepEqual(codes(checkShotMix(P(['Dutch', 'Close-up']))), ['SB_SHOT_SIZE_UNKNOWN']);
  assert.deepEqual(checkShotMix(P(['Medium shot', 'Medium shot'])), []); // short parts are free
});
test('checkPanelSize: native 16:9 at 1920+ only', () => {
  for (const [w, h] of [[1920, 1080], [2752, 1536], [2560, 1440]]) assert.deepEqual(checkPanelSize({ width: w, height: h }), [], `${w}x${h}`);
  assert.deepEqual(codes(checkPanelSize({ width: 1536, height: 1152 })), ['PANEL_LOW_RES', 'PANEL_NOT_16_9']);
  assert.deepEqual(codes(checkPanelSize({ width: 1376, height: 768 })), ['PANEL_LOW_RES']);
  assert.deepEqual(codes(checkPanelSize({ width: 2048, height: 1152 * 1.1 })), ['PANEL_NOT_16_9']);
});
test('paddingBands + check-panels.mjs: a 4:3 image blur-padded to 1920x1080 is rejected; a full-bleed frame passes', () => {
  const d = mkdtempSync(join(tmpdir(), 'sbstyle-'));
  const src = ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080', '-frames:v', '1'];
  execFileSync('ffmpeg', ['-v', 'error', ...src, join(d, '1.1.png')]);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1440x1080', '-frames:v', '1', '-filter_complex', '[0:v]split[a][b];[a]scale=1920:1080,boxblur=40:2[bg];[bg][b]overlay=240:0', join(d, '1.2.png')]);
  const g1 = readGray(join(d, '1.1.png'), 960), g2 = readGray(join(d, '1.2.png'), 960);
  assert.equal(paddingBands(g1.gray, g1.w, g1.h).padded, false); assert.equal(paddingBands(g2.gray, g2.w, g2.h).padded, true);
  const r = (() => { try { execFileSync('node', [join(root, 'scripts/check-panels.mjs'), '--dir', d], { stdio: 'pipe' }); return 0; } catch (e) { return { code: e.status, out: String(e.stdout) }; } })();
  assert.equal(r.code, 1); assert.match(r.out, /1\.1\.png\s+1920x1080\s+ok/); assert.match(r.out, /1\.2\.png\s+1920x1080\s+PANEL_PADDED/);
});
test('compilePanels: one 16:9 2K prompt per shot = style block + Shot slots + tail, own references only', () => {
  const input = { characters: [{ tag: '@Kid', imageTag: '@Image 1', name: 'Kid', age: 8, gender: 'male', skinTone: 'warm brown' }, { tag: '@Sib', imageTag: '@Image 2', name: 'Sib', age: 16, gender: 'female', skinTone: 'warm brown' }],
    locations: [{ tag: '@Loc 1', settingName: 'Kitchen' }, { tag: '@Loc 2', settingName: 'Garage' }] };
  const pc = (tag) => ({ tag, wardrobe: 'red t-shirt', props: [], pose: 'leans in', expression: 'grins' });
  const out = { sheets: [{ segmentId: 1, panels: [
    { panelNumber: 1, shotId: '1.1', locationTag: '@Loc 1', shotSizeAndAngle: 'Wide shot, eye level', characters: [pc('@Kid'), pc('@Sib')], staging: 'Kid left, Sib right', lightAndPalette: 'bright morning daylight' },
    { panelNumber: 2, shotId: '1.2', locationTag: '@Loc 1', shotSizeAndAngle: 'Close-up, low angle', characters: [pc('@Sib')], staging: 'centre', lightAndPalette: 'bright morning daylight' }] }] };
  const [a, b] = compilePanels(out, input);
  assert.equal(a.file, '1.1.png'); assert.equal(a.aspect, '16:9'); assert.equal(a.resolution, '2K'); assert.equal(a.engine, 'nano-banana-2.1');
  assert.ok(a.fullPrompt.startsWith(PANEL_HEAD + ' Shot: Wide shot, eye level. Background: Kitchen (reference image 3).') && a.fullPrompt.endsWith(PANEL_TAIL));
  assert.ok(!/Panel \d of the sheet/.test(a.fullPrompt));
  assert.deepEqual(b.references.map((r) => [r.tag, r.position]), [['@Sib', 1], ['@Loc 1', 2]]);
  assert.match(b.fullPrompt, /Sib \(reference image 1\)/);
});
