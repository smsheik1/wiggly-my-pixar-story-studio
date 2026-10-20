// Storyboard sheets and the HTML deck are built in code from the Story Director JSON (scripts/lib/sd-render.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildStoryboardSheets, buildScriptDeckHtml, withRenderedArtifacts, personInPanel, SHEET_OPENING, SHEET_LAYOUT, emptyPanelLine } from '../scripts/lib/sd-render.mjs';
import { parseStagePlay, StoryDirectorOutputSchema, StoryboardSheetSchema } from '../crew/story-director/schema.mjs';
import { validateStoryDirectorOutput } from '../crew/linter/check-stage-play.mjs';

const good = () => JSON.parse(readFileSync(new URL('./fixtures/good-stage-play.json', import.meta.url), 'utf8'));
const bare = () => { const d = good(); delete d.storyboardSheets; delete d.htmlScriptDocument; return d; };
const sbErrors = (d) => validateStoryDirectorOutput(d).issues.filter((i) => i.severity === 'error' && /STORYBOARD|SKIN_TONE_IN_PANEL|IMAGE_ENGINE|EYES_HIDDEN/.test(i.code));

test('the model no longer writes storyboardSheets or htmlScriptDocument (not in the submit schema)', () => {
  assert.ok(!('storyboardSheets' in StoryDirectorOutputSchema.shape) && !('htmlScriptDocument' in StoryDirectorOutputSchema.shape));
  assert.equal(StoryDirectorOutputSchema.safeParse(bare()).success, true);
});
test('parse builds both in code and replaces any model-written copies', () => {
  const p = parseStagePlay(bare());
  assert.equal(p.storyboardSheets.length, 2); assert.match(p.htmlScriptDocument, /^<!doctype html>/);
  const withOld = good(); withOld.htmlScriptDocument = '<p>stale</p>'.repeat(50);
  assert.deepEqual(parseStagePlay(withOld).htmlScriptDocument, p.htmlScriptDocument);
  assert.deepEqual(parseStagePlay(withOld).storyboardSheets, p.storyboardSheets);
});
test('sheets: one per part, eight panel lines, every shot once in order, labels, single line, schema-valid, gate-clean', () => {
  const d = bare(); const sheets = buildStoryboardSheets(d);
  assert.deepEqual(sheets.map((s) => [s.segmentId, s.panels.map((x) => x.shotNumberRef)]), [[1, [1, 2, 3, 4, 5, 6]], [2, [1, 2, 3]]]);
  for (const s of sheets) {
    assert.equal(StoryboardSheetSchema.safeParse(s).success, true);
    assert.ok(s.fullPrompt.includes(SHEET_OPENING) && s.fullPrompt.includes(SHEET_LAYOUT) && !/[\r\n]/.test(s.fullPrompt));
    assert.equal([...s.fullPrompt.matchAll(/Panel (\d+)(, labelled "\d+\.\d+":| \[empty\]:)/g)].length, 8);
  }
  assert.ok(sheets[1].fullPrompt.includes('Panel 3, labelled "2.3":') && sheets[1].fullPrompt.includes(emptyPanelLine(8)));
  assert.deepEqual(sbErrors(d), []);
  assert.deepEqual(sbErrors(parseStagePlay(d)), []);
});
test('a part over 8 shots continues on a second sheet', () => {
  const d = bare(); const s0 = d.segments[0].shots;
  d.segments[0].shots = Array.from({ length: 11 }, (_, i) => ({ ...s0[i % s0.length], shotNumber: i + 1, startSec: i * 2, endSec: i * 2 + 2, dialogue: undefined, narration: undefined }));
  assert.deepEqual(buildStoryboardSheets(d).map((s) => [s.segmentId, s.panels.map((x) => x.shotNumberRef)]), [[1, [1, 2, 3, 4, 5, 6, 7, 8]], [1, [9, 10, 11]], [2, [1, 2, 3]]]);
  assert.deepEqual(sbErrors(d), []);
});
test('panels name skin tone and worn items for everyone on screen, by name, never @tags; empty frames pass', () => {
  const d = bare(); const [s1] = buildStoryboardSheets(d);
  const p1 = s1.panels[0].whatIsInFrame;
  assert.match(p1, /Shaz, an 8-year-old boy with warm medium brown skin/); assert.match(p1, /Sister, an 18-year-old young woman with light warm brown skin/);
  assert.match(p1, /sunglasses pushed up on his forehead/); assert.match(p1, /grey hijab/); assert.ok(!/@\w/.test(s1.fullPrompt));
  assert.match(personInPanel(d.cast[2]), /yellow hoodie strings/);
  assert.equal((personInPanel(d.cast[1]).match(/hijab/g) ?? []).length, 1, 'an item already in the description is not repeated');
  d.segments[0].shots[4].onScreen = []; d.segments[0].scenes = d.segments[0].scenes; // nobody in frame
  const empty = buildStoryboardSheets(d)[0].panels[4];
  assert.match(empty.whatIsInFrame, /^No people in frame\./);
  assert.ok(!validateStoryDirectorOutput(d).issues.some((i) => i.code === 'MISSING_SKIN_TONE_IN_PANEL'));
});
test('deck says what the JSON says: title, every shot, every line, names not tags, totals', () => {
  const d = bare(); const html = buildScriptDeckHtml(d);
  assert.ok(html.includes('Fraunces') && html.includes('Karla') && html.includes('Space+Mono') && html.includes('#E4E6D9') && html.includes('#C33A2C'));
  assert.ok(html.includes(d.masthead.title));
  for (const seg of d.segments) for (const h of seg.shots) {
    assert.ok(html.includes(`SHOT ${h.shotNumber} | ${h.startSec}–${h.endSec}s`));
    for (const k of ['dialogue', 'narration']) if (h[k]) assert.ok(html.includes(h[k].line.replace(/[&<>"']/g, '')), h[k].line);
  }
  assert.ok(!/@[A-Z]\w*(?!\w*<\/span>)/.test(html.replace(/<span class="mono muted">@\w+<\/span>/g, '')));
  assert.match(html, /Draft 1 · 9 shots · 46s/);
  assert.equal(withRenderedArtifacts(null), null);
});
