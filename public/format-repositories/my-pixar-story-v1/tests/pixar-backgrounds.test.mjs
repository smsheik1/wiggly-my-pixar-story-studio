// r5 issue #2: backgrounds didn't look Pixar. Guards the restored house style, the
// non-muted set palette, the film accent as a prop colour (never a light) and the
// image-based palette measurement on background reviews.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseSaturation, measurePalette, assertBackgroundPalette, BACKGROUND_MIN_SATURATION } from '../runtime/media.mjs';
import { BibleContent, FILM_ACCENT_LIGHT } from '../runtime/bible.mjs';

globalThis.fetch = () => { throw new Error('FETCH_PROHIBITED in pixar-backgrounds.test.mjs'); };
const kit = new URL('..', import.meta.url).pathname;
const read = p => readFileSync(join(kit, p), 'utf8');
const rule = (doc, id) => doc.split('\n').find(l => l.startsWith(`- [${id}]`)) ?? '';

test('house style names the Pixar look; brand names stay out of prompts only', () => {
  const guide = read('craft-guide.md');
  assert.match(rule(guide, 'H-STYLE'), /Pixar-style 3D animated feature film/);
  assert.match(rule(guide, 'H-STYLE'), /never muted/);
  assert.match(rule(guide, 'H-NO-BRANDS'), /image or video prompt/);
  assert.match(rule(guide, 'H-NO-BRANDS'), /Briefs, the bible and reviews may name the Pixar target look/);
});

test('sets are never muted, in the guide and in Beau, Theo, Vera and Sage', () => {
  const guide = read('craft-guide.md');
  for (const id of ['L-PALETTE', 'L-SETS-DEFAULT']) {
    assert.doesNotMatch(rule(guide, id), /^- \[[A-Z-]+\] \([^)]*\) (Lived-in, story-dressed sets in a )?[Mm]uted palette/);
    assert.match(rule(guide, id), /saturated/);
  }
  assert.match(rule(guide, 'L-PALETTE'), /muted, washed-out or desaturated room fails/);
  const locations = guide.split('## [locations]')[1].split('\n## ')[0];
  assert.doesNotMatch(locations, /Palette: muted/);
  for (const p of ['crew/beau/SKILL.md', 'crew/theo/SKILL.md', 'crew/vera/SKILL.md', 'crew/sage/steps/backgroundBrief.md', 'crew/sage/steps/backgroundPrompt.md', 'crew/sage/steps/backgroundAngleBrief.md', 'crew/sage/steps/backgroundAnglePrompt.md', 'evaluation/rubrics/visual.md', 'evaluation/rubrics/text.md']) {
    const doc = read(p);
    assert.doesNotMatch(doc, /palette (is|that isn't) muted with one saturated accent|muted palette with one saturated accent/i, p);
    assert.doesNotMatch(doc, /never fail a room for being muted/i, p);
  }
  assert.match(read('crew/beau/SKILL.md'), /never a muted or washed-out room/);
  assert.match(read('crew/theo/SKILL.md'), /never write "muted"/);
});

test('the film accent is a prop colour and can never be a light', () => {
  for (const c of ['warm amber lamplight', 'golden sunlight', 'soft lamp glow', 'candlelight orange'])
    assert.match(c, FILM_ACCENT_LIGHT, c);
  for (const c of ['cobalt blue', 'deep green', 'sunflower yellow', 'burnt orange', 'light-fast red'.replace('light-fast ', '')])
    assert.doesNotMatch(c, FILM_ACCENT_LIGHT, c);
  const shape = BibleContent.shape.filmAccent.unwrap();
  assert.equal(shape.safeParse({ colour: 'cobalt blue', keyProp: 'trading cards' }).success, true);
  const bad = shape.safeParse({ colour: 'warm amber lamplight', keyProp: 'desk lamp' });
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad.error.issues), /FILM_ACCENT_IS_LIGHT/);
  assert.match(rule(read('craft-guide.md'), 'L-ACCENT-OUT'), /never a light/);
});

