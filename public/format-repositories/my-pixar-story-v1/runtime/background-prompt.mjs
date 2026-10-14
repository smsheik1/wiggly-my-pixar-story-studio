// Location Prompt Formula checks for background prompts (Theo's backgroundPrompt and
// backgroundAnglePrompt). Heuristics, kept deliberately simple:
// - the plate must say it is "empty of people" (video models mutate or duplicate people in a plate);
// - at most one rendered text element (quoted strings and runs of capitals, e.g. MY FAMILY);
// - one sentence must name a light source together with a direction.
const EMPTY = /\bempty of (?:all )?people\b/i;
// Capitals that are vocabulary, not rendered text.
const ACRONYMS = new Set(['CG', 'CGI', 'TV', 'LED', 'LEDS', 'DVD', 'VHS', 'CD', 'CRT', 'PC', 'USB', 'AM', 'PM', 'OK']);
const LIGHT = /\b(?:sun|sunlight|sunbeams?|daylight|moonlight|firelight|flames|lamplight|candlelight|candles?|light|lights|lighting|lamps?|spotlights?|glow|beams?|skyline|neon|torchlight|flashlight|headlights|streetlights?|lanterns?|fluorescent)\b/i;
const DIRECTION = /\b(?:from|through|left|right|overhead|above|below|behind|beneath|down|downward|upward|across|streaming|slanting|side|sideways|backlit|base|window|windows|doorway|skylight)\b/i;
const sentences = text => String(text).split(/(?<=[.!?;])\s+|\n+/).map(s => s.trim()).filter(Boolean);

export function textElements(prompt) {
  const s = String(prompt), found = [];
  for (const m of s.matchAll(/"([^"\n]*[A-Za-z][^"\n]*)"|“([^”\n]*[A-Za-z][^”\n]*)”/g)) found.push((m[1] ?? m[2]).trim());
  const unquoted = s.replace(/"[^"\n]*"|“[^”\n]*”/g, ' ');
  for (const m of unquoted.matchAll(/\b[A-Z][A-Z'’!]+(?:[ \t]+[A-Z][A-Z'’!]*)*\b/g)) {
    const words = m[0].split(/\s+/).filter(w => !ACRONYMS.has(w.replace(/[^A-Z]/g, '')));
    if (words.length && words.join('').replace(/[^A-Z]/g, '').length >= 2) found.push(words.join(' '));
  }
  return [...new Set(found.map(t => t.toUpperCase()))];
}

// The key light sentence, trimmed to the clause that names the light (Cam receives it as task.backgroundKeyLight).
export function keyLightOf(prompt) {
  const s = sentences(prompt).find(x => !/feature-quality 3D animated film/i.test(x) && LIGHT.test(x) && DIRECTION.test(x));
  if (!s) return null;
  const parts = s.replace(/^[A-Za-z ]{2,40}:\s*/, '').split(/,\s+/);
  const i = parts.findIndex(x => LIGHT.test(x));
  const clause = parts.slice(i).join(', ');
  return DIRECTION.test(clause) ? clause : s;
}

export function backgroundPromptProblems(prompt) {
  const problems = [];
  if (!EMPTY.test(String(prompt))) problems.push('say the room is "completely empty of people"');
  const texts = textElements(prompt);
  if (texts.length > 1) problems.push(`keep at most one piece of rendered text, hand-lettered (found ${texts.length}: ${texts.slice(0, 4).join(', ')})`);
  if (!keyLightOf(prompt)) problems.push('name one key light source with its direction in one sentence (for example "morning sunlight from tall windows on the left")');
  return problems;
}

export function assertBackgroundPrompt(prompt) {
  const problems = backgroundPromptProblems(prompt);
  if (problems.length) throw new Error(`BACKGROUND_PROMPT_FORMULA: ${problems.join('; ')}.`);
}
