// Story first (fix #1): before the shots call, the Story Director makes two plain-text calls with the same model:
//   A. beats (crew/story-director/1-story-plan.md): thesis first, then 5-7 beats built toward it
//   B. critique + rewrite (crew/story-director/2-story-critique.md): 5 story questions, then the rewritten beats
// The rewritten beats go into call C (the existing Deep Agent shots run, gate and reflection). Saved as run artifacts.
import { readFileSync, existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withCallRetry, isFatalProviderError } from './provider-errors.mjs';

const replyText = (m) => (typeof m?.content === 'string' ? m.content
  : Array.isArray(m?.content) ? m.content.filter((b) => typeof b === 'string' || b?.type === 'text').map((b) => (typeof b === 'string' ? b : b.text ?? '')).join('') : String(m?.content ?? ''));
const load = (f) => { const p = fileURLToPath(new URL(`../crew/story-director/${f}`, import.meta.url)); return existsSync(p) ? readFileSync(p, 'utf8') : null; };
export const loadBeatsPrompt = () => load('1-story-plan.md');
export const loadCritiquePrompt = () => load('2-story-critique.md');

/** On for the Story Director when config.storyBeats is true, never in patch mode (scope or task set). */
export const storyBeatsEnabled = (agent, config, { scope = '', task = null, patch = false } = {}) =>
  agent === 'story-director' && Boolean(config?.storyBeats) && !scope && !task && !patch;

const inputText = (input) => ['The family input (answers are the only source of facts):', '```json', JSON.stringify(input ?? {}, null, 2), '```'].join('\n');
export const beatsMessages = (input, prompt = loadBeatsPrompt(), notes = '') => [{ role: 'system', content: prompt }, { role: 'user', content: [inputText(input),
  ...(notes ? ['', 'An editor judged the last script built from your beats STRUCTURAL: the story itself did not work. Write new beats from scratch from the answers, fixing what the notes say the story needs (ignore their line-level fixes):', notes] : [])].join('\n') }];
export const critiqueMessages = (input, beats, prompt = loadCritiquePrompt(), approach = null) => [{ role: 'system', content: prompt },
  { role: 'user', content: [inputText(input), '', 'The beats to judge:', beats,
    ...(approach ? ['', `Build the rewritten beats on this approach only: ${approach.label}. Do not switch to another approach; judge and fix the beats within it. Its closing idea grows out of this thread.`, approach.text] : [])].join('\n') }];

/**
 * The story approaches the plan proposed (step 2 of 1-story-plan.md): [{ label, text }] in order, at most `max`.
 * Only the step-2 section is read (from "story approaches" to the Pick step). A heading line starts "Approach A",
 * "**Approach B:**" or "A." / "B)" ; its text runs to the next heading.
 */
export function parseApproaches(beats, max = 3) {
  const src = String(beats ?? '');
  const start = src.search(/story approaches/i);
  if (start < 0) return [];
  const from = src.indexOf('\n', start);
  const rest = from < 0 ? '' : src.slice(from);
  const stop = rest.search(/^[\s>*_#-]*(?:\d+[.)]\s*)?[*_]*(?:Pick\b)|^[\s>*_#]*\**3[.)]/im);
  const sec = stop < 0 ? rest : rest.slice(0, stop);
  const heads = [...sec.matchAll(/^[\s>*_#-]*(?:Approach\s+[A-C1-3]\b|[A-C][.)])[^\n]*$/gim)];
  return heads.slice(0, max).map((m, i) => ({
    label: m[0].replace(/[*_#>]/g, '').replace(/^[\s-]+/, '').trim(),
    text: sec.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : sec.length).trim(),
  }));
}

/** The rewritten beats from call B (text after "## Rewritten beats"); the whole reply if the heading is missing. */
export function rewrittenBeats(critique) {
  const m = /^#{1,3}\s*Rewritten beats\s*$/im.exec(critique);
  return (m ? critique.slice(m.index + m[0].length) : critique).trim();
}

/** The approved thesis: the first `Thesis:` line of the beats (markdown emphasis stripped), or null. */
export function parseThesis(beats) {
  const m = /^[\s>*_#-]*(?:\d+[.)][\s*_]*)?Thesis[*_]*\s*(?:for [^:\n]*)?:[*_\s]*(.+)$/im.exec(String(beats ?? ''));
  const t = m ? m[1].replace(/[*_]+/g, '').trim() : '';
  return t || null;
}

/** The first user message of call C. */
export const shotsTask = (agent, beats) => [`Produce the ${agent} output for this run.`, '',
  'Story first: these are the approved beats (thesis and beats, already critiqued). Turn them into the shots JSON:',
  'keep their thesis, moments, people on screen and lines; your SKILL.md rules decide format, timing and length.',
  ...(parseThesis(beats) ? [`finaleThesis is exactly: "${parseThesis(beats)}"`] : []), '', beats].join('\n');

/** Calls A and B. Returns { beats, critique, approved, files } or null if either call fails (non-fatal: C runs as before). */
export async function runStoryBeats({ agent = 'story-director', input, model, dir, signal, attempt = 1, callRetry = {}, notes = '', approach = null, beats: given = null }) {
  const meta = (step) => ({ runName: `${agent} story ${step}`, tags: [`agent:${agent}`, `attempt:${attempt}`, `story:${step}`], metadata: { agent, attempt, step }, signal });
  try {
    await mkdir(dir, { recursive: true });
    const beats = given ?? replyText(await withCallRetry(() => model.invoke(beatsMessages(input, undefined, notes), meta('beats')), { signal, ...callRetry })).trim();
    if (!beats) return null;
    await writeFile(join(dir, 'beats.md'), beats + '\n');
    const critique = replyText(await withCallRetry(() => model.invoke(critiqueMessages(input, beats, undefined, approach), meta('critique')), { signal, ...callRetry })).trim();
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

/**
 * One plan, one critiqued story per approach: call A once, then call B per approach in parallel (up to `max`), each
 * told to stay on its approach. Returns [{ label, beats, critique, approved, thesis, files, dir }] (files relative to
 * `dir`), a single story when the plan has fewer than 2 approaches, or null if call A fails.
 */
export async function runStoryPlans({ agent = 'story-director', input, model, dir, signal, attempt = 1, callRetry = {}, max = 3 }) {
  const meta = { runName: `${agent} story beats`, tags: [`agent:${agent}`, `attempt:${attempt}`, 'story:beats'], metadata: { agent, attempt, step: 'beats' }, signal };
  let beats;
  try {
    await mkdir(dir, { recursive: true });
    beats = replyText(await withCallRetry(() => model.invoke(beatsMessages(input), meta), { signal, ...callRetry })).trim();
  } catch (e) {
    if (signal?.aborted) throw signal.reason ?? e;
    if (isFatalProviderError(e)) throw e;
    return null;
  }
  if (!beats) return null;
  const approaches = parseApproaches(beats, max);
  if (approaches.length < 2) {
    const one = await runStoryBeats({ agent, input, model, dir, signal, attempt, callRetry, beats });
    return one ? [{ ...one, label: null, dir }] : null;
  }
  const out = await Promise.all(approaches.map(async (a, i) => {
    const sub = join(dir, `approach-${'ABC'[i]}`);
    const r = await runStoryBeats({ agent, input, model, dir: sub, signal, attempt, callRetry, beats, approach: a });
    return r ? { ...r, label: a.label, dir: sub } : null;
  }));
  const ok = out.filter(Boolean);
  return ok.length ? ok : null;
}
