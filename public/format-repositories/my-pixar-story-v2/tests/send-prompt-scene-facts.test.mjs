import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendPrompt, sendTimeTags } from '../crew/seedance-compiler/schema.mjs';
import { checkSceneFacts } from '../crew/linter/check-stage-play.mjs';
import { checkPatchScope } from '../crew/linter/patch-scope.mjs';

const seg = {
  compiledPrompt: '[REFERENCE MATERIALS]\n@Kid = a boy.\n@yard = a yard.\nEach reference is one person or one object and appears once.\n\n[SHOTS]\nSHOT 1 | 0–3s\nCamera: wide, eye level, static.\n@Kid waves.\n@Kid: {Hi there!}\nHard cut.\n\nSHOT 2 | 3–6s\nCamera: medium, eye level, static.\n@Narrator, voiceover: {It was summer.}\nHard cut.\n\n[EXCLUSIONS]\nThe only spoken words in the entire segment are the lines in braces.',
  references: [{ tag: '@Kid', assetKey: 'k' }, { tag: '@yard', assetKey: 'y' }],
  shots: [{ shotNumber: 1, sceneId: '1.1' }, { shotNumber: 2, sceneId: '1.2' }],
  storyboardPanels: { '1.1': 'storyboard:1.1', '1.2': 'storyboard:1.2' },
  generationPayload: { engine: 'seedance-2.5' },
};

test('Seedance 2.5 send format: panels labeled per shot after the element refs, double quotes, no audio ref', () => {
  const { prompt, images } = sendPrompt(seg, undefined, { storyboards: true });
  assert.deepEqual(images, ['k', 'y', 'storyboard:1.1', 'storyboard:1.2']);
  assert.match(prompt, /@Kid \[Image1\] =/);
  assert.match(prompt, /Storyboard frames \[Image3\] to \[Image4\]/);
  assert.match(prompt, /SHOT 1 \| 0–3s\nCamera: wide, eye level, static.\nComposition from \[Image3\]\./);
  assert.match(prompt, /SHOT 2 \| 3–6s\nCamera: medium[^\n]*\nComposition from \[Image4\]\./);
  assert.match(prompt, /@Kid: "Hi there!"/);
  assert.match(prompt, /lines in double quotes/);
  assert.doesNotMatch(prompt, /[{}]|Audio1/);
});
test('engines that take a narration file keep the [Audio1] tag', () => {
  assert.match(sendTimeTags(seg.compiledPrompt, seg.references, 'seedance-2.0-mini'), /\[Audio1\]/);
});

const sd = () => ({
  locations: [{ name: 'Front yard at dusk', description: 'Small front yard at dusk with an old pickup parked' }, { name: 'Pickup cab', description: 'Inside the old pickup cab, bright midday sun' }],
  segments: [{ segmentId: 1, scenes: [{ shots: [1, 2], present: [], props: ['old pickup parked by the fence'] }], shots: [
    { shotNumber: 1, location: 'Front yard at dusk', narration: { speaker: '@N', line: '{My red 1998 Ford pickup was everything.}' } },
    { shotNumber: 2, location: 'Pickup cab', narration: { speaker: '@N', line: '{I loved it.}' } }] }],
});
test('scene facts: the inside of a place shown at dusk keeps dusk; a line naming colour and make is carried into descriptions and props', () => {
  const codes = checkSceneFacts(sd()).map((i) => `${i.code} ${i.path}`);
  assert.ok(codes.includes('LOCATION_TIME_JUMP locations.1.description'));
  assert.ok(codes.includes('SPOKEN_DETAIL_NOT_SHOWN segments.0.scenes.0.props.0'));
  const ok = sd(); ok.locations[0].description = 'Small front yard at dusk with a red Ford pickup parked'; ok.locations[1].description = 'Inside the red Ford pickup cab at dusk';
  ok.segments[0].scenes[0].props = ['red Ford pickup parked by the fence'];
  assert.deepEqual(checkSceneFacts(ok), []);
  const later = sd(); later.locations[1].description = 'Inside the pickup cab the next morning, bright sun';
  assert.ok(!checkSceneFacts(later).some((i) => i.code === 'LOCATION_TIME_JUMP'));
});
test('a part patch may correct an existing location description, never its name', () => {
  const a = { ...sd(), shapeBar: {}, cast: [] }, b = JSON.parse(JSON.stringify(a));
  b.locations[1].description = 'Inside the pickup cab at dusk';
  assert.deepEqual(checkPatchScope(a, b, 'part:1'), []);
  b.locations[1].name = 'Cab';
  assert.ok(checkPatchScope(a, b, 'part:1').length > 0);
});

import { scopePatchIssues } from '../crew/linter/patch-scope.mjs';
test('patch gate answers for its target: pre-existing errors elsewhere and animatic-waived checks are warnings', () => {
  const t = { kind: 'part', id: 'part:2', segmentId: 2, si: 1 };
  const prior = [{ severity: 'error', code: 'PRESENT_NEVER_SEEN', path: 'segments.0.scenes.1.present' }, { severity: 'error', code: 'X', path: 'segments.3.shots.0' }];
  const now = [...prior, { severity: 'error', code: 'RUNTIME_OVER_TARGET', path: 'segments' }, { severity: 'error', code: 'Y', path: 'segments.1.shots.2' }, { severity: 'error', code: 'NEW', path: 'segments.4' }];
  const sev = (o) => Object.fromEntries(scopePatchIssues(now, { target: t, priorIssues: prior, ...o }).map((i) => [i.code, i.severity]));
  assert.deepEqual(sev({ animaticApproved: true }), { PRESENT_NEVER_SEEN: 'warning', X: 'warning', RUNTIME_OVER_TARGET: 'warning', Y: 'error', NEW: 'error' });
  assert.equal(sev({}).RUNTIME_OVER_TARGET, 'error', 'a new script-wide error still fails before the animatic is approved');
});

import { scopePlateIssues } from '../graph/patch.mjs';
test('LS patch gate: only re-authored plates must pass; errors on untouched plates are warnings', () => {
  const out = { locations: [{ settingName: 'A' }, { settingName: 'B' }] };
  const r = { issues: [{ severity: 'error', code: 'E', path: 'locations.0.promptText' }, { severity: 'error', code: 'E', path: 'locations.1.promptText' }] };
  const g = scopePlateIssues(r, out, { patch: { impact: { newLocations: [], changedLocations: ['B'] } } });
  assert.deepEqual(g.issues.map((i) => i.severity), ['warning', 'error']); assert.equal(g.isValid, false);
});
