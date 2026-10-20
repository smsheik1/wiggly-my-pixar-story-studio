// Story first (fix #1): before the shots call, the Story Director makes two plain-text calls with the same model:
//   A. beats (crew/story-director/BEATS.md): thesis first, then 5-7 beats built toward it
//   B. critique + rewrite (crew/story-director/CRITIQUE.md): 5 story questions, then the rewritten beats
// The rewritten beats go into call C (the existing Deep Agent shots run, gate and reflection). Saved as run artifacts.
import { readFileSync, existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withCallRetry, isFatalProviderError } from './provider-errors.mjs';

const replyText = (m) => (typeof m?.content === 'string' ? m.content
  : Array.isArray(m?.content) ? m.content.filter((b) => typeof b === 'string' || b?.type === 'text').map((b) => (typeof b === 'string' ? b : b.text ?? '')).join('') : String(m?.content ?? ''));
const load = (f) => { const p = fileURLToPath(new URL(`../crew/story-director/${f}`, import.meta.url)); return existsSync(p) ? readFileSync(p, 'utf8') : null; };
export const loadBeatsPrompt = () => load('BEATS.md');
export const loadCritiquePrompt = () => load('CRITIQUE.md');

/** On for the Story Director when config.storyBeats is true, never in patch mode (scope or task set). */
export const storyBeatsEnabled = (agent, config, { scope = '', task = null, patch = false } = {}) =>
  agent === 'story-director' && Boolean(config?.storyBeats) && !scope && !task && !patch;

const inputText = (input) => ['The family input (answers are the only source of facts):', '```json', JSON.stringify(input ?? {}, null, 2), '```'].join('\n');
export const beatsMessages = (input, prompt = loadBeatsPrompt(), notes = '') => [{ role: 'system', content: prompt }, { role: 'user', content: [inputText(input),
  ...(notes ? ['', 'An editor judged the last script built from your beats STRUCTURAL: the story itself did not work. Write new beats from scratch from the answers, fixing what the notes say the story needs (ignore their line-level fixes):', notes] : [])].join('\n') }];
export const critiqueMessages = (input, beats, prompt = loadCritiquePrompt()) => [{ role: 'system', content: prompt },
  { role: 'user', content: [inputText(input), '', 'The beats to judge:', beats].join('\n') }];

/** The rewritten beats from call B (text after "## Rewritten beats"); the whole reply if the heading is missing. */
export function rewrittenBeats(critique) {
  const m = /^#{1,3}\s*Rewritten beats\s*$/im.exec(critique);
  return (m ? critique.slice(m.index + m[0].length) : critique).trim();
}

/** The approved thesis: the first `Thesis:` line of the beats (markdown emphasis stripped), or null. */
export function parseThesis(beats) {
  const m = /^[\s>*_#-]*Thesis[*_]*\s*(?:for [^:\n]*)?:[*_\s]*(.+)$/im.exec(String(beats ?? ''));
  const t = m ? m[1].replace(/[*_]+/g, '').trim() : '';
  return t || null;
}

/** The first user message of call C. */
export const shotsTask = (agent, beats) => [`Produce the ${agent} output for this run.`, '',
  'Story first: these are the approved beats (thesis and beats, already critiqued). Turn them into the shots JSON:',
  'keep their thesis, moments, people on screen and lines; your SKILL.md rules decide format, timing and length.',
  ...(parseThesis(beats) ? [`finaleThesis is exactly: "${parseThesis(beats)}"`] : []), '', beats].join('\n');

/** Calls A and B. Returns { beats, critique, approved, files } or null if either call fails (non-fatal: C runs as before). */
export async function runStoryBeats({ agent = 'story-director', input, model, dir, signal, attempt = 1, callRetry = {}, notes = '' }) {
  const meta = (step) => ({ runName: `${agent} story ${step}`, tags: [`agent:${agent}`, `attempt:${attempt}`, `story:${step}`], metadata: { agent, attempt, step }, signal });
  try {
    await mkdir(dir, { recursive: true });
    const beats = replyText(await withCallRetry(() => model.invoke(beatsMessages(input, undefined, notes), meta('beats')), { signal, ...callRetry })).trim();
    if (!beats) return null;
    await writeFile(join(dir, 'beats.md'), beats + '\n');
    const critique = replyText(await withCallRetry(() => model.invoke(critiqueMessages(input, beats), meta('critique')), { signal, ...callRetry })).trim();
    const approved = critique ? rewrittenBeats(critique) || beats : beats;
    if (critique) await writeFile(join(dir, 'critique.md'), critique + '\n');
    await writeFile(join(dir, 'approved-beats.md'), approved + '\n');
    return { beats, critique, approved, thesis: parseThesis(approved) ?? parseThesis(beats), files: ['beats.md', ...(critique ? ['critique.md'] : []), 'approved-beats.md'] };
  } catch (e) {
    if (signal?.aborted) throw signal.reason ?? e;
    if (isFatalProviderError(e)) throw e;
    return null;
  }
}
