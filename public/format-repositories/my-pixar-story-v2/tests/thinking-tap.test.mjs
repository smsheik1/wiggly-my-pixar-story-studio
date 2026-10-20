// Display-only thinking tap: reasoning and visible text tails land in thinking.js; the stream passes through untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sseDeltas, thinkingTap, THINK_TAIL } from '../graph/thinking-tap.mjs';
import { observingFetch } from '../graph/deep-agent-node.mjs';
const ev = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n`;
const read = (dir) => { const w = {}; new Function('window', readFileSync(join(dir, 'thinking.js'), 'utf8'))(w); return w.WIGGLY_THINKING; };

test('sseDeltas reads reasoning, reasoning_content and content; ignores keepalives and [DONE]', () => {
  const d = sseDeltas([': OPENROUTER PROCESSING', ev({ reasoning: 'Theo ' }).trim(), ev({ reasoning_content: 'thinks' }).trim(), ev({ content: '{"a"' }).trim(), 'data: [DONE]']);
  assert.deepEqual(d, { reasoning: 'Theo thinks', content: '{"a"' });
});
test('tap joins events split across chunks, keeps only the tail, writes thinking.js', () => {
  const dir = mkdtempSync(join(tmpdir(), 'think-')), t = thinkingTap('story-director', { dir, everyMs: 0 });
  const s = ev({ reasoning: 'x'.repeat(THINK_TAIL) }) + ev({ reasoning: 'Gran waits.' }) + ev({ content: 'Draft' });
  t.feed(s.slice(0, 15)); t.feed(s.slice(15)); t.end();
  const w = read(dir);
  assert.equal(w.agent, 'story-director'); assert.equal(w.thinking.length, THINK_TAIL); assert.ok(w.thinking.endsWith('Gran waits.')); assert.equal(w.draft, 'Draft');
  assert.ok(readFileSync(join(dir, `thinking-story-director-${w.call}.txt`), 'utf8').endsWith('Gran waits.'));
});
test('observingFetch still passes the body through byte for byte with the tap on', async () => {
  process.env.WIGGLY_THINKING_DIR = mkdtempSync(join(tmpdir(), 'think-'));
  const body = ': keepalive\n' + ev({ reasoning: 'hm' }) + ev({ content: 'ok' });
  const f = observingFetch('story-director', async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }), () => {});
  assert.equal(await (await f('u', {})).text(), body);
  assert.equal(read(process.env.WIGGLY_THINKING_DIR).draft, 'ok');
  delete process.env.WIGGLY_THINKING_DIR;
});
