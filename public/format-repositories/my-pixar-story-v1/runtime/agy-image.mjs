import { spawn } from 'node:child_process';
import { readdir, stat, readFile, copyFile, unlink, mkdir, rename } from 'node:fs/promises';
import { join, resolve, dirname, basename, extname } from 'node:path';
import { homedir } from 'node:os';

export const AGY_DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
export const AGY_MIN_MEGAPIXELS = 0.5;
export const AGY_ASPECT_TOLERANCE = 0.05;

export const agyBinary = () => process.env.WIGGLY_AGY_BIN || 'agy';
export const agyBrainDir = () => resolve(process.env.WIGGLY_AGY_BRAIN_DIR || join(homedir(), '.gemini', 'antigravity-cli', 'brain'));
// agy writes its own CLI logs next to the brain dir; image-tool quota errors only appear there when agy exits 0.
export const agyLogDir = () => resolve(process.env.WIGGLY_AGY_LOG_DIR || join(dirname(agyBrainDir()), 'log'));
export const agyTimeoutMs = () => Number(process.env.WIGGLY_AGY_TIMEOUT_MS || AGY_DEFAULT_TIMEOUT_MS);

export function buildAgyPrompt({ prompt, aspectRatio, imageName, imagePaths, outputPath }) {
  const refs = (imagePaths ?? []).map(p => JSON.stringify(p)).join(', ');
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

export const agyNameStem = name => String(name).replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();

// Quota/capacity failures and policy refusals (AGY_POLICY_REFUSED) are eligible for the meta-muse fallback.
export function isAgyQuotaError(text) {
  // A bare 429 is not enough: agy logs unrelated MCP/OAuth 429s (Cloudflare 1015) on normal runs.
  return /resource_exhausted|exhausted your capacity|quota will reset/i.test(String(text ?? ''));
}

export function parseAgyQuotaReset(text) {
  const s = String(text ?? '');
  let m = /try again (?:at|in|after) ([^.]+?)\s*(?:\.|$)/i.exec(s);
  if (m) return m[1].trim() || null;
  m = /quota will reset[^0-9A-Za-z]*([0-9][^.]*?)\s*(?:\.|$)/i.exec(s);
  if (m) return m[1].trim() || null;
  m = /resets? (?:at|in|after) ([^.]+?)\s*(?:\.|$)/i.exec(s);
  if (m) return m[1].trim() || null;
  return null;
}

// Real agy quota exhaustion: the image tool fails with 429 RESOURCE_EXHAUSTED inside agy,
// agy still exits 0 and no image is written. The only record is agy's CLI log, e.g.
// "E1009 00:08:10 ... generate_image.go:167] error generating image: ... 429 Too Many Requests, body: {...RESOURCE_EXHAUSTED...}".
// Return the newest such block written since startedAt (whitespace-collapsed, bounded), or null.
export async function agyImageErrorFromLogs({ logDir = agyLogDir(), startedAt }) {
  let names;
  try { names = await readdir(logDir); } catch { return null; }
  let found = null, foundAt = -1;
  for (const name of names) {
    if (!/^cli-.*\.log$/.test(name)) continue;
    const path = join(logDir, name);
    let st;
    try { st = await stat(path); } catch { continue; }
    if (!st.isFile() || !(st.mtimeMs >= startedAt) || st.size > 20 * 1024 * 1024) continue;
    const lines = (await readFile(path, 'utf8')).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/generate_image[^\]]*\].*error generating image/i.test(lines[i])) continue;
      if (st.mtimeMs >= foundAt) { found = lines.slice(i, i + 16).join(' ').replace(/\s+/g, ' ').slice(0, 600); foundAt = st.mtimeMs; }
    }
  }
  return found;
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
  // agy names files <ImageName with non-alphanumerics as '_'>_<timestamp>.<ext>.
  const stem = imageName ? agyNameStem(imageName) : null;
  const named = stem ? scored.filter(s => basename(s.path).toLowerCase().startsWith(stem)) : [];
  const pool = named.length ? named : scored;
  pool.sort((a, b) => b.mtime - a.mtime);
  return pool[0].path;
}

export const AGY_POLICY_REFUSAL = /prohibited use policy|sensitive words|could not be submitted/i;
const tail = (v, n = 2000) => { const t = String(v ?? ''); return t.length > n ? t.slice(-n) : t; };
// Bounded, parsed agy output for traces and receipts on any failure.
export function agyDiagnostics({ stdout = '', stderr = '', exitCode = null } = {}) {
  let parsed = null;
  try { parsed = JSON.parse(String(stdout).trim()); } catch {}
  return { conversationId: parsed?.conversation_id ?? null, status: parsed?.status ?? null, response: typeof parsed?.response === 'string' ? parsed.response.slice(0, 2000) : null, exitCode, stdoutTail: tail(stdout), stderrTail: tail(stderr) };
}

