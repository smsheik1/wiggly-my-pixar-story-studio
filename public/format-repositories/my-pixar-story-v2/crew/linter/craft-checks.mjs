// Cheap craft checks on the Story Director output (r5 review comparison). Generic for every family: they compare the
// script against the family's own answers, never against any one story.
//   PROP_NOT_IN_ANSWERS  a concrete object in a prop lock or a shot that no answer, cast note or photo note mentions
// (Cast listed in a scene but never shown is PRESENT_NEVER_SEEN in shot-locks.mjs.)
import { words, sentences, lcs, allStrings, inputCorpus, resolveAnswer, hasAnswers, NEAR_VERBATIM } from './answer-sources.mjs';

// ---- props / objects not in the answers ----
// Everyday room furniture, fixtures, the fixed parts of a car and body parts are set dressing, not story facts: never flagged.
const SET_DRESSING = new Set(('room wall walls floor ceiling window windows door doors doorway corner table desk chair chairs couch sofa bed pillow '
  + 'cushion rug carpet lamp light lights shelf shelves bookshelf counter kitchen hallway stairs porch yard street sidewalk road sky sun '
  + 'tv television screen seat seats curtain curtains frame frames photo photos picture pictures plant plants mug cup glass plate bag '
  + 'head face eyes eye hand hands arm arms shoulder shoulders chest knee knees lap leg legs feet foot finger fingers hair chin cheek lips mouth back side '
  + 'dashboard wheel engine driver passenger seatbelt mirror windshield '
  + 'breath breathing smile tears gaze moment beat silence air distance edge center middle front top bottom line way place spot').split(/\s+/));
const STOP_PHRASE = /\b(?:on|in|at|with|over|under|beside|behind|against|across|into|onto|from|of|for|to|by|near|inside|outside|around|while|and|or|but|open|closed|off|lit|turned|face[- ]up|face[- ]down|upside[- ]down|upright)\b|[,;.:(]/i;
const PARTICIPLE = /^(?:[a-z-]+(?:ed|ing)|held|worn|set|laid|hung|lit|left|spread|kept|shown|stuck|sat|stood)$/;
// 'a stack of cards', 'a pair of glasses': the object is what follows 'of'.
const QUANTITY_OF = /^.*?\b(?:stack|pile|pair|set|handful|bunch|row|heap|couple|piece|bit|lot|sheet|cup|glass|bowl|plate)s? of\s+/;
const NOT_NOUN = /^(?:forward|back|backward|down|up|away|out|over|close|closer|again|still|together|alone|slowly|softly|quietly|gently|first|last|next|other|same|whole|only|very|just|then|now)$/;
const stem = (w) => w.toLowerCase().replace(/'s$/, '').replace(/(?:ies)$/, 'y').replace(/(?:es|s)$/, '');

/** Head noun of an object phrase: 'the faded coupe parked in the drive' -> 'coupe'; 'trading cards stacked' -> 'cards'. */
export function objectNoun(phrase) {
  const toks = String(phrase ?? '').replace(/@[\w_]+('s)?/g, ' ').toLowerCase().replace(QUANTITY_OF, '').split(STOP_PHRASE)[0].split(/\s+/).filter(Boolean)
    .filter((t) => !/^(?:the|a|an|his|her|their|its|my|our|some|one|two|three|small|big|little|old|new|soft|worn)$/.test(t));
  const cut = toks.findIndex((t, i) => i > 0 && PARTICIPLE.test(t) && toks.slice(0, i).some((x) => !PARTICIPLE.test(x)));
  const head = (cut > 0 ? toks.slice(0, cut) : toks).filter((t) => /^[a-z][a-z-]+$/.test(t));
  const h = head.at(-1) ?? null;
  return h && !PARTICIPLE.test(h) && !NOT_NOUN.test(h) ? h : null;
}
/**
 * Objects named after a determiner in a shot description: 'pulls the blanket over' -> blanket, 'the laptop glows' ->
 * laptop, 'a boxy TV' -> tv. In running prose the noun is the first word after the determiner (the next one when the
 * first is a describing word); similes ('held like a beaker') are not objects in the shot.
 */
const DESCRIBING = /^(?:[a-z-]+(?:y|ful|ous|ish|less|ed|ing|en)|soft|old|new|small|big|little|tiny|huge|worn|warm|cold|dark|bright|pale|plain|clear|long|short|tall|low|high|red|blue|green|yellow|white|black|brown|grey|gray|pink|purple|orange|empty|full|open|single|whole|same|other|first|last)$/;
const shotObjects = (text) => [...String(text ?? '').replace(/@[\w_]+('s)?/g, ' ').replace(/\blike (?:a|an|the) [a-z-]+/gi, ' ')
  .matchAll(/\b(?:the|a|an|his|her|their)\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/gi)]
  .map((m) => { const [w1, w2] = [m[1].toLowerCase(), m[2]?.toLowerCase()]; const n = DESCRIBING.test(w1) && w2 && !STOP_PHRASE.test(w2) ? w2 : w1; return objectNoun(n); })
  .filter(Boolean);

export function checkPropsTraceable(data, input = {}) {
  if (!hasAnswers(input.answers)) return [];
  const corpus = new Set(inputCorpus(input).flatMap((t) => words(t)).map(stem));
  const found = new Map(); // noun -> where[]
  const add = (noun, where) => { if (!noun || noun.length < 3) return; const s = stem(noun); if (SET_DRESSING.has(noun) || SET_DRESSING.has(s) || corpus.has(s)) return; if (!found.has(noun)) found.set(noun, []); found.get(noun).push(where); };
  (data?.segments ?? []).forEach((seg, si) => {
    const id = seg.segmentId ?? si + 1;
    (seg.scenes ?? []).forEach((sc, ci) => (sc.props ?? []).forEach((p) => String(p).split(/,\s*/).forEach((part) => add(objectNoun(part), `part ${id} scene ${ci + 1} props`))));
    (seg.shots ?? []).forEach((sh, hi) => shotObjects(sh.whatWeSee).forEach((n) => add(n, `shot ${id}.${sh.shotNumber ?? hi + 1}`)));
  });
  return [...found].map(([noun, where]) => ({ severity: 'warning', code: 'PROP_NOT_IN_ANSWERS', path: 'segments',
    message: `"${noun}" (${[...new Set(where)].slice(0, 4).join(', ')}${new Set(where).size > 4 ? ', …' : ''}) is not in the answers, cast notes or photo notes. Keep it as quiet background or cut it; never make an invented object a story beat or a callback.` }));
}
