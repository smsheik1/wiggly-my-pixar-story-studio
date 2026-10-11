import { mkdtemp, copyFile, cp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { keyFor, current } from '../runtime/gates.mjs';

/**
 * Copy checkpoints.sqlite (plus -wal/-shm if present) to a temp dir and open with SqliteSaver.
 * Never modifies runDir files.
 */
export async function openRunCopy(runDir) {
  const tempDir = await mkdtemp(join(tmpdir(), 'r4-replay-'));
  const sourceDb = join(runDir, 'checkpoints.sqlite');
  const targetDb = join(tempDir, 'checkpoints.sqlite');
  await copyFile(sourceDb, targetDb);

  for (const ext of ['-wal', '-shm']) {
    try {
      await copyFile(sourceDb + ext, targetDb + ext);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  const saver = SqliteSaver.fromConnString(targetDb);
  return { saver, tempDir, targetDb };
}

/**
 * Async-iterate all checkpoints (newest first) and yield channel_values.project.
 */
export async function* projectStates(saver) {
  for await (const tuple of saver.list({ configurable: {} })) {
    const project = tuple.checkpoint?.channel_values?.project;
    if (project) {
      yield project;
    }
  }
}

/**
 * Find the latest project state matching key, gate, and optional version.
 */
export async function findState(states, { key, gate, version = null }) {
  // states can be an async iterator, an iterable, or an array
  for await (const p of states) {
    if (keyFor(p) === key && p.gate === gate) {
      if (version != null) {
        const cur = current(p) ?? p.artifacts?.findLast(a => a.key === key);
        if (cur && cur.version === version) {
          return p;
        }
      } else {
        return p;
      }
    }
  }
  return null;
}

/**
 * Extract all visual-reviewer review judgments from project history,
 * joined to its artifact (files, review.decision, checks, recommendation)
 * and to Shaz's later selection if approved.
 */
export function veraJudgments(project) {
  const judgments = [];
  const history = project.history ?? [];

  for (const entry of history) {
    if (entry.action === 'review' && entry.worker?.role === 'visual-reviewer') {
      const artifact = project.artifacts?.find(a => a.id === entry.artifactId);
      if (!artifact) continue;

      // Find if this artifact was approved later and get selection
      const approval = history.find(
        h => h.action === 'approve' && h.artifactId === entry.artifactId
      );
      const selection = approval?.selection ?? artifact.selection ?? null;

      judgments.push({
        historyEntry: entry,
        artifact,
        decision: artifact.review?.decision ?? entry.review?.decision ?? null,
        checks: artifact.review?.checks ?? entry.review?.checks ?? [],
        recommendation: artifact.review?.recommendation ?? entry.review?.recommendation ?? null,
        files: artifact.content?.files ?? [],
        step: artifact.kind,
        key: artifact.key,
        version: artifact.version,
        selection,
        approved: !!approval,
      });
    }
  }

  return judgments;
}
