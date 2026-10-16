// LLM route for answer tracing: every model call goes through the OpenCode CLI.
// Never OpenRouter, never API keys, never secrets files.
import { spawn } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const OPENCODE_MODEL = 'opencode/muse-spark-1.3-contributor-free';
export const OPENCODE_ARGV = ['run', '-m', OPENCODE_MODEL, '--variant', 'xhigh', '--format', 'json'];
const TMP_PROMPT_BYTES = 100 * 1024;
export const RETRY_SUFFIX = 'Reply with JSON only.';

/** Strip ``` fences; take the first `{`..last `}`; JSON.parse. Throws SyntaxError. */
export function extractJson(text) {
  let s = String(text ?? '').replace(/```\w*\n?/g, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new SyntaxError(`no JSON object found in reply (first 200 chars: ${s.slice(0, 200)})`);
  }
  return JSON.parse(s.slice(start, end + 1));
}

function collectText(node, out) {
  if (Array.isArray(node)) {
    for (const x of node) collectText(x, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const k of ['text', 'result', 'output']) {
      if (typeof node[k] === 'string' && node[k]) out.push(node[k]);
    }
    for (const k of ['content', 'message', 'delta', 'data', 'event', 'payload']) {
      if (node[k] !== undefined) collectText(node[k], out);
    }
  }
}

/** Best-effort assistant text from `opencode run --format json` event output. */
export function assistantTextFromStream(stdout) {
  const raw = String(stdout ?? '');
  // OpenCode events: only {type:'text', part:{type:'text', text}} is the answer; reasoning/tool parts are not.
  const textParts = [];
  for (const line of raw.split('\n')) { try { const ev = JSON.parse(line); if (ev?.type === 'text' && typeof ev.part?.text === 'string') textParts.push(ev.part.text); } catch { /* not JSON */ } }
  if (textParts.length) return textParts.join('').trim();
  const parts = [];
  let parsed = false;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t);
      parsed = true;
      collectText(ev, parts);
    } catch {
      // Not a JSON line; ignored when other lines parse.
    }
  }
  if (!parsed) {
    try {
      collectText(JSON.parse(raw), parts);
      parsed = true;
    } catch {
      // Plain text output.
    }
  }
  return parts.join('').trim() || raw.trim();
}

function runOnce(prompt, { timeoutMs, spawnFn }) {
  return new Promise((resolve, reject) => {
    (async () => {
      let args = [...OPENCODE_ARGV, prompt];
      let tmpFile = null;
      if (Buffer.byteLength(prompt, 'utf8') > TMP_PROMPT_BYTES) {
        tmpFile = join(tmpdir(), `muse-prompt-${randomUUID()}.txt`);
        await writeFile(tmpFile, prompt, 'utf8');
        args = [...OPENCODE_ARGV, '-f', tmpFile];
      }
      let child;
      try {
        // No shell: the prompt travels as one argv element; child is the exact opencode PID.
        child = spawnFn('opencode', args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: tmpdir() }); // neutral cwd: the judge never sees the repo
      } catch (e) {
        reject(new Error(`opencode CLI spawn failed: ${e.message}. Is 'opencode' installed on PATH?`));
        return;
      }
      let done = false;
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        if (done) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        finish(() => reject(new Error(`opencode run timed out after ${timeoutMs}ms (killed PID ${child?.pid})`)));
      }, timeoutMs);
      const finish = (fn) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (tmpFile) rm(tmpFile, { force: true }).catch(() => {});
        fn();
      };
      child.stdout?.on('data', (d) => {
        out += d;
      });
      child.stderr?.on('data', (d) => {
        err += d;
      });
      child.on('error', (e) => {
        finish(() => reject(new Error(`opencode CLI failed: ${e.message}. Is 'opencode' installed on PATH?`)));
      });
      child.on('close', (code, signal) => {
        finish(() => {
          if (code === 0) resolve(assistantTextFromStream(out));
          else reject(new Error(`opencode run failed (exit ${code ?? signal}): ${String(err).slice(0, 500) || 'no stderr'}`));
        });
      });
    })().catch(reject);
  });
}

/**
 * One model call through the OpenCode CLI. Returns the final assistant text.
 * Validates the reply holds JSON (extractJson) with one retry appending
 * RETRY_SUFFIX; throws a clear error when opencode is missing, fails, or the
 * reply still is not JSON. Pass `spawnFn` to fake the child in tests.
 */
export async function museCall(prompt, { timeoutMs = 600000, spawnFn = spawn } = {}) {
  const first = await runOnce(prompt, { timeoutMs, spawnFn });
  try {
    extractJson(first);
    return first;
  } catch {
    // One retry on parse failure.
  }
  const second = await runOnce(`${prompt}\n${RETRY_SUFFIX}`, { timeoutMs, spawnFn });
  try {
    extractJson(second);
  } catch (e) {
    throw new Error(`opencode reply was not JSON after retry: ${e.message}`);
  }
  return second;
}
