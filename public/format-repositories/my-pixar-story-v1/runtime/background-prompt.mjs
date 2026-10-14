// Location Prompt Formula checks for background prompts (Theo's backgroundPrompt and
// backgroundAnglePrompt). Heuristics, kept deliberately simple:
// - the plate must say it is "empty of people" (video models mutate or duplicate people in a plate);
// - at most one rendered text element (quoted strings and runs of capitals, e.g. MY FAMILY);
// - one sentence must name a light source together with a direction.
// - never "muted"; never "kept out"; never "filling ... evenly" / "even fill" after a key light.
// - wall art is face-free: never "family photo(s)", "portrait(s)" or "photo of".
const FACE_ART_RE = /\bfamily photos?\b|\bportraits?\b|\bphoto of\b/i;
const EMPTY = /\bempty of (?:all )?people\b/i;
// Capitals that are vocabulary, not rendered text.
const ACRONYMS = new Set(['CG', 'CGI', 'TV', 'LED', 'LEDS', 'DVD', 'VHS', 'CD', 'CRT', 'PC', 'USB', 'AM', 'PM', 'OK']);
// Whole-word matching that treats hyphens as word characters, so "sun-bleached"
// does not count as "sun". "window(s)", "lettering" and "doorway" are never light
// words on their own (they are not in this list at all).
const LIGHT_WORDS = ['sunlight', 'sunbeams', 'sunbeam', 'daylight', 'moonlight', 'firelight', 'lamplight', 'candlelight', 'torchlight', 'sun', 'flames', 'candle', 'candles', 'lighting', 'spotlights', 'spotlight', 'lights', 'light', 'lamps', 'lamp', 'glow', 'beams', 'beam', 'skyline', 'neon', 'flashlight', 'headlights', 'headlight', 'streetlights', 'streetlight', 'lanterns', 'lantern', 'fluorescent'];
const lightAlt = [...LIGHT_WORDS].sort((a, b) => b.length - a.length).join('|');
const LIGHT_RE = new RegExp(`(?<![A-Za-z-])(?:${lightAlt})(?![A-Za-z-])`, 'i');
// Direction words. "window"/"windows" only count when paired with through/from
// (e.g. "through the left window" is fine; "windows rolled down" is not).
const DIR_CORE = ['streaming', 'slanting', 'sideways', 'overhead', 'downward', 'upward', 'backlit', 'behind', 'beneath', 'above', 'below', 'across', 'through', 'from', 'left', 'right', 'down', 'side', 'base', 'skylight'];
const dirAlt = [...DIR_CORE].sort((a, b) => b.length - a.length).join('|');
const DIR_CORE_RE = new RegExp(`(?<![A-Za-z-])(?:${dirAlt})(?![A-Za-z-])`, 'i');
const WINDOW_RE = /(?<![A-Za-z-])(?:windows?)(?![A-Za-z-])/i;
const THROUGH_FROM_RE = /(?<![A-Za-z-])(?:through|from)(?![A-Za-z-])/i;
const OPENING_RE = /feature-quality 3D animated film/i;
const CAMERA_RE = /^\s*camera\s*:/i;
// Staging language: a bare "glow" here is the TV glow, not the key light.
const STAGING_RE = /kept clear|staging|looking toward|facing/i;
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

function lightHits(s) {
  const hits = [...String(s).matchAll(new RegExp(LIGHT_RE.source, 'gi'))].map(m => m[0].toLowerCase());
  if (!hits.length) return [];
  // "glow" alone in a camera/staging sentence is set dressing, not the key light.
  if (hits.every(h => h === 'glow') && (CAMERA_RE.test(s) || STAGING_RE.test(s))) return [];
  return hits;
}

function hasLight(s) {
  return lightHits(s).length > 0;
}

function hasDirection(s) {
  const t = String(s);
  if (DIR_CORE_RE.test(t)) return true;
  return WINDOW_RE.test(t) && THROUGH_FROM_RE.test(t);
}

function isSkipped(s) {
  return OPENING_RE.test(s) || CAMERA_RE.test(s);
}

// The key light sentence, trimmed to the clause that names the light (Cam receives it as task.backgroundKeyLight).
// Prefers the LAST light-bearing sentence, so a camera "television glow" or a
// prop sentence ("windows rolled down ... no readable lettering") never wins
// over the closing key-light sentence.
export function keyLightOf(prompt) {
  const cands = sentences(prompt).filter(x => !isSkipped(x) && hasLight(x) && hasDirection(x));
  if (!cands.length) return null;
  const s = cands.at(-1);
  const parts = s.replace(/^[A-Za-z /-]{2,40}:\s*/, '').split(/,\s+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (hasLight(parts[i]) && hasDirection(parts.slice(i).join(', '))) return parts.slice(i).join(', ').trim();
  }
  return s;
}

export function backgroundBriefProblems(direction) {
  const problems = [];
  if (/\bmuted\b/i.test(String(direction))) problems.push('name vivid colours; never write "muted" in a brief');
  return problems;
}

export function assertBackgroundBrief(direction) {
  const problems = backgroundBriefProblems(direction);
  if (problems.length) throw new Error(`BACKGROUND_BRIEF: ${problems.join('; ')}.`);
}

export function backgroundPromptProblems(prompt) {
  const problems = [];
  const s = String(prompt);
  if (!EMPTY.test(s)) problems.push('say the room is "completely empty of people"');
  const texts = textElements(prompt);
  if (texts.length > 1) problems.push(`keep at most one piece of rendered text, hand-lettered (found ${texts.length}: ${texts.slice(0, 4).join(', ')})`);
  if (!keyLightOf(prompt)) problems.push('name one key light source with its direction in one sentence (for example "morning sunlight from tall windows on the left")');
  if (/\bmuted\b/i.test(s)) problems.push('name vivid colours; never write "muted"');
  if (/kept out/i.test(s)) problems.push('never name excluded things ("kept out")');
  if (/\bevenly\b/i.test(s) || /even\s+fill/i.test(s)) problems.push('never write "filling ... evenly" (or "even fill") after a directional key light');
  if (FACE_ART_RE.test(s)) problems.push('write wall art face-free: never "family photos", "portraits" or "photo of" (landscapes, kids\' drawings or patterns instead)');
  return problems;
}

export function assertBackgroundPrompt(prompt) {
  const problems = backgroundPromptProblems(prompt);
  if (problems.length) throw new Error(`BACKGROUND_PROMPT_FORMULA: ${problems.join('; ')}.`);
}
