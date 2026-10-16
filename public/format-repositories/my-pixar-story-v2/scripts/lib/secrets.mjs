// Named-secret loader (mirrors v1 scripts/studio-spike/tracing.ts). Values stay in memory; never logged.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const defaultSecretsPath = () => process.env.WIGGLY_SECRETS_FILE || join(homedir(), 'Projects/wiggly/secrets.env');
export const NEEDED = (name) => name === 'OPENROUTER_API_KEY' || /^LANGSMITH_[A-Z_]+$/.test(name);

/** Load only the needed named keys (OPENROUTER_API_KEY, LANGSMITH_*). Returns {} if the file is absent. */
export function loadSecrets(path = defaultSecretsPath(), want = NEEDED) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !want(m[1])) continue;
    const v = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (v) out[m[1]] = v;
  }
  return out;
}
