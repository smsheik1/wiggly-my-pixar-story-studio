import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {importMedia, jpegOrientation} from '../runtime/media.mjs';

const run = promisify(execFile);

async function redJpg(dir, name, size = '100x60') {
  const path = join(dir, name);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=red:s=${size}`, '-frames:v', '1', path]);
  return path;
}
// Minimal EXIF APP1 segment with a single Orientation tag (mirrors phone output).
function withOrientation(jpgBytes, orientation, littleEndian = true) {
  assert.ok(jpgBytes[0] === 0xFF && jpgBytes[1] === 0xD8);
  const head = Buffer.from(littleEndian ? [0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00] : [0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08]);
  const w16 = v => littleEndian ? Buffer.from([v & 0xFF, (v >> 8) & 0xFF]) : Buffer.from([(v >> 8) & 0xFF, v & 0xFF]);
  const w32 = v => littleEndian
    ? Buffer.from([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF])
    : Buffer.from([(v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF]);
  const value = littleEndian ? Buffer.from([orientation, 0x00, 0x00, 0x00]) : Buffer.from([0x00, orientation, 0x00, 0x00]);
  const entry = Buffer.concat([w16(0x0112), w16(3), w32(1), value]);
  const ifd = Buffer.concat([w16(1), entry, w32(0)]);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), head, ifd]);
  // JPEG segment lengths are always big-endian, whatever the TIFF byte order.
  const segLen = exif.length + 2;
  const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1, (segLen >> 8) & 0xFF, segLen & 0xFF]), exif]);
  return Buffer.concat([jpgBytes.subarray(0, 2), app1, jpgBytes.subarray(2)]);
}

test('jpegOrientation reads the EXIF tag in both byte orders, 1 when absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orient-unit-'));
  try {
    const plain = Buffer.from(await readFile(await redJpg(dir, 'plain.jpg')));
    assert.equal(jpegOrientation(plain), 1);
    assert.equal(jpegOrientation(withOrientation(plain, 6)), 6);
    assert.equal(jpegOrientation(withOrientation(plain, 6, false)), 6);
    assert.equal(jpegOrientation(withOrientation(plain, 1)), 1);
    assert.equal(jpegOrientation(Buffer.from([0x89, 0x50, 0x4E, 0x47])), 1);
    assert.equal(jpegOrientation(Buffer.from([0xFF, 0xD8, 0xFF, 0xD9])), 1);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('importMedia normalizes a 90-degree EXIF photo to display pixels', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orient-import-'));
  try {
    const plain = Buffer.from(await readFile(await redJpg(dir, 'photo.jpg')));
    await writeFile(join(dir, 'rotated.jpg'), withOrientation(plain, 6));
    const runDir = join(dir, 'run');
    const rotated = await importMedia(join(dir, 'rotated.jpg'), runDir);
    assert.equal(rotated.width, 60);
    assert.equal(rotated.height, 100);
    assert.match(rotated.path, /\.png$/);
    // The stored bytes are already upright, so a second import is a no-op.
    const again = await importMedia(rotated.path, runDir);
    assert.equal(again.sha256, rotated.sha256);
    assert.equal(again.width, 60);
    // A plain JPEG without the tag passes through untouched.
    const same = await importMedia(join(dir, 'photo.jpg'), runDir);
    assert.equal(same.width, 100);
    assert.equal(same.height, 60);
    assert.match(same.path, /\.jpg$/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
