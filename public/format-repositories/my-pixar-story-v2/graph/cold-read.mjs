// Cold read: a first-time viewer reads only the script draft with no prior answers or context.
import { loadColdRead, V2_MODELS } from '../config/models.mjs';
import { isFatalProviderError } from './provider-errors.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const replyText = (m) => (typeof m?.content === 'string' ? m.content
  : Array.isArray(m?.content) ? m.content.filter((b) => typeof b === 'string' || b?.type === 'text').map((b) => (typeof b === 'string' ? b : b.text ?? '')).join('') : String(m?.content ?? ''));

/**
 * True when cold-read is enabled for this agent and config.
 * Configurable via config.coldRead; defaults to V2_MODELS[agent]?.coldRead (true for story-director, absent/false for others).
 */
export function coldReadEnabled(agent, config) {
  if (config && 'coldRead' in config) return Boolean(config.coldRead);
  if (config && typeof config === 'object' && Object.keys(config).length > 0) return Boolean(config.coldRead);
  return Boolean(V2_MODELS[agent]?.coldRead);
}

/**
 * Chat messages for the cold-read call: receives ONLY the script (draft JSON) and the cold-read prompt.
 * Contains no questionnaire answers, no input.json, no trace table, and no extra cast notes.
 */
export function coldReadMessages(draftOrOpts, opts = {}) {
  let draft = draftOrOpts;
  let prompt = opts.prompt;
  if (draftOrOpts && typeof draftOrOpts === 'object' && 'draft' in draftOrOpts && !('segments' in draftOrOpts || 'masthead' in draftOrOpts)) {
    draft = draftOrOpts.draft;
    prompt = draftOrOpts.prompt ?? prompt;
  }
  const p = prompt ?? loadColdRead('story-director');
  return [
    { role: 'system', content: p },
    { role: 'user', content: ['The script to read (draft stage play):', '```json', JSON.stringify(draft ?? {}, null, 2), '```'].join('\n') },
  ];
}

/**
 * Runs one cold-read model call before critique.
 * Non-fatal provider errors are swallowed (returns null); fatal provider errors re-throw.
 */
export async function runColdRead({ agent, config, draft, model, round, attempt, signal, dir, rel, scope = '' } = {}) {
  if (scope || !coldReadEnabled(agent, config)) return null;
  const prompt = loadColdRead(agent);
  if (!prompt) return null;
  const meta = {
    runName: `${agent} reflection round ${round} cold-read`,
    tags: [`agent:${agent}`, `attempt:${attempt}`, `reflection:${round}`, 'cold-read'],
    metadata: { agent, attempt, reflectionRound: round },
    signal,
  };
  try {
    const messages = coldReadMessages(draft, { prompt });
    const notes = replyText(await model.invoke(messages, meta)).trim();
    if (!notes) return null;
    let file = null;
    if (dir && rel) {
      const filename = `round-${round}-cold-read.md`;
      await writeFile(join(dir, filename), notes + '\n');
      file = rel(filename);
    }
    return { notes, file };
  } catch (e) {
    if (signal?.aborted) throw signal.reason ?? e;
    if (isFatalProviderError(e)) throw e;
    return null;
  }
}
