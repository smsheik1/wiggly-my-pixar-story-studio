#!/usr/bin/env node
// Simple Flow Queue bridge for image generation between the operating agent and Google Flow runner (e.g. Grokbot).
// Supports local filesystem queues and Google Drive sync folders.
//
// Job structure:
//   <queueDir>/jobs/<jobId>/job.json
//   <queueDir>/jobs/<jobId>/refs/<filename>
// Completion signal:
//   <queueDir>/jobs/<jobId>/output.png + output.done (or atomic rename)
import { readFile, writeFile, mkdir, copyFile, readdir, access, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { checkPanelSize, paddingBands } from '../crew/storyboard-artist/style.mjs';
import { readGray } from './lib/panel-detect.mjs';

const G_DRIVE_DEFAULT = resolve(
  process.env.HOME || '',
  'Library/CloudStorage/GoogleDrive-shahzebsheikh54@gmail.com/My Drive/wiggly-flow'
);

export function resolveQueueDir(customDir) {
  if (customDir) return resolve(customDir.replace(/^~(?=$|\/)/, process.env.HOME || ''));
  if (process.env.WIGGLY_FLOW_QUEUE) return resolve(process.env.WIGGLY_FLOW_QUEUE.replace(/^~(?=$|\/)/, process.env.HOME || ''));
  if (existsSync(join(process.env.HOME || '', 'Library/CloudStorage/GoogleDrive-shahzebsheikh54@gmail.com/My Drive'))) {
    return G_DRIVE_DEFAULT;
  }
  return resolve('runs/flow-queue');
}

/** Emit a job to the queue directory, copying any local reference images into the job folder. */
export async function emitFlowJob({ jobId, runId, prompt, references = [], queueDir, metadata = {} }) {
  const dir = resolveQueueDir(queueDir);
  const jobDir = join(dir, 'jobs', jobId);
  const refsDir = join(jobDir, 'refs');
  await mkdir(refsDir, { recursive: true });

  const bundledRefs = [];
  for (const refPath of references) {
    const abs = resolve(refPath.replace(/^~(?=$|\/)/, process.env.HOME || ''));
    if (!existsSync(abs)) throw new Error(`emitFlowJob: reference file not found at ${abs}`);
    const name = basename(abs);
    const dest = join(refsDir, name);
    await copyFile(abs, dest);
    bundledRefs.push({ name, relPath: `refs/${name}` });
  }

  const job = {
    jobId,
    runId,
    prompt: String(prompt ?? '').trim(),
    references: bundledRefs,
    expectedOutput: 'output.png',
    doneSignal: 'output.done',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...metadata,
  };

  await writeFile(join(jobDir, 'job.json'), JSON.stringify(job, null, 2));
  await writeFile(join(jobDir, 'prompt.txt'), job.prompt + '\n');
  return { jobDir, job };
}

/** Check that a landed image satisfies basic integrity and panel rules. */
export function checkLandedImage(filePath, { isPanel = false } = {}) {
  const issues = [];
  if (!existsSync(filePath)) return { ok: false, issues: [{ code: 'FILE_MISSING', message: 'File does not exist' }] };

  try {
    const img = readGray(filePath, 960);
    if (!img.W || !img.H) {
      issues.push({ code: 'INVALID_IMAGE', message: 'Could not read image dimensions' });
      return { ok: false, issues };
    }
    if (isPanel) {
      issues.push(...checkPanelSize({ width: img.W, height: img.H }));
      const pad = paddingBands(img.gray, img.w, img.h);
      if (pad.padded) {
        issues.push({ code: 'PANEL_PADDED', message: `Low-detail bands on ${pad.flagged.join(', ')}` });
      }
    }
    return { ok: issues.length === 0, width: img.W, height: img.H, issues };
  } catch (err) {
    return { ok: false, issues: [{ code: 'IMAGE_READ_ERROR', message: err.message }] };
  }
}

/**
 * Wait for a job to complete in the queue directory.
 * Looks for output.png + output.done, or output.png directly once writes finish.
 */
export async function waitForFlowJob(jobId, { queueDir, timeoutMs = 300_000, pollIntervalMs = 3000, isPanel = false } = {}) {
  const dir = resolveQueueDir(queueDir);
  const jobDir = join(dir, 'jobs', jobId);
  const outputFile = join(jobDir, 'output.png');
  const doneFile = join(jobDir, 'output.done');
  const t0 = Date.now();

  while (Date.now() - t0 < timeoutMs) {
    const hasDone = existsSync(doneFile);
    const hasOut = existsSync(outputFile);

    if (hasDone || hasOut) {
      // Small settle check to ensure no in-flight write
      const s1 = await stat(outputFile).then((s) => s.size, () => 0);
      if (s1 > 1000) {
        await new Promise((r) => setTimeout(r, 1000));
        const s2 = await stat(outputFile).then((s) => s.size, () => 0);
        if (s1 === s2) {
          const check = checkLandedImage(outputFile, { isPanel });
          if (!check.ok) {
            const reason = check.issues.map((i) => `${i.code}: ${i.message}`).join(', ');
            await writeFile(join(jobDir, 'rejected.json'), JSON.stringify({ rejectedAt: new Date().toISOString(), reason, issues: check.issues }, null, 2));
            throw new Error(`Flow job ${jobId} landed output failed validation: ${reason}`);
          }
          return { ok: true, outputPath: outputFile, width: check.width, height: check.height };
        }
      }
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  await writeFile(join(jobDir, 'timeout.json'), JSON.stringify({ timedOutAt: new Date().toISOString(), timeoutMs }, null, 2));
  throw new Error(`Flow job ${jobId} timed out after ${Math.round(timeoutMs / 1000)}s waiting in ${jobDir}`);
}
