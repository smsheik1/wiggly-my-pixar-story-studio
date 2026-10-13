// Google Flow (Nano Banana 2.1) image backend for character sheets.
// Drives a dedicated, signed-in Chrome profile on the Mac with playwright-core.
// Reference photos are uploaded straight from their local paths into Flow; they are
// never copied, logged or written anywhere else by this module.
// Every failure is typed so the sheet step can fall back to Muse:
//   FLOW_UPLOAD_REJECTED  Flow refused a reference upload (e.g. photos of minors)
//   FLOW_POLICY_REFUSED   Flow refused the prompt/generation on policy grounds
//   FLOW_UI_ERROR         anything else (not signed in, UI changed, timeout, no image)
import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { verifyAgyImage } from './agy-image.mjs';

export const FLOW_URL = 'https://labs.google/fx/tools/flow';
export const FLOW_MODEL = 'Nano Banana 2.1';
export const FLOW_ERROR_CODES = ['FLOW_UPLOAD_REJECTED', 'FLOW_POLICY_REFUSED', 'FLOW_UI_ERROR'];
export const FLOW_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const flowProfileDir = () => process.env.WIGGLY_FLOW_PROFILE_DIR || join(homedir(), '.wiggly', 'flow-chrome-profile');
export const flowTimeoutMs = () => Number(process.env.WIGGLY_FLOW_TIMEOUT_MS || FLOW_DEFAULT_TIMEOUT_MS);

export class FlowError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; this.name = 'FlowError'; }
}
export const isFlowFallbackError = e => FLOW_ERROR_CODES.includes(e?.code) || FLOW_ERROR_CODES.some(c => String(e?.message ?? '').startsWith(`${c}:`));

const UPLOAD_REJECTED = /failed to upload|upload failed|couldn'?t upload|can'?t upload|photorealistic (people|person)|image (was|is) not allowed/i;
const POLICY_REFUSED = /policy|violat|couldn'?t generate|could not generate|unable to generate|can'?t generate|sensitive|not allowed|blocked/i;
const SIGNED_OUT = /sign in|log in|create account/i;

// Classify a Flow UI message into a typed error code (pure; unit-tested).
export function classifyFlowMessage(text, phase = 'generate') {
  const t = String(text ?? '');
  if (phase === 'upload' && UPLOAD_REJECTED.test(t)) return 'FLOW_UPLOAD_REJECTED';
  if (UPLOAD_REJECTED.test(t) && /upload/i.test(t)) return 'FLOW_UPLOAD_REJECTED';
  if (POLICY_REFUSED.test(t)) return 'FLOW_POLICY_REFUSED';
  return 'FLOW_UI_ERROR';
}

async function loadChromium() {
  try { return (await import('playwright-core')).chromium; }
  catch (e) { throw new FlowError('FLOW_UI_ERROR', `playwright-core is not installed (${e.message.slice(0, 120)}). Run npm install in the kit.`); }
}

export async function openFlowContext({ profileDir = flowProfileDir(), headless = false } = {}) {
  const chromium = await loadChromium();
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  try { return await chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless, acceptDownloads: true, viewport: { width: 1440, height: 960 } }); }
  catch (e) { throw new FlowError('FLOW_UI_ERROR', `could not launch Chrome with the Flow profile: ${String(e.message).split('\n')[0].slice(0, 200)}`); }
}

// One-time sign-in: opens the dedicated profile at Flow and waits until the window is closed.
export async function flowLogin(opts = {}) {
  const ctx = await openFlowContext({ ...opts, headless: false });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto(FLOW_URL);
  console.log(`Sign in to Google in this Chrome window (profile ${opts.profileDir ?? flowProfileDir()}), open Flow once, then close the window.`);
  await new Promise(r => ctx.on('close', r));
}

const clickText = async (page, re, timeout = 5000) => {
  const loc = page.getByRole('button', { name: re }).or(page.getByRole('option', { name: re })).or(page.getByRole('menuitem', { name: re })).or(page.getByText(re)).first();
  await loc.click({ timeout });
};
const bannerText = async page => {
  try { return (await page.locator('[role="alert"], [role="status"], [aria-live]').allInnerTexts()).join(' \n ').slice(0, 600); } catch { return ''; }
};

// Settings: image mode, model, aspect ratio, 1 output. Each step is required; a miss is FLOW_UI_ERROR.
async function configure(page, aspectRatio) {
  const step = async (label, fn) => { try { await fn(); } catch (e) { throw new FlowError('FLOW_UI_ERROR', `could not set ${label} (Flow UI may have changed): ${String(e.message).split('\n')[0].slice(0, 160)}`); } };
  await step('image mode', async () => { await clickText(page, /^(images?|create images?|image generation)$/i); });
  await step('settings', async () => { await clickText(page, /settings|tune|options/i, 3000).catch(() => {}); });
  await step('model', async () => { await clickText(page, /model|nano banana/i); await clickText(page, new RegExp(FLOW_MODEL.replace(/\./g, '\\.'), 'i')); });
  await step('aspect ratio', async () => { await clickText(page, /aspect|ratio|landscape|portrait|square|\d+:\d+/i); await clickText(page, new RegExp(aspectRatio.replace(':', '\\s*:\\s*'))); });
  await step('output count', async () => { await clickText(page, /outputs?|per prompt|count/i, 3000).catch(() => {}); await clickText(page, /^(1|x1|1 output)$/i, 3000).catch(() => {}); });
  await page.keyboard.press('Escape').catch(() => {});
}

