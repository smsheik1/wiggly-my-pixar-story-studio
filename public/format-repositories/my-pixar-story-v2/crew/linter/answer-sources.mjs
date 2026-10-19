// WIGGLY answer tracing (deterministic). Every spoken/narrated line in the Story Director's output carries
// source: { answer: '<path into input.answers>', kind?: 'connective' }, and every part
// lists answerSources (the answers whose memories it depicts). This checks each cited answer exists and that the
// line really comes from it: its facts come from that answer (lines are written freely, not quoted), and names / numbers / times in a line appear in the answer it cites (so a detail cannot be
// borrowed from a different answer). Spelling variants (case, hyphens, possessives, plurals, one-letter typos,
// digits vs number words) count as the same word.
// The LLM audit in scripts/trace-answers.mjs (extract facts -> trace each fact) stays a post-run report; this is
// the cheap gate that runs on every draft. Text helpers here are shared with check-stage-play.mjs.

export const SOURCE_KINDS = ['verbatim', 'paraphrase', 'connective'];
export const NEAR_VERBATIM = 0.8; // share of the line's words reproduced in order from one answer passage
export const PARAPHRASE_MIN = 0.5; // share of the line's key words found in the cited answer
export const CONNECTIVE_MAX_WORDS = 12;
/** Connective (unsourced, scene-setting) lines allowed before a warning: max(2, 20% of all lines). */
export const connectiveCap = (lines) => Math.max(2, Math.floor(lines * 0.2));

