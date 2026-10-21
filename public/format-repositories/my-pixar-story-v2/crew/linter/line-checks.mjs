// Generic spoken-line and shot checks shared by the Story Director and Seedance Compiler gates. No family's names live here.
// r5 clip-1 review: a narration line ended on a comma across a hard cut (CUT_MID_SENTENCE); narration named "my little brother"
// while only the sister was on screen (NAMED_PERSON_NOT_SHOWN); every shot carried the same scripted blink (REPEATED_MICRO_ACTION).

const strip = (x) => String(x ?? '').replace(/[{}"“”]/g, '').trim();
/** True when a spoken line stops mid-thought: it ends on a comma, colon, semicolon, dash or ellipsis-less word. */
export function endsMidSentence(line) {
  const s = strip(line).replace(/['’)\]]+$/, '');
  if (!s) return false;
  return !/[.!?…]$/.test(s);
}

/** Relationship words a speaker uses for a family member, mapped to the cast-card words that mean the same person. */
const RELATIONS = {
  brother: ['brother'], sister: ['sister'], mom: ['mother', 'mom', 'mum'], mum: ['mother', 'mom', 'mum'], mother: ['mother', 'mom', 'mum'],
  mama: ['mother', 'mom'], dad: ['father', 'dad'], father: ['father', 'dad'], papa: ['father', 'dad'],
  grandma: ['grandmother', 'grandma', 'gran', 'nana'], grandmother: ['grandmother', 'grandma', 'gran', 'nana'], nana: ['grandmother', 'grandma', 'nana'],
  grandpa: ['grandfather', 'grandpa', 'granddad'], grandfather: ['grandfather', 'grandpa', 'granddad'],
  wife: ['wife', 'partner'], husband: ['husband', 'partner'], son: ['son'], daughter: ['daughter'],
  aunt: ['aunt'], uncle: ['uncle'], cousin: ['cousin'],
};
const REL_RE = new RegExp(String.raw`\b(?:my|our)\s+(?:(?:little|younger|baby|big|older|oldest|youngest|elder|kid|twin|step|late)\s+)*(${Object.keys(RELATIONS).join('|')})\b`, 'gi');
const words = (c) => [c.oneWordRole, c.name, c.relationship, c.relationshipToSubject].filter(Boolean).map((x) => String(x).toLowerCase());

/** Cast tags a line names by relationship ("my little brother") — only when exactly one cast member fits that word. */
export function namedCast(line, cast = [], speaker) {
  const out = new Set();
  for (const m of strip(line).matchAll(REL_RE)) {
    const want = RELATIONS[m[1].toLowerCase()];
    const hits = cast.filter((c) => c.elementTag !== speaker && words(c).some((w) => want.some((r) => new RegExp(`\\b${r}\\b`).test(w))));
    if (hits.length === 1) out.add(hits[0].elementTag);
  }
  return [...out];
}

/** Small scripted acting beats that read as a tic when every shot repeats them. Eye life is a performance-block rule, not a shot action. */
export const MICRO_ACTIONS = { blink: /\bblink(?:s|ing|ed)?\b/i, nod: /\bnod(?:s|ding|ded)?\b/i, glance: /\bglanc(?:e|es|ing)\b/i, sigh: /\bsigh(?:s|ing)?\b/i, exhale: /\bexhal(?:e|es|ing)\b/i, swallow: /\bswallow(?:s|ing)?\b/i };
export const MICRO_ACTION_MAX = 2;
/** { beat: [shot numbers] } for every micro-action used in more than MICRO_ACTION_MAX shots. texts: [{ n, text }] action text only. */
export function repeatedMicroActions(texts) {
  const out = {};
  for (const [k, re] of Object.entries(MICRO_ACTIONS)) { const ns = texts.filter((t) => re.test(t.text)).map((t) => t.n); if (ns.length > MICRO_ACTION_MAX) out[k] = ns; }
  return out;
}

/** Words or patterns indicating personality, demeanor, posture, or whimsy in character descriptions (Dan Kieft craft). */
export const PERSONALITY_TRAIT_RE = /\b(?:cheerful|easy in|conviction|dreamer|skeptic|curious|unflappable|earnest|stubborn|mischiev(?:ous|y)|lively|warm|tender|deadpan|calm|quiet|proud|gentle|fiery|fierce|witty|playful|eager|serious|steady|confessional|posture|demeanor|attitude|energy|poised|perched|slouch(?:ing)?|sprightly|bouncy|restless|laid-back|humor(?:ous)?|amused|dignity|teasing|spirited|solemn|whims(?:y|ical)|kindness|reassur(?:ing|ed)|charming|zest|spark|mischief)\b/i;

/** True when a character description includes demeanor, posture, personality or whimsy rather than sterile anatomy only. */
export function hasPersonalityOrDemeanor(desc) {
  return PERSONALITY_TRAIT_RE.test(String(desc ?? ''));
}

/** Words indicating physical business, hand actions, or moving holds (Dan Kieft craft). */
export const PHYSICAL_BUSINESS_WORDS = /\b(?:hand|hands|finger|fingers|palm|palms|fist|knuckle|chin|knee|knees|lap|shoulder|chest|head|hold|holds|held|holding|turning|turns|turned|spin|spins|spinning|fidget|fidgets|fidgeting|prop|props|propping|propped|tap|taps|tapping|drum|drums|drumming|grip|grips|gripping|pull|pulls|pulling|rest|rests|resting|lean|leans|leaning|shift|shifts|shifting|reach|reaches|reaching|peel|peels|peeling|fold|folds|folding|adjust|adjusts|adjusting|unfasten|unfastens|pour|pours|pouring|sip|sips|sipping|cup|mug|glass|bottle|phone|strap|key|keys|keychain|ring|pencil|pen|crayon|paper|napkin|breath|breathe|breathes|breathing|settle|settles|settling|drift|drifts|drifting|sway|sways|swaying|slap|slaps|slapping|push|pushes|pushing|rub|rubs|rubbing|stroke|strokes|stroking)\b/i;

/** Verbs representing purely passive listening, watching, sitting, or nodding. */
export const PASSIVE_ACTION_VERBS = /\b(?:listens?(?:\s+(?:intently|quietly|silently|closely|patiently))?|watches?(?:\s+(?:intently|quietly|silently|closely))?|looks?(?:\s+(?:on|at\s+@[\w_]+|over))?|smiles?(?:\s+and\s+nods?)?|nods?(?:\s+(?:along|in\s+agreement|quietly|slowly))?|sits?(?:\s+(?:quietly|silently|still))?)\b/i;

/**
 * Returns true if an action string describes passive character behavior without physical business or moving holds (Dan Kieft craft).
 * E.g. "@Theo listens quietly", "@Sister watches @Shaz", "@Theo smiles and nods along".
 */
export function isPassiveAction(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  return PASSIVE_ACTION_VERBS.test(s) && !PHYSICAL_BUSINESS_WORDS.test(s);
}