export async function generateFlowImage({ prompt, aspectRatio = '4:3', imagePaths = [], outputPath, profileDir, headless = process.env.WIGGLY_FLOW_HEADLESS === '1', timeoutMs = flowTimeoutMs() }) {
  if (!outputPath) throw new FlowError('FLOW_UI_ERROR', 'outputPath is required');
  const ctx = await openFlowContext({ profileDir, headless });
  try {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => { throw new FlowError('FLOW_UI_ERROR', `could not open Flow: ${String(e.message).split('\n')[0]}`); });
    if (/accounts\.google\.com/.test(page.url())) throw new FlowError('FLOW_UI_ERROR', 'the Flow Chrome profile is not signed in; run `npm run flow:login` once.');
    await clickText(page, /new project/i, 8000).catch(() => {});
    await configure(page, aspectRatio);
    for (const [i, path] of imagePaths.entries()) {
      const input = page.locator('input[type="file"]').first();
      try { await input.setInputFiles(path, { timeout: 15000 }); }
      catch (e) { throw new FlowError('FLOW_UI_ERROR', `reference ${i + 1}: no upload control (${String(e.message).split('\n')[0].slice(0, 120)})`); }
      const deadline = Date.now() + 60000; let done = false;
      while (Date.now() < deadline) {
        const msg = await bannerText(page);
        if (UPLOAD_REJECTED.test(msg)) throw new FlowError('FLOW_UPLOAD_REJECTED', `Flow rejected reference ${i + 1}: ${msg.slice(0, 200)}`);
        if (await page.locator(`img[src^="blob:"], img[alt*="reference" i], [data-testid*="ingredient" i] img`).count() > i) { done = true; break; }
        await page.waitForTimeout(1000);
      }
      if (!done) throw new FlowError('FLOW_UI_ERROR', `reference ${i + 1} upload did not finish within 60 s`);
    }
    const box = page.getByRole('textbox').or(page.locator('textarea, [contenteditable="true"]')).first();
    try { await box.fill(prompt); } catch (e) { throw new FlowError('FLOW_UI_ERROR', `prompt box not found: ${String(e.message).split('\n')[0].slice(0, 120)}`); }
    const before = await page.locator('main img').count();
    try { await page.getByRole('button', { name: /create|generate|send|submit/i }).last().click({ timeout: 10000 }); }
    catch { await box.press('Enter'); }
    const deadline = Date.now() + timeoutMs; let img = null;
    while (Date.now() < deadline) {
      const msg = await bannerText(page);
      if (msg && POLICY_REFUSED.test(msg)) throw new FlowError('FLOW_POLICY_REFUSED', `Flow refused the generation: ${msg.slice(0, 200)}`);
      if (SIGNED_OUT.test(msg) && /to continue/i.test(msg)) throw new FlowError('FLOW_UI_ERROR', 'Flow asked to sign in; run `npm run flow:login`.');
      const imgs = page.locator('main img');
      if (await imgs.count() > before) { img = imgs.nth(await imgs.count() - 1); if (await img.evaluate(el => el.complete && el.naturalWidth > 256).catch(() => false)) break; img = null; }
      await page.waitForTimeout(2000);
    }
    if (!img) throw new FlowError('FLOW_UI_ERROR', `no image appeared within ${Math.round(timeoutMs / 1000)} s`);
    await mkdir(dirname(outputPath), { recursive: true });
    let bytes = null;
    try {
      await img.hover();
      await page.getByRole('button', { name: /download/i }).last().click({ timeout: 8000 });
      const dl = page.waitForEvent('download', { timeout: 60000 });
      await clickText(page, /1k|original/i, 8000);
      const d = await dl; const tmp = `${outputPath}.part`; await d.saveAs(tmp); bytes = await readFile(tmp); await rename(tmp, outputPath);
    } catch {
      const src = await img.getAttribute('src');
      const res = src && !src.startsWith('blob:') ? await page.request.get(new URL(src, page.url()).href).catch(() => null) : null;
      if (!res?.ok()) throw new FlowError('FLOW_UI_ERROR', 'image appeared but the 1K download failed');
      bytes = Buffer.from(await res.body()); await writeFile(outputPath, bytes, { mode: 0o600 });
    }
    let finalPath = outputPath;
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (isJpeg && extname(outputPath).toLowerCase() !== '.jpg') { finalPath = outputPath.replace(/\.[^.]+$/, '') + '.jpg'; await rename(outputPath, finalPath); }
    try { verifyAgyImage(bytes, aspectRatio); } catch (e) { throw new FlowError('FLOW_UI_ERROR', `downloaded image failed checks: ${e.message}`); }
    return { outputPath: finalPath, model: FLOW_MODEL, costUsd: 0 };
  } finally { await ctx.close().catch(() => {}); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === 'login') {
  flowLogin().then(() => process.exit(0), e => { console.error(e.message); process.exit(1); });
}
