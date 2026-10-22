// Named-secret loader (mirrors v1 scripts/studio-spike/tracing.ts). Values stay in memory; never logged.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const defaultSecretsPath = () => {
  if (process.env.WIGGLY_SECRETS_FILE) return process.env.WIGGLY_SECRETS_FILE;
  const p1 = join(homedir(), 'Documents/wiggly/secrets.env');
  if (existsSync(p1)) return p1;
  const p2 = join(homedir(), 'Projects/wiggly/secrets.env');
  if (existsSync(p2)) return p2;
  return p1;
};
export const NEEDED = (name) => name === 'OPENROUTER_API_KEY' || /^LANGSMITH_[A-Z_]+$/.test(name);

/** Load only the needed named keys into memory without leaking into global process.env. Returns {} if file is absent. */
export function loadSecrets(path = defaultSecretsPath(), want = NEEDED) {
  if (!existsSync(path)) return {};
  const orig = { ...process.env };
  try {
    process.loadEnvFile(path);
    const out = {};
    for (const [k, v] of Object.entries(process.env)) {
      if ((!(k in orig) || process.env[k] !== orig[k] || want === NEEDED) && want(k)) out[k] = v;
    }
    for (const k of Object.keys(process.env)) {
      if (!(k in orig)) delete process.env[k];
      else process.env[k] = orig[k];
    }
    return out;
  } catch {
    const out = {};
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m || !want(m[1])) continue;
      const v = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (v) out[m[1]] = v;
    }
    return out;
  }
}
