#!/usr/bin/env node
// Add the readable Script view to runs/<id>/report.html (top) and the progress tracker. No model calls.
// Usage: node scripts/script-view.mjs --run <id> [--no-tracker]
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUNS_ROOT } from '../graph/deep-agent-node.mjs';
import { defaultTrackerPath } from './lib/report.mjs';
import { readableViewsHtml, upsertScriptView } from './lib/script-view.mjs';

const put = (path, section, report) => { if (!existsSync(path)) return false; writeFileSync(`${path}.tmp`, upsertScriptView(readFileSync(path, 'utf8'), section, { report })); renameSync(`${path}.tmp`, path); return true; };
export function applyScriptView({ runId, runsRoot = RUNS_ROOT, trackerPath = defaultTrackerPath() }) {
  const read = (a) => { const f = join(runsRoot, runId, 'outputs', `${a}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };
  const section = readableViewsHtml({ sd: read('story-director'), ca: read('character-architect'), ls: read('location-scout'), sc: read('seedance-compiler') });
  put(join(runsRoot, runId, 'report.html'), section, true);
  if (trackerPath) { try { put(trackerPath, section, false); } catch { /* optional */ } }
  return section;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  if (!arg('--run')) { console.error('usage: script-view.mjs --run <id>'); process.exitCode = 1; }
  else { applyScriptView({ runId: arg('--run'), ...(process.argv.includes('--no-tracker') ? { trackerPath: null } : {}) }); console.log(`script view added to runs/${arg('--run')}/report.html`); }
}
