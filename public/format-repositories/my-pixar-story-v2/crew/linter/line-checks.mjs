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