test('palette parser reads ffmpeg signalstats SATAVG and refuses silence', () => {
  assert.equal(parseSaturation('frame:0 pts:0\nlavfi.signalstats.SATAVG=23.8364\n'), 23.8364);
  assert.equal(parseSaturation('SATAVG=1\nSATAVG=9.5'), 9.5);
  assert.throws(() => parseSaturation('no stats'), /PALETTE_UNMEASURABLE/);
});

test('background reviews cannot approve a plate that measures muted', () => {
  const files = [{}, {}, {}], low = BACKGROUND_MIN_SATURATION - 3, high = BACKGROUND_MIN_SATURATION + 10;
  const approved = selection => ({ decision: 'approved', recommendation: { selection, ranking: [selection], reason: 'r' } });
  assert.throws(() => assertBackgroundPalette({ step: 'backgroundCandidates', review: approved(1), files, saturation: [high, low, high] }), /BACKGROUND_PALETTE_MUTED: option 1/);
  assert.doesNotThrow(() => assertBackgroundPalette({ step: 'backgroundCandidates', review: approved(0), files, saturation: [high, low, high] }));
  assert.throws(() => assertBackgroundPalette({ step: 'backgroundAngle', review: { decision: 'provisional' }, files: [{}], saturation: [low] }), /BACKGROUND_PALETTE_MUTED/);
  assert.doesNotThrow(() => assertBackgroundPalette({ step: 'backgroundCandidates', review: { decision: 'rejected' }, files, saturation: [low, low, low] }));
  assert.doesNotThrow(() => assertBackgroundPalette({ step: 'sheet', review: approved(0), files, saturation: [0, 0, 0] }));
});

test('measurePalette measures the actual image: grey plate below the floor, colourful plate above', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pixar-bg-'));
  try {
    const make = (name, filter) => {
      const path = join(dir, name);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', filter, '-frames:v', '1', path]);
      const bytes = readFileSync(path);
      return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, width: 320, height: 180 };
    };
    const grey = make('grey.png', 'color=c=0x9a9690:s=320x180');
    const rich = make('rich.png', 'testsrc2=s=320x180');
    return Promise.all([measurePalette(grey), measurePalette(rich)]).then(([g, r]) => {
      assert.ok(g.saturation < BACKGROUND_MIN_SATURATION, `grey ${g.saturation}`);
      assert.ok(r.saturation > BACKGROUND_MIN_SATURATION, `rich ${r.saturation}`);
      assert.equal(g.sha256, grey.sha256);
    }).finally(() => rmSync(dir, { recursive: true, force: true }));
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
});

test('crew review path measures every background plate and enforces the floor', () => {
  const crew = read('runtime/crew.mjs');
  assert.match(crew, /worker\.role==='visual-reviewer'&&\['backgroundCandidates','backgroundAngle'\]\.includes\(task\.step\)/);
  assert.match(crew, /files\.map\(f=>measurePalette\(f\)\)/);
  assert.match(crew, /paletteSaturation:saturation/);
  assert.match(crew, /assertBackgroundPalette\(\{step:task\.step,review:event\.review,files,saturation\}\)/);
});

test('brand names never reach an image or video prompt', async () => {
  const { PROMPT_BRAND_TERMS } = await import('../runtime/contracts.mjs');
  assert.match('A Pixar-style bedroom', PROMPT_BRAND_TERMS);
  assert.match('like Toy Story', PROMPT_BRAND_TERMS);
  assert.doesNotMatch('Stylized 3D animated feature film set, appealing sculpted forms, rich saturated colour', PROMPT_BRAND_TERMS);
  assert.match(read('runtime/workflow.mjs'), /PROMPT_BRAND_TERMS\.test\(plan\.parameters\.prompt\)\) throw new Error\(`PROMPT_BRAND_NAME/);
});
