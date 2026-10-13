// r5: an old loop kept running for ~10 hours after the run ended, and failed
// calls left dispatches marked 'started'. When a run reaches done (or stops),
// find leftover processes and 'started' dispatches, close or flag them, and
// record the result in the run's final status.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
const exec = promisify(execFile);

export async function listProcesses() {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 8 * 2 ** 20 });
  return stdout.split('\n').map(l => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}

// Processes whose command line names this run directory, excluding this
// process and its ancestors (the caller that is finishing the run).
export function runProcesses(processes, runDir, selfPid = process.pid) {
  const dir = resolve(runDir), byPid = new Map(processes.map(p => [p.pid, p])), ancestors = new Set();
  for (let pid = selfPid, guard = 0; pid && guard < 64; guard++) { ancestors.add(pid); pid = byPid.get(pid)?.ppid; }
  return processes.filter(p => !ancestors.has(p.pid) && (p.command.includes(dir + ' ') || p.command.endsWith(dir) || p.command.includes(dir + '/')));
}

export async function startedDispatches(runDir) {
  const dir = join(runDir, 'host-dispatch'); let names;
  try { names = await readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const name of names.filter(n => /^[0-9a-f]{64}\.json$/.test(n))) {
    try { const receipt = JSON.parse(await readFile(join(dir, name), 'utf8')); if (receipt?.status === 'started') out.push({ path: join(dir, name), taskId: receipt.taskId ?? null, receipt }); } catch {}
  }
  return out;
}

// close=true (run is done): SIGTERM leftover processes and mark leftover
// 'started' dispatches 'abandoned'. close=false (run stopped mid-way): flag only.
export async function endOfRunCheck({ runDir, close = false, now = new Date(), list = listProcesses, kill = (pid, sig) => process.kill(pid, sig), selfPid = process.pid } = {}) {
  const procs = runProcesses(await list(), runDir, selfPid), dispatches = await startedDispatches(runDir);
  const processes = [], openDispatches = [];
  for (const p of procs) {
    let action = 'flagged';
    if (close) { try { kill(p.pid, 'SIGTERM'); action = 'terminated'; } catch (e) { action = e.code === 'ESRCH' ? 'already-exited' : `kill-failed:${e.code ?? e.message}`; } }
    processes.push({ pid: p.pid, command: p.command.slice(0, 300), action });
  }
  for (const d of dispatches) {
    let action = 'flagged';
    if (close) { await writeFile(d.path, JSON.stringify({ ...d.receipt, status: 'abandoned', abandonedAt: now.toISOString(), abandonedReason: 'END_OF_RUN: dispatch still marked started when the run finished.' }, null, 2), { mode: 0o600 }); action = 'closed'; }
    openDispatches.push({ path: d.path, taskId: d.taskId, action });
  }
  const result = { checkedAt: now.toISOString(), mode: close ? 'close' : 'flag', clean: !processes.length && !openDispatches.length, processes, dispatches: openDispatches };
  await writeFile(join(runDir, 'end-of-run.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  return result;
}
