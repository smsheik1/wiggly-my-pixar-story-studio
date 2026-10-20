// Display only: tails of each model call's streamed reasoning and visible text for the live progress page.
// Reads only the SSE response body (never headers or requests). Off when WIGGLY_THINKING_DIR=off.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const THINK_TAIL = 2000;
const dirOf = () => process.env.WIGGLY_THINKING_DIR ?? (process.env.NODE_TEST_CONTEXT ? 'off' : join(homedir(), 'wiggly-progress'));
let calls = 0;

/** Pull reasoning and content deltas out of complete SSE `data:` lines. */
export function sseDeltas(lines) {
  let reasoning = '', content = '';
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    try {
      const d = JSON.parse(line.slice(5)).choices?.[0]?.delta ?? {};
      if (typeof d.reasoning === 'string') reasoning += d.reasoning;
      else if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
      if (typeof d.content === 'string') content += d.content;
    } catch { /* [DONE] or partial */ }
  }
  return { reasoning, content };
}

/** One tap per call: feed(text) with decoded chunks; writes thinking.js (and a per-call .txt) at most every `everyMs`. */
export function thinkingTap(agent, { dir = dirOf(), everyMs = 1000, now = Date.now } = {}) {
  if (dir === 'off') return { feed() {}, end() {} };
  const call = ++calls, st = { reasoning: '', content: '' };
  let buf = '', last = 0;
  const write = () => {
    try {
      mkdirSync(dir, { recursive: true });
      const data = { agent, call, updated: new Date().toISOString(), thinking: st.reasoning, draft: st.content };
      writeFileSync(join(dir, `thinking-${agent}-${call}.txt`), st.reasoning);
      writeFileSync(join(dir, 'thinking.js'), `window.WIGGLY_THINKING=${JSON.stringify(data)};`);
    } catch { /* display only: never break the call */ }
  };
  return {
    call,
    feed(text) {
      buf += text; const lines = buf.split('\n'); buf = lines.pop();
      const d = sseDeltas(lines);
      if (d.reasoning) st.reasoning = (st.reasoning + d.reasoning).slice(-THINK_TAIL);
      if (d.content) st.content = (st.content + d.content).slice(-THINK_TAIL);
      if ((d.reasoning || d.content) && now() - last >= everyMs) { last = now(); write(); }
    },
    end() { write(); },
    state: st,
  };
}
