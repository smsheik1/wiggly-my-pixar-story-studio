import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hard safety: network calls prohibited
globalThis.fetch = () => { throw new Error('FETCH_PROHIBITED: Network calls are forbidden in guard tests.'); };

// Hard safety: 60s unref file guard
const fileGuard = setTimeout(() => {
  console.error('GUARD_TIMEOUT: 60s file guard triggered in p17-event-examples.test.mjs');
  process.exit(1);
}, 60000);
fileGuard.unref();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const kitDir = resolve(__dirname, '..');

const { Event } = await import('../runtime/contracts.mjs');
const eventActions = new Set(Event.shape.action.options);
const actionRe = new RegExp(`"action"\\s*:\\s*"(${[...eventActions].join('|')})"`);

function mdFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) mdFiles(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function eventFencesWithoutIds(content) {
  const bad = [];
  for (const m of content.matchAll(/```json([\s\S]*?)```/g)) {
    const fence = m[1];
    if (!actionRe.test(fence)) continue;
    if (!/"taskId"\s*:/.test(fence) || !/"actor"\s*:/.test(fence)) bad.push(fence.trim().slice(0, 120));
  }
  return bad;
}

test('P17 SPEC4: every Event JSON example with an action key carries taskId and actor', { timeout: 20000 }, async () => {
  // P18: the theo/beau/sage crew examples now carry taskId and actor, so crew
  // skills are no longer exempt.
  const bad = [];
  for (const f of mdFiles(kitDir)) {
    const rel = relative(kitDir, f);
    const missing = eventFencesWithoutIds(readFileSync(f, 'utf8'));
    for (const b of missing) bad.push({ file: rel, fence: b });
  }
  assert.deepEqual(bad, [], `Event examples must carry taskId and actor: ${JSON.stringify(bad)}`);
});