/** Every string inside a value (objects/arrays walked in order). */
export const allStrings = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => allStrings(x, out)); return out; };
/** Lower-case word tokens; apostrophes kept so "don't" stays one word. */
export const words = (t) => String(t ?? '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean);
/** Sentences (split on . ! ? and line breaks). */
export const sentences = (t) => String(t ?? '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
/** Answer sentences from every string in the answers. */
export const answerSentences = (answers) => allStrings(answers).flatMap(sentences);

const squash = (w) => String(w).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/'s$/, '').replace(/[^a-z0-9]/g, '');
const stem = (w) => (w.length > 4 ? w.replace(/(?:ing|ed|es|s)$/, '') : w);
function lev1(a, b) { // edit distance <= 1
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, d = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++d > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return d + (a.length - i) + (b.length - j) <= 1;
}
/** Same word, allowing common-sense spelling variants. */
export function sameWord(a, b) {
  const x = squash(a), y = squash(b);
  if (!x || !y) return false;
  if (x === y || stem(x) === stem(y)) return true;
  return Math.min(x.length, y.length) >= 5 && lev1(x, y);
}
/** Longest common subsequence length with sameWord equality. */
export const lcs = (a, b) => { let prev = new Array(b.length + 1).fill(0); for (const x of a) { const cur = [0]; for (let j = 0; j < b.length; j++) cur.push(sameWord(x, b[j]) ? prev[j] + 1 : Math.max(prev[j + 1], cur[j])); prev = cur; } return prev[b.length]; };

const STOP = new Set(("a an the and or but so of in on at to for from by with as into over under up down out off is am are was were be been being "
  + "i me my mine you your we our us he him his she her it its they them their this that these those there here then than "
  + "do did does done have has had will would can could should just not no yes very really too also all any some what when "
  + "where who why how if oh ok okay like get got go going went one i'm i'd i'll i've you're it's that's don't didn't can't").split(' '));
/** Key (content) words of a text. */
export const keyWords = (t) => words(t).filter((w) => w.length >= 3 && !STOP.has(w));

/** Resolve 'a.b.0.c' (optionally prefixed 'answers.') inside input.answers to its text, or null if it does not exist. */
export function resolveAnswer(answers, path) {
  const p = String(path ?? '').trim().replace(/^answers\./, '');
  if (!p || !answers || typeof answers !== 'object') return null;
  let v = answers;
  for (const k of p.split('.')) {
    if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, k)) v = v[k];
    else return null;
  }
  const text = allStrings(v).join('\n').trim();
  return text || null;
}
/** Every leaf answer path with text, e.g. ['scene1Childhood.memory', ...]. */
export function answerPaths(answers, prefix = '', out = []) {
  if (typeof answers === 'string') { if (answers.trim() && prefix) out.push(prefix); return out; }
  if (answers && typeof answers === 'object') for (const [k, v] of Object.entries(answers)) answerPaths(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}
export const hasAnswers = (answers) => answerPaths(answers).length > 0;

// ---- facts: names and numbers a line asserts ----
const NUM = { zero: 0, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, million: 1000000 };
/** Numeric values a text states (digits, 3pm, 20k, 20,000, number words; 'one' is ignored as too common). */
export function numbersIn(t) {
  const s = String(t ?? '').toLowerCase(), out = new Set();
  for (const m of s.matchAll(/\b(\d[\d,]*(?:\.\d+)?)\s?(k\b)?/g)) {
    const v = Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1);
    if (!Number.isFinite(v)) continue;
    out.add(v);
    if (v >= 1000 && v % 1000 === 0) { out.add(v / 1000); out.add(1000); }
  }
  for (const w of words(s)) for (const part of w.split('-')) if (part in NUM) out.add(NUM[part]);
  return out;
}
const ALWAYS_OK = new Set(['tv', 'i', "i'm", "i'd", "i'll", "i've", 'ok', 'okay', 'mom', 'mum', 'mama', 'mommy', 'dad', 'daddy', 'papa', 'god', 'oh', 'hey']);
/** Capitalised words used mid-sentence anywhere in a corpus: the input's proper nouns. */
export function properNouns(texts) {
  const out = new Set();
  for (const t of texts) for (const s of sentences(t)) {
    const toks = s.split(/\s+/);
    toks.forEach((tok, i) => { const w = tok.replace(/^[^A-Za-z]+|[^A-Za-z'-]+$/g, ''); if (i > 0 && /^[A-Z][a-z]/.test(w) && !/[:"\u201c]$/.test(toks[i - 1])) out.add(squash(w)); });
  }
  return out;
}
/** Names in a line: capitalised mid-sentence words, plus sentence-initial ones that are known proper nouns of the input. */
export function namesIn(line, known = new Set()) {
  const out = [];
  for (const s of sentences(String(line ?? '').replace(/[{}]/g, ''))) s.split(/\s+/).forEach((tok, i) => {
    const w = tok.replace(/^[^A-Za-z]+|[^A-Za-z'-]+$/g, '');
    if (!/^(?:[A-Z][a-z]|[A-Z]{2,}$)/.test(w) || ALWAYS_OK.has(w.toLowerCase())) return;
    if (i > 0 || known.has(squash(w))) out.push(w);
  });
  return out;
}
const textHasWord = (text, w) => { const k = squash(w); return squash(text.replace(/\s+/g, '')).includes(k) || words(text).some((x) => sameWord(x, w)); };

/** Best in-order overlap of the line with any 1-2 consecutive sentences of the text (0..1 of the line's words). */
export function verbatimScore(line, text) {
  const lw = words(String(line ?? '').replace(/[{}]/g, ''));
  if (!lw.length) return 0;
  const ss = sentences(text);
  let best = 0;
  for (let i = 0; i < ss.length; i++) for (const win of [ss[i], ss[i] + ' ' + (ss[i + 1] ?? '')]) best = Math.max(best, lcs(lw, words(win)) / lw.length);
  return best;
}
/** Share of the line's key words found in the text (names in `skip`, e.g. the cast, are not counted; number words match digits). */
export function keyWordScore(line, text, skip = new Set()) {
  const kw = keyWords(String(line ?? '').replace(/[{}]/g, '')).filter((w) => !skip.has(squash(w)));
  if (!kw.length) return 1;
  const tw = words(text), nums = numbersIn(text);
  return kw.filter((w) => tw.some((x) => sameWord(x, w)) || [...numbersIn(w)].some((v) => nums.has(v))).length / kw.length;
}

/** Text the whole input may mention: answers, subject, cast descriptions, photo characters, voice note. */
export function inputCorpus(input = {}) {
  return [...allStrings(input.answers), String(input.subject ?? ''), ...allStrings(input.castDescriptions ?? []), ...allStrings(input.photoCharacters ?? []), String(input.voiceNoteTranscript ?? '')].filter(Boolean);
}
/** Names any line may use regardless of source: the subject's words and every cast card's name, realPerson and tag. */
function freeNames(input, cast) {
  const out = new Set(words(input.subject).map(squash));
  for (const c of cast ?? []) for (const t of [c.name, c.realPerson, String(c.elementTag ?? '').slice(1).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')]) for (const w of words(t)) out.add(squash(w));
  return out;
}

/** One row per spoken/narrated line: where it is, what it cites, how well it matches, and its problems. */
export function traceLines(data, input = {}) {
  const answers = input.answers ?? {};
  const corpus = inputCorpus(input);
  const known = properNouns(corpus);
  const free = freeNames(input, data?.cast);
  const rows = [];
  (data?.segments ?? []).forEach((seg, si) => (seg.shots ?? []).forEach((shot, hi) => {
    for (const k of ['dialogue', 'narration']) {
      const d = shot[k]; if (!d?.line) continue;
      const where = `${seg.segmentId ?? si + 1}.${shot.shotNumber ?? hi + 1}`;
      const path = `segments.${si}.shots.${hi}.${k}`;
      const src = d.source && typeof d.source === 'object' ? d.source : null;
      const row = { where, path, field: k, speaker: d.speaker, line: d.line, answer: src?.answer ?? null, kind: src?.kind ?? null, score: null, problems: [] };
      rows.push(row);
      if (!src || (src.kind != null && !SOURCE_KINDS.includes(src.kind))) { row.problems.push({ code: 'LINE_SOURCE_MISSING' }); continue; }
      const text = src.answer ? resolveAnswer(answers, src.answer) : null;
      if (src.answer && !text) { row.problems.push({ code: 'LINE_SOURCE_UNKNOWN' }); continue; }
      if (src.kind !== 'connective' && !src.answer) { row.problems.push({ code: 'LINE_SOURCE_MISSING' }); continue; }
      // names / numbers must be in the cited answer; a connective line carries none (it would need a source)
      const conn = src.kind === 'connective';
      const scopeNums = conn ? new Set() : numbersIn(text);
      const found = (has) => answerPaths(answers).filter((p) => has(resolveAnswer(answers, p)));
      for (const n of namesIn(d.line, known)) if (!free.has(squash(n)) && (conn || !textHasWord(text, n)))
        row.problems.push({ code: 'LINE_FACT_NOT_IN_SOURCE', fact: n, foundIn: found((t) => textHasWord(t, n)) });
      for (const v of numbersIn(d.line)) if (!scopeNums.has(v))
        row.problems.push({ code: 'LINE_FACT_NOT_IN_SOURCE', fact: String(v), foundIn: found((t) => numbersIn(t).has(v)) });
      if (!conn) {
        row.score = keyWordScore(d.line, text, free);
        if (row.score < PARAPHRASE_MIN) row.problems.push({ code: 'LINE_SOURCE_MISMATCH' });
      } else if (words(d.line).length > CONNECTIVE_MAX_WORDS) row.problems.push({ code: 'CONNECTIVE_LINE_LONG' });
    }
  }));
  return rows;
}

const pct = (x) => `${Math.round(x * 100)}%`;
const q = (s) => `'${String(s).replace(/^\{|\}$/g, '')}'`;
/** Gate issues for answer tracing. Skipped entirely when the input carries no answers (nothing to trace against). */
export function checkAnswerSources(data, input = {}) {
  const issues = [];
  const answers = input?.answers ?? {};
  if (!hasAnswers(answers)) return issues;
  const err = (code, message, path) => issues.push({ severity: 'error', code, message, ...(path ? { path } : {}) });
  const warn = (code, message, path) => issues.push({ severity: 'warning', code, message, ...(path ? { path } : {}) });
  const known = properNouns(inputCorpus(input)), free = freeNames(input, data?.cast);
  const ids = answerPaths(answers);
  const idList = ids.slice(0, 12).join(', ') + (ids.length > 12 ? ', ...' : '');
  const rows = traceLines(data, input);
  for (const r of rows) for (const p of r.problems) {
    const at = `Shot ${r.where} ${r.field} ${q(r.line)}`;
    if (p.code === 'LINE_SOURCE_MISSING') err(p.code, `${at} has no source. Add source: { answer: '<answer id>', answer: '<answer id>' } naming the answer whose facts it tells (answer ids: ${idList}), or kind 'connective' for a short scene-setting line with no new facts.`, `${r.path}.source`);
    else if (p.code === 'LINE_SOURCE_UNKNOWN') err(p.code, `${at} cites answer '${r.answer}', which is not in the family's answers (answer ids: ${idList}).`, `${r.path}.source.answer`);
    else if (p.code === 'LINE_FACT_NOT_IN_SOURCE') err(p.code, r.kind === 'connective'
      ? `${at} is marked connective but states '${p.fact}'. Connective lines carry no facts (names, numbers, times)${p.foundIn.length ? `; '${p.fact}' is in '${p.foundIn.join("', '")}', so cite that answer` : '; the family never wrote it, so drop it'}.`
      : `${at} says '${p.fact}', which is not in the answer it cites ('${r.answer}')${p.foundIn.length ? `; it appears in '${p.foundIn.join("', '")}' instead. Do not move a detail from one memory into another: cite that answer, or drop the detail` : '. Do not invent names, numbers or times; use only what the family wrote'}.`, `${r.path}.line`);
    else if (p.code === 'LINE_SOURCE_MISMATCH') warn(p.code, `${at} cites '${r.answer}' but only ${pct(r.score)} of its key words are in that answer. Check it tells that answer's facts and cite the answer it really comes from.`, `${r.path}.source`);
    else if (p.code === 'CONNECTIVE_LINE_LONG') warn(p.code, `${at} is a connective line of ${words(r.line).length} words (max ${CONNECTIVE_MAX_WORDS}). Connective lines only set the scene; anything longer should come from an answer.`, `${r.path}.line`);
  }
  const conn = rows.filter((r) => r.kind === 'connective');
  if (conn.length > connectiveCap(rows.length))
    warn('CONNECTIVE_LINES_HIGH', `${conn.length} of ${rows.length} lines are connective (unsourced): ${conn.map((r) => r.where).join(', ')}. Keep at most ${connectiveCap(rows.length)}; take the rest from the family's answers.`, 'segments');
  // every part names the answers whose memories it depicts
  (data?.segments ?? []).forEach((seg, si) => {
    const src = seg.answerSources;
    if (!Array.isArray(src) || !src.length) err('SEGMENT_SOURCE_MISSING', `Part ${seg.segmentId ?? si + 1} has no answerSources. List the answer id(s) whose memories this part depicts (answer ids: ${idList}).`, `segments.${si}.answerSources`);
    else for (const [i, a] of src.entries()) if (!resolveAnswer(answers, a))
      err('SEGMENT_SOURCE_UNKNOWN', `Part ${seg.segmentId ?? si + 1} lists answer '${a}' in answerSources, which is not in the family's answers (answer ids: ${idList}).`, `segments.${si}.answerSources.${i}`);
    // what the part shows: names / digits / times in whatWeSee should come from the part's own answers (warning: shots also hold neutral staging)
    const texts = (Array.isArray(src) ? src : []).map((a) => resolveAnswer(answers, a)).filter(Boolean);
    if (!texts.length) return;
    const text = texts.join('\n'), nums = numbersIn(text);
    (seg.shots ?? []).forEach((shot, hi) => {
      const see = String(shot.whatWeSee ?? '').replace(/@[\w_]+/g, 'someone');
      const facts = [...namesIn(see, known).filter((n) => !free.has(squash(n)) && !textHasWord(text, n)), ...[...numbersIn(see.replace(/[a-z]+/gi, (w) => (w.toLowerCase() in NUM ? ' ' : w)))].filter((v) => !nums.has(v)).map(String)]; // digits and times only: number words in staging are head counts
      if (facts.length) warn('SHOT_FACT_NOT_IN_SOURCE', `Shot ${seg.segmentId ?? si + 1}.${shot.shotNumber ?? hi + 1} shows '${facts.join("', '")}', which is not in this part's answerSources (${src.join(', ')}). Show only what those answers describe, or list the answer it comes from.`, `segments.${si}.shots.${hi}.whatWeSee`);
    });
  });
  return issues;
}

/** Trace as data (for the self-review log): counts plus one compact row per line. null when there are no answers. */
export function traceSummary(data, input = {}) {
  if (!hasAnswers(input?.answers)) return null;
  const rows = traceLines(data, input);
  return {
    lines: rows.length, withProblems: rows.filter((r) => r.problems.length).length,
    connective: rows.filter((r) => r.kind === 'connective').length, connectiveCap: connectiveCap(rows.length),
    rows: rows.map((r) => ({ where: r.where, field: r.field, kind: r.kind, answer: r.answer, score: r.score == null ? null : Math.round(r.score * 100) / 100,
      problems: r.problems.map((p) => (p.fact ? `${p.code}(${p.fact})` : p.code)), line: r.line })),
  };
}
/** Compact plain-text trace table for the self-review critique ('' when there are no answers). */
export function traceReport(data, input = {}) {
  const t = traceSummary(data, input);
  if (!t) return '';
  return [
    `Answer trace (deterministic): ${t.lines} lines, ${t.withProblems} with problems, ${t.connective} connective (cap ${t.connectiveCap}).`,
    'shot | field | kind | cites | match | problems | line',
    ...t.rows.map((r) => `${r.where} | ${r.field} | ${r.kind ?? '-'} | ${r.answer ?? '-'} | ${r.score == null ? '-' : pct(r.score)} | ${r.problems.join(', ') || 'ok'} | ${r.line}`),
  ].join('\n');
}

// ---- extra cast: every cast card's person must be named in the input ----
const RELATIONS = [
  ['mom', 'mother', 'mum', 'mama', 'mommy', 'ma', 'ammi', 'amma'], ['dad', 'father', 'papa', 'daddy', 'pa', 'abbu', 'baba'],
  ['sister', 'sis'], ['brother', 'bro'], ['wife', 'spouse'], ['husband', 'spouse'], ['son'], ['daughter'],
  ['grandma', 'grandmother', 'nana', 'gran', 'granny', 'nani', 'dadi'], ['grandpa', 'grandfather', 'granddad', 'nana', 'nanu', 'dada'],
  ['aunt', 'auntie', 'aunty'], ['uncle'], ['cousin'], ['friend', 'buddy', 'bestie'], ['teacher', 'coach'], ['baby', 'newborn'],
];
const GENERIC = new Set(['young', 'younger', 'adult', 'grown', 'older', 'old', 'teen', 'teenage', 'little', 'kid', 'child', 'boy', 'girl', 'man', 'woman', 'the', 'and', 'with', 'narrator']);
/** Cast cards whose person is not named in the answers, subject, cast descriptions or photo characters. */
export function checkExtraCast(data, input = {}) {
  const issues = [];
  if (!hasAnswers(input?.answers)) return issues;
  const corpusWords = inputCorpus(input).flatMap(words);
  const corpusSquash = squash(inputCorpus(input).join(''));
  const named = (w) => corpusWords.some((x) => sameWord(x, w)) || (w.length >= 4 && corpusSquash.includes(squash(w)));
  (data?.cast ?? []).forEach((c, i) => {
    const tagWords = String(c.elementTag ?? '').slice(1).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    const cand = [...new Set([c.realPerson, c.name, tagWords].flatMap(words))].filter((w) => w.length >= 2 && !GENERIC.has(w));
    const ok = cand.some((w) => named(w) || RELATIONS.some((g) => g.includes(w) && g.some(named)));
    if (!ok) issues.push({ severity: 'error', code: 'CAST_NOT_IN_ANSWERS', path: `cast.${i}`,
      message: `Cast ${c.elementTag ?? c.name} ('${c.realPerson ?? c.name}') is not named anywhere in the family's answers, subject, cast notes or photos. Only people the family mentions exist; remove the card and its lines.` });
  });
  return issues;
}
