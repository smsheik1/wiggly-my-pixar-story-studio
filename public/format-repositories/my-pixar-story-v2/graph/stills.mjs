// Renders the crew's sheet and panel prompts with Nano Banana 2.1. The worker does not write these prompts.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { interrupt, isGraphInterrupt } from '@langchain/langgraph';
import { compilePanels } from '../crew/storyboard-artist/compile.mjs';
import { selectStoryboardArtistInput } from '../crew/storyboard-artist/input.mjs';
import { saveNanoBanana } from '../scripts/replicate-image.mjs';

export function paidItemsPath(runDir) {
  return join(runDir, 'outputs', 'paid-items.json');
}

async function readPaidItems(runDir) {
  try {
    return JSON.parse(await readFile(paidItemsPath(runDir), 'utf8'));
  } catch {
    return {};
  }
}

export function nanoBananaStill({ apiKey, fetchFn } = {}) {
  return ({ prompt, aspectRatio, resolution, dest, referencePaths }) => {
    if (!String(prompt ?? '').trim()) throw new Error('The crew did not write a still prompt.');
    return saveNanoBanana({ prompt, aspectRatio, resolution, dest, referencePaths, apiKey, fetchFn });
  };
}

function failed(message) {
  return {
    status: 'failed',
    escalations: [{ agent: 'stills', reason: message, attempts: 1, issues: [{ severity: 'error', code: 'STILL_RENDER_FAILED', message }] }],
  };
}

function pauseForCredits(error) {
  if (isGraphInterrupt(error)) throw error;
  if (error?.code === 'AWAITING_CREDITS') {
    interrupt({ kind: 'credits', itemId: error.itemId, credits: error.credits });
    interrupt({ kind: 'credits', itemId: error.itemId, credits: error.credits });
  }
  return null;
}

async function paint(renderStill, request, files, key, runDir) {
  const paid = await readPaidItems(runDir);
  if (paid[key]) {
    files[key] = paid[key];
    return;
  }
  const saved = await renderStill({ ...request, itemId: key });
  files[key] = saved.dest;
}

export function makeSheetStillNode({ renderStill, runDir = '/tmp' } = {}) {
  return async (state) => {
    if (!renderStill) return {};
    const files = {};
    try {
      for (const char of state.characterArchitect?.output?.characters ?? []) {
        const prompt = char.masterRenderPrompt?.promptText;
        if (!prompt) throw new Error(`${char.imageTag ?? char.name} has no master render prompt.`);
        await paint(renderStill, {
          prompt,
          aspectRatio: char.masterRenderPrompt?.aspectRatio || '1:1',
          resolution: '1K',
          dest: join(runDir, 'assets', `${String(char.imageTag).replace('@', '')}-${char.characterId}.png`),
        }, files, char.imageTag, runDir);
      }
      for (const loc of state.locationScout?.output?.locations ?? []) {
        const prompt = loc.locationPlatePrompt?.promptText;
        if (!prompt) throw new Error(`${loc.elementTag ?? loc.name} has no location plate prompt.`);
        await paint(renderStill, {
          prompt,
          aspectRatio: loc.locationPlatePrompt?.aspectRatio || '16:9',
          resolution: '1K',
          dest: join(runDir, 'assets', `${String(loc.elementTag).replace('@', '')}-${loc.locationId}.png`),
        }, files, loc.elementTag, runDir);
      }
      for (const prop of state.heroProps ?? []) {
        const prompt = prop.promptText || `Multi-angle model sheet of a ${prop.description || prop.name}, Pixar-style 3D stylized vehicle turnaround: front 3/4 view, side profile, and rear 3/4 view. Neutral gray studio lighting, crisp shadows, feature animation production asset.`;
        await paint(renderStill, {
          prompt,
          aspectRatio: '16:9',
          resolution: '1K',
          dest: join(runDir, 'assets', `${String(prop.propTag).replace('@', '').replace(/\s+/g, '')}-${prop.propTag.replace('@Prop ', 'p')}.png`),
        }, files, prop.propTag, runDir);
      }
    } catch (error) {
      if (pauseForCredits(error)) return {};
      return failed(error instanceof Error ? error.message : 'Still render failed.');
    }
    return { assetFiles: files };
  };
}

export function makePanelStillNode({ renderStill, runDir = '/tmp' } = {}) {
  return async (state) => {
    if (!renderStill) return {};
    const output = state.storyboardArtist?.output;
    if (!output) return {};
    const files = {};
    try {
      const input = selectStoryboardArtistInput(state);
      const known = state.assetFiles ?? {};
      for (const sheet of state.storyboardArtist?.sheets ?? []) {
        if (!sheet.fullPrompt) throw new Error(`Sheet ${sheet.sheetId} has no crew prompt.`);
        const referencePaths = (sheet.references ?? []).map((ref) => known[ref.imageTag] || known[ref.tag]).filter(Boolean);
        await paint(renderStill, {
          prompt: sheet.fullPrompt,
          aspectRatio: '16:9',
          resolution: '2K',
          dest: join(runDir, 'storyboard-sheets', `${sheet.sheetId}.png`),
          referencePaths,
        }, files, `sheet:${sheet.sheetId}`, runDir);
      }
      for (const panel of compilePanels(output, input)) {
        const referencePaths = (panel.references ?? []).map((ref) => known[ref.imageTag] || known[ref.tag]).filter(Boolean);
        await paint(renderStill, {
          prompt: panel.fullPrompt,
          aspectRatio: panel.aspect || '16:9',
          resolution: panel.resolution || '2K',
          dest: join(runDir, 'storyboard-panels', panel.file),
          referencePaths,
        }, files, panel.shotId, runDir);
      }
    } catch (error) {
      if (pauseForCredits(error)) return {};
      return failed(error instanceof Error ? error.message : 'Panel render failed.');
    }
    return { assetFiles: files };
  };
}
