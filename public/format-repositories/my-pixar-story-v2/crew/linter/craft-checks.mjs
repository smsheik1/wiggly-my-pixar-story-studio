// Cheap craft checks on the Story Director output (r5 review comparison). Generic for every family: they compare the
// script against the family's own answers, never against any one story.
//   VERBATIM_SHARE_LOW   too few spoken lines in the family's own words (measured, not the self-declared source kind)
//   PROP_NOT_IN_ANSWERS  a concrete object in a prop lock or a shot that no answer, cast note or photo note mentions
// (Cast listed in a scene but never shown is PRESENT_NEVER_SEEN in shot-locks.mjs.)
import { words, sentences, lcs, allStrings, inputCorpus, resolveAnswer, hasAnswers, NEAR_VERBATIM } from './answer-sources.mjs';

// r5 data, measured by verbatimShare below (self-declared kinds in brackets): a no-review draft 96% [80%], a compressed
// draft 44% [26%], the same draft after review 94% [94%]. Below 60% most lines are the writer's words, not the family's:
// error (the retry/review must restore whole sentences). 60-75% is legal but thin: warning, so the review looks.
// Needs >= 6 lines to judge.
export const VERBATIM_SHARE_ERROR = 0.6;
export const VERBATIM_SHARE_WARN = 0.75;
export const VERBATIM_MIN_LINES = 6;

const spoken = (data) => (data?.segments ?? []).flatMap((seg, si) => (seg.shots ?? []).flatMap((sh, hi) => ['dialogue', 'narration']
  .filter((k) => sh[k]?.line).map((k) => ({ where: `${seg.segmentId ?? si + 1}.${sh.shotNumber ?? hi + 1}`, line: sh[k].line, source: sh[k].source }))));

/**
 * Shortest stretch of the source that holds the line's words in order (greedy, skipping words the line added). The line
 * is "compact" when the stretch is barely longer than the matched words: nothing was cut from the middle of the
 * family's sentence. `lw`/`sw` are word lists. Returns { matched, span }.
 */
export function tightestSpan(lw, sw) {
  let best = { matched: 0, span: Infinity };
  for (let st = 0; st < sw.length; st++) {
    if (sw[st] !== lw[0] && !(lw.length > 1 && sw[st] === lw[1])) continue;
    let j = st, m = 0, last = st;
    for (const w of lw) { let k = j; while (k < sw.length && sw[k] !== w) k++; if (k < sw.length && k - j <= 6) { m++; last = k; j = k + 1; } }
    const span = last - st + 1;
    if (m > best.matched || (m === best.matched && span < best.span)) best = { matched: m, span };
  }
  return best;
}

/**
 * Share of spoken lines (connectives excluded) that are the family's own sentences: the line's words are the answer's
 * words in order (>= NEAR_VERBATIM of the line) and come from one unbroken stretch of the answer (>= NEAR_VERBATIM of
 * that stretch is kept), so words were neither swapped nor squeezed out of the middle. Splitting a long sentence across
 * shots keeps every part whole; compressing it ("I went to a bootcamp, got a job at 19") does not.
 */
// Answers reply to a question, so a pronoun there can lean on the question ("her" = the person asked about). Naming that
// person, or saying "you" to them, keeps the family's sentence: pronouns, cast names and "you" match each other, and so
// do the verb forms that agree with them.
const PERSON = new Set('he him his himself she her hers herself they them their theirs themselves you your yours yourself'.split(' '));
const AGREE = { is: 'be', are: 'be', was: 'be-past', were: 'be-past', has: 'have', have: 'have', does: 'do', do: 'do', "doesn't": "don't", "don't": "don't", "isn't": "aren't", "aren't": "aren't", "wasn't": "weren't", "weren't": "weren't" };
export function personWords(data) {
  return new Set((data?.cast ?? []).flatMap((c) => [c.name, c.realPerson]).flatMap((n) => words(n)));
}
export const canonWord = (w, names = new Set()) => PERSON.has(w) || names.has(w.replace(/'s$/, '')) ? '<person>' : AGREE[w] ?? w;

export function verbatimShare(data, input = {}) {
  const all = allStrings(input.answers), names = personWords(data), cw = (t) => words(t).map((w) => canonWord(w, names));
  const rows = spoken(data).filter((l) => l.source?.kind !== 'connective').map((l) => {
    const cited = l.source?.answer ? resolveAnswer(input.answers ?? {}, l.source.answer) : null;
    const lw = cw(String(l.line).replace(/[{}]/g, ''));
    let score = 0, compact = 0;
    for (const t of cited ? [cited, ...all] : all) {
      const sp = tightestSpan(lw, cw(t)), sc = lw.length ? sp.matched / lw.length : 0, cp = sp.matched / Math.max(1, sp.span);
      if (sc > score + 1e-9 || (Math.abs(sc - score) < 1e-9 && cp > compact)) { score = sc; compact = cp; }
      if (cited && score >= NEAR_VERBATIM && compact >= NEAR_VERBATIM) break;
    }
    const own = lw.length > 0 && score >= NEAR_VERBATIM && compact >= NEAR_VERBATIM;
    return { where: l.where, line: l.line, score, compact, own, why: own ? '' : score < NEAR_VERBATIM ? 'reworded' : 'shortened' };
  });
  const own = rows.filter((r) => r.own);
  return { lines: rows.length, own: own.length, share: rows.length ? own.length / rows.length : 1, reworded: rows.filter((r) => !r.own) };
}

export function checkVerbatimShare(data, input = {}) {
  if (!hasAnswers(input.answers)) return [];
  const v = verbatimShare(data, input);
  if (v.lines < VERBATIM_MIN_LINES || v.share >= VERBATIM_SHARE_WARN) return [];
  const pct = Math.round(v.share * 100);
  const list = v.reworded.slice(0, 6).map((r) => `${r.where} '${String(r.line).replace(/^\{|\}$/g, '')}' (${r.why})`).join('; ');
  const sev = v.share < VERBATIM_SHARE_ERROR ? 'error' : 'warning';
  return [{ severity: sev, code: 'VERBATIM_SHARE_LOW', path: 'segments',
    message: `Only ${v.own} of ${v.lines} spoken lines (${pct}%) are the family's own sentences (${sev === 'error' ? `need at least ${VERBATIM_SHARE_ERROR * 100}%` : `aim for ${VERBATIM_SHARE_WARN * 100}%+`}). Restore their whole sentences where one fits, splitting long ones across shots, instead of shortening or rewording. Not whole: ${list}${v.reworded.length > 6 ? ` and ${v.reworded.length - 6} more` : ''}.` }];
}

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