function runAgy({ bin, argv, timeoutMs, cwd }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(bin, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      rejectPromise(new Error(`agy binary not found at ${bin}: ${e.message}`));
      return;
    }
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      const err = new Error(`agy timed out after ${timeoutMs}ms; process killed, no retry submitted.`); err.agyDiagnostics = agyDiagnostics({ stdout, stderr, exitCode: null }); rejectPromise(err);
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
        const err = new Error(`agy exited ${code}: ${tail}`); err.agyDiagnostics = agyDiagnostics({ stdout, stderr, exitCode: code }); rejectPromise(err);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

// One image via the local agy CLI. Never retries; throws on every failure.
export async function generateAgyImage({ prompt, aspectRatio, imageName, imagePaths = [], outputPath, brainDir, bin, timeoutMs, logDir }) {
  const resolvedBin = bin ?? agyBinary();
  const resolvedBrain = brainDir ?? agyBrainDir();
  const resolvedTimeout = timeoutMs ?? agyTimeoutMs();
  const absOutput = resolve(outputPath);
  await mkdir(dirname(absOutput), { recursive: true });
  const startedAt = Date.now();
  const agyPrompt = buildAgyPrompt({ prompt, aspectRatio, imageName, imagePaths: imagePaths.map(p => resolve(p)), outputPath: absOutput });
  const argv = ['-p', agyPrompt, '--sandbox', '--dangerously-skip-permissions', '--add-dir', dirname(absOutput), '--output-format', 'json'];
  const run = await runAgy({ bin: resolvedBin, argv, timeoutMs: resolvedTimeout, cwd: dirname(absOutput) });
  const diagnostics = agyDiagnostics({ ...run, exitCode: 0 });
  let source = null;
  try {
    const st = await stat(absOutput);
    if (st.isFile()) source = absOutput;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // The brain copy is identified by its ImageName stem only; never guess at
  // unrelated newer brain files when the requested output already exists.
  const named = await findBrainFallback({ brainDir: resolvedBrain, startedAt, imageName });
  const brainCopy = named && basename(named).toLowerCase().startsWith(agyNameStem(imageName)) ? named : null;
  if (!source) {
    source = brainCopy ?? await findBrainFallback({ brainDir: resolvedBrain, startedAt, imageName: null });
    if (!source) {
      const reported = await agyImageErrorFromLogs({ logDir: logDir ?? agyLogDir(), startedAt });
      const refused = AGY_POLICY_REFUSAL.test(diagnostics.response ?? '');
      const err = new Error(`${refused ? 'AGY_POLICY_REFUSED: the image model refused the prompt (Google generative-AI policy); ' : ''}agy produced no image: requested output missing and no new brain image found.${diagnostics.conversationId ? ` agy conversation_id: ${diagnostics.conversationId}.` : ''}${diagnostics.response ? ` agy said: ${diagnostics.response.slice(0, 300)}` : ''}${reported ? ` agy log: ${reported}` : ''}`);
      err.agyDiagnostics = diagnostics; throw err;
    }
  }
  const buffer = await readFile(source);
  const { format } = verifyAgyImage(buffer, aspectRatio);
  // agy may return JPEG bytes even when asked for .png; name the file by its real format
  // so downstream MIME detection by extension is truthful.
  const wantedExt = { png: '.png', jpeg: '.jpg', webp: '.webp' }[format];
  const finalOutput = extname(absOutput).toLowerCase() === wantedExt || (format === 'jpeg' && extname(absOutput).toLowerCase() === '.jpeg') ? absOutput : absOutput.slice(0, absOutput.length - extname(absOutput).length) + wantedExt;
  if (source === absOutput) { if (finalOutput !== absOutput) await rename(absOutput, finalOutput); }
  else await copyFile(source, finalOutput);
  // Delete the brain copy (the generated image agy keeps in its own history), only inside the brain dir.
  const toDelete = source !== absOutput ? source : brainCopy;
  let brainCleaned = null;
  if (toDelete) {
    const resolved = resolve(toDelete), root = resolve(resolvedBrain);
    if (resolved === root || !resolved.startsWith(root + '/')) throw new Error('Refusing to delete outside the agy brain dir.');
    await unlink(resolved); brainCleaned = resolved;
  }
  return { outputPath: finalOutput, brainCleaned };
}
