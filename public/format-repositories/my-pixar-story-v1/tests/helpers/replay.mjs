import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const runnerPath = join(root, '..', '..', 'runner.mjs');

export async function replayCassette(dir, options = {}) {
  const args = [runnerPath, 'replay', '--cassette', dir];
  if (options.expectSameOutput) {
    args.push('--expect-same-output');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, WIGGLY_TRACING: 'off' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const trimmed = stdout.trim();
        const jsonResult = trimmed ? JSON.parse(trimmed) : null;
        resolve({
          exitCode: code,
          stdout,
          stderr,
          result: jsonResult
        });
      } catch (err) {
        resolve({
          exitCode: code,
          stdout,
          stderr,
          error: err
        });
      }
    });
  });
}
