import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptViewHtml, upsertScriptView, SCRIPT_START } from '../scripts/lib/script-view.mjs';
import { applyScriptView } from '../scripts/script-view.mjs';

const sd = JSON.parse(readFileSync(new URL('../benchmarks/r4-dry6/outputs/story-director.json', import.meta.url), 'utf8'));
const text = (h) => h.replace(/<[^>]+>/g, ' ');

test('script view: title, cast, parts with runtime, shot cards with quotes; no JSON or field names', { timeout: 10000 }, () => {
  const h = scriptViewHtml(sd); const t = text(h);
  assert.ok(t.includes(sd.masthead.title.replace(/'/g, "'")) || h.includes('Scientist'));
  assert.ok(t.includes('Part 1:') && t.includes('Part 3:') && t.includes('(30s)'));
  assert.ok(t.includes('Cast') && t.includes('Shaz (32)') && t.includes('Mom'));
  assert.ok(h.includes('“') && t.includes('narrates (voiceover)') && t.includes('camera holds still'));
  assert.ok(t.includes('On screen:'));
  for (const bad of ['whatWeSee', 'cameraMove', 'elementTag', '"speaker"', '{"', '@DadShaz', '{We met']) assert.ok(!h.includes(bad), bad);
});
test('missing output renders a note; upsert puts it after the report h1 and replaces on rerun', { timeout: 10000 }, () => {
  assert.ok(scriptViewHtml(null).includes('No Story Director output'));
  const base = '<body><h1>v2 run report</h1><p>x</p></body>';
  const once = upsertScriptView(base, scriptViewHtml(sd)); const twice = upsertScriptView(once, scriptViewHtml(sd));
  assert.equal(once, twice); assert.ok(once.indexOf(SCRIPT_START) < once.indexOf('<p>x</p>'));
  const tr = upsertScriptView('<body><h1>Old</h1><!-- v2-dry-run:start --><!-- v2-dry-run:end --></body>', 'S', { report: false });
  assert.ok(tr.indexOf('S') < tr.indexOf('v2-dry-run:start'));
});
test('applyScriptView patches report.html and tracker from the run outputs', { timeout: 10000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-sv-'));
  try {
    mkdirSync(join(root, 'r', 'outputs'), { recursive: true });
    writeFileSync(join(root, 'r', 'outputs', 'story-director.json'), JSON.stringify(sd));
    writeFileSync(join(root, 'r', 'report.html'), '<body><h1>v2 run report</h1></body>');
    const tr = join(root, 't.html'); writeFileSync(tr, '<body><!-- v2-dry-run:start --><!-- v2-dry-run:end --></body>');
    applyScriptView({ runId: 'r', runsRoot: root, trackerPath: tr });
    assert.ok(readFileSync(join(root, 'r', 'report.html'), 'utf8').includes(SCRIPT_START));
    assert.ok(readFileSync(tr, 'utf8').includes(SCRIPT_START));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
