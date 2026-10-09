import { spawn } from 'node:child_process';
import { readdir, stat, readFile, copyFile, unlink, mkdir } from 'node:fs/promises';
import { join, resolve, dirname, basename, extname } from 'node:path';
import { homedir } from 'node:os';

export const AGY_DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
export const AGY_MIN_MEGAPIXELS = 0.5;
export const AGY_ASPECT_TOLERANCE = 0.05;

export const agyBinary = () => process.env.WIGGLY_AGY_BIN || 'agy';
export const agyBrainDir = () => resolve(process.env.WIGGLY_AGY_BRAIN_DIR || join(homedir(), '.gemini', 'antigravity-cli', 'brain'));
export const agyTimeoutMs = () => Number(process.env.WIGGLY_AGY_TIMEOUT_MS || AGY_DEFAULT_TIMEOUT_MS);

export function buildAgyPrompt({ prompt, aspectRatio, imageName, imagePaths, outputPath }) {
  const refs = (imagePaths ?? []).map(p => `"${p}"`).join(', ');
  return `Call the built-in generate_image tool with Prompt=${JSON.stringify(prompt)}, AspectRatio=${JSON.stringify(aspectRatio)}, ImageName=${JSON.stringify(imageName)}, ImagePaths=[${refs}]. Then copy the resulting generated image file to ${JSON.stringify(outputPath)} (absolute path). Reply only with that absolute path.`;
}

export function parseImageDimensions(buffer) {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    if (!(width > 0 && height > 0)) throw new Error('Invalid PNG dimensions.');
    return { format: 'png', width, height };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = buffer.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        return { format: 'jpeg', width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
    throw new Error('Invalid JPEG dimensions.');
  }
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') {
      const w = buffer.readUInt16LE(26) & 0x3fff, h = buffer.readUInt16LE(28) & 0x3fff;
      return { format: 'webp', width: w, height: h };
    }
    if (chunk === 'VP8L') {
      const b = buffer.readUInt32LE(21);
      return { format: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      return { format: 'webp', width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
    }
    throw new Error('Invalid WebP dimensions.');
  }
  throw new Error('Unknown image format (expected PNG/JPEG/WebP).');
}

export function aspectRatioValue(aspect) {
  const [w, h] = aspect.split(':').map(Number);
  if (!(w > 0 && h > 0)) throw new Error(`Unknown aspect ratio ${aspect}.`);
  return w / h;
}

export function verifyAgyImage(buffer, aspectRatio) {
  const { format, width, height } = parseImageDimensions(buffer);
  const megapixels = (width * height) / 1e6;
  if (megapixels < AGY_MIN_MEGAPIXELS) throw new Error(`Invalid agy image: ${width}x${height} below ~0.5 MP.`);
  const expected = aspectRatioValue(aspectRatio), actual = width / height;
  if (Math.abs(actual - expected) / expected > AGY_ASPECT_TOLERANCE) throw new Error(`Invalid agy image: aspect ${width}x${height} off by >5% from ${aspectRatio}.`);
  return { format, width, height };
}

async function walkImages(dir, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return out; throw e; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walkImages(full, out);
    else if (['.png', '.jpg', '.jpeg', '.webp'].includes(extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

export async function findBrainFallback({ brainDir, startedAt, imageName }) {
  const candidates = await walkImages(brainDir);
  const scored = [];
  for (const path of candidates) {
    let mtime;
    try { mtime = (await stat(path)).mtimeMs; } catch { continue; }
    if (!(mtime >= startedAt)) continue;
    scored.push({ path, mtime });
  }
  if (!scored.length) return null;
  const named = imageName ? scored.filter(s => basename(s.path).includes(imageName)) : [];
  const pool = named.length ? named : scored;
  pool.sort((a, b) => b.mtime - a.mtime);
  return pool[0].path;
}

function runAgy({ bin, argv, timeoutMs, cwd }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      rejectPromise(new Error(`agy binary not found at ${bin}: ${e.message}`));
      return;
    }
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      rejectPromise(new Error(`agy timed out after ${timeoutMs}ms; process killed, no retry submitted.`));
    }, timeoutMs);
    child.on('error', err => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rejectPromise(new Error(`agy binary not found at ${bin}: ${err.message}`));
    });
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.slice(-800) || stdout.slice(-800) || `exit ${code}`;
        rejectPromise(new Error(`agy exited ${code}: ${tail}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

// One image via the local agy CLI. Never retries; throws on every failure.
export async function generateAgyImage({ prompt, aspectRatio, imageName, imagePaths = [], outputPath, brainDir, bin, timeoutMs }) {
  const resolvedBin = bin ?? agyBinary();
  const resolvedBrain = brainDir ?? agyBrainDir();
  const resolvedTimeout = timeoutMs ?? agyTimeoutMs();
  const absOutput = resolve(outputPath);
  await mkdir(dirname(absOutput), { recursive: true });
  const startedAt = Date.now();
  const agyPrompt = buildAgyPrompt({ prompt, aspectRatio, imageName, imagePaths: imagePaths.map(p => resolve(p)), outputPath: absOutput });
  const argv = ['-p', agyPrompt, '--dangerously-skip-permissions', '--add-dir', dirname(absOutput), '--output-format', 'json'];
  await runAgy({ bin: resolvedBin, argv, timeoutMs: resolvedTimeout, cwd: dirname(absOutput) });
  let source = null;
  try {
    const st = await stat(absOutput);
    if (st.isFile()) source = absOutput;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let brainCopy = null;
  if (!source) {
    brainCopy = await findBrainFallback({ brainDir: resolvedBrain, startedAt, imageName });
    if (!brainCopy) throw new Error('agy produced no image: requested output missing and no new brain image found.');
    source = brainCopy;
  } else {
    // Prefer the requested path, but still track a brain copy for cleanup when it matches.
    const fallback = await findBrainFallback({ brainDir: resolvedBrain, startedAt, imageName });
    if (fallback) brainCopy = fallback;
  }
  const buffer = await readFile(source);
  verifyAgyImage(buffer, aspectRatio);
  // If the source was the brain fallback, materialize the requested output path.
  let usedBrainFile = null;
  if (source !== absOutput) {
    await copyFile(source, absOutput);
    usedBrainFile = source;
  }
  // Delete only the brain file actually used, never anything else, never outside the brain dir.
  const toDelete = usedBrainFile ?? (brainCopy && brainCopy !== absOutput ? (source === absOutput ? null : null) : null);
  // When output path was used directly, optionally clean the sibling brain copy only if it is the same bytes? Spec says delete only the file it used.
  // So delete usedBrainFile when we copied from brain; otherwise delete nothing.
  if (usedBrainFile) {
    const resolved = resolve(usedBrainFile), root = resolve(resolvedBrain);
    if (resolved === root || !resolved.startsWith(root + '/')) throw new Error('Refusing to delete outside the agy brain dir.');
    await unlink(resolved);
  }
  return { outputPath: absOutput, brainCleaned: usedBrainFile };
}
