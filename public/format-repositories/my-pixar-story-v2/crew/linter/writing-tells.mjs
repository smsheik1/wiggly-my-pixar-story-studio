// Writing-tells linter: reads the JSON block in shared/writing-tells.md and checks Story Director and Seedance Compiler outputs.
// Hard fails (errors): em dash in a spoken/narrated line, forced negation, hard-banned phrase.
// Warnings: flagged words, stacked finale wisdom lines, few or zero contractions in speech.
// Not checked: prompt-prose em dashes (the SC role's camera phrases use them) and filler directions (moving holds are required).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TELLS_FILE = fileURLToPath(new URL('../../shared/writing-tells.md', import.meta.url));
let cached = null;
export function loadTells(file = TELLS_FILE) {
  if (cached && file === TELLS_FILE) return cached;
  const md = readFileSync(file, 'utf8');
  const m = /<!-- writing-tells:json:start -->\s*```json\s*([\s\S]*?)```\s*<!-- writing-tells:json:end -->/.exec(md);
  if (!m) throw new Error(`writing-tells: no JSON block in ${file}`);
  const j = JSON.parse(m[1]);
  const t = { raw: j, emDash: j.hard.emDash, forcedNegation: j.hard.forcedNegation.map((r) => new RegExp(r, 'i')), phrases: j.hard.phrases.map((p) => p.toLowerCase()),
    words: j.warn.words.map((w) => new RegExp(`\\b${w}\\b`, 'i')),
    wisdom: new RegExp(j.warn.wisdomLine, 'i'), wisdomMax: j.warn.wisdomStackMax, contractable: new RegExp(j.warn.contractable, 'gi'), contraction: new RegExp(j.warn.contraction, 'gi'), minContractable: j.warn.minContractableForWarning };
  if (file === TELLS_FILE) cached = t;
  return t;
}
/** The rubric's do-not-write section, for agent skills. */
export function doNotWriteList(file = TELLS_FILE) {
  const md = readFileSync(file, 'utf8');
  const m = /## Do-not-write list[^\n]*\n([\s\S]*?)\n## /.exec(md);
  return m ? `## Writing tells: do not write (from shared/writing-tells.md)\n${m[1].trim()}\n` : '';
}

const clean = (l) => String(l ?? '').replace(/^\{|\}$/g, '').replace(/[\u2018\u2019]/g, "'");
/** Check spoken/narrated lines. lines: [{ text, path, finale }]. directions/prose are extracted for the critic but not code-checked. */
export function checkWritingTells({ lines = [] }, t = loadTells()) {
  const issues = [];
  const err = (code, message, path) => issues.push({ severity: 'error', code, message, ...(path ? { path } : {}) });
  const warn = (code, message, path) => issues.push({ severity: 'warning', code, message, ...(path ? { path } : {}) });
  for (const l of lines) {
    const s = clean(l.text), low = s.toLowerCase();
    if (s.includes(t.emDash)) err('WRITING_TELL_EM_DASH', `Line '${s}' has an em dash. Use a comma, a period, or two lines.`, l.path);
    if (/[A-Za-z0-9]\s?\/\s?[A-Za-z0-9]/.test(s)) err('WRITING_TELL_SLASH', `Line '${s}' has a slash. The voice reads it badly; write the words ("air conditioning", "with", "and", "all day").`, l.path);
    const neg = t.forcedNegation.find((r) => r.test(s));
    if (neg) err('WRITING_TELL_FORCED_NEGATION', `Line '${s}' uses forced negation ("it's not X, it's Y"). Say it directly.`, l.path);
    const ph = t.phrases.find((p) => low.includes(p));
    if (ph) err('WRITING_TELL_BANNED_PHRASE', `Line '${s}' uses the banned phrase '${ph}'.`, l.path);
    const w = t.words.find((r) => r.test(s));
    if (w) warn('WRITING_TELL_FLAGGED_WORD', `Line '${s}' uses the flagged word '${w.source.replace(/\\b/g, '')}'.`, l.path);
  }
  // Stacked wisdom: more than wisdomMax consecutive finale lines that read as advice/moral.
  let run = [];
  const flush = () => { if (run.length > t.wisdomMax) warn('WRITING_TELL_WISDOM_STACK', `${run.length} wisdom lines in a row in the finale (${run.map((x) => `'${clean(x.text)}'`).join(', ')}). Max ${t.wisdomMax}; break the run with an on-screen action that shows the idea (a shot where someone does something), not an inserted memory or callback.`, run[0].path); run = []; };
  for (const l of lines.filter((x) => x.finale)) { if (t.wisdom.test(clean(l.text))) run.push(l); else flush(); }
  flush();
  // Contractions: only meaningful across all speech.
  const all = lines.map((l) => clean(l.text)).join(' ');
  const contractable = all.match(t.contractable) ?? [], contractions = all.match(t.contraction) ?? [];
  if (contractable.length >= t.minContractable && contractions.length === 0)
    warn('WRITING_TELL_NO_CONTRACTIONS', `Dialogue and narration use no contractions (${contractable.length} stiff forms like '${contractable[0]}'). Spoken lines say "don't", "it's", "I'll".`);
  else if (contractable.length >= t.minContractable && contractable.length > contractions.length * 2)
    warn('WRITING_TELL_FEW_CONTRACTIONS', `Speech has ${contractable.length} uncontracted forms ('${[...new Set(contractable.map((x) => x.toLowerCase()))].slice(0, 4).join("', '")}') vs ${contractions.length} contractions.`);
  return issues;
}

/** Lines/directions from a Story Director output. */
export function storyDirectorTexts(sd) {
  const lines = [], directions = [];
  const segs = sd?.segments ?? [];
  segs.forEach((g, si) => (g.shots ?? []).forEach((h, hi) => {
    const p = `segments.${si}.shots.${hi}`;
    for (const k of ['dialogue', 'narration']) if (h[k]?.line) lines.push({ text: h[k].line, path: `${p}.${k}`, finale: si === segs.length - 1 && segs.length > 1 });
    directions.push({ text: h.whatWeSee, path: `${p}.whatWeSee` });
  }));
  return { lines, directions };
}
/** Lines/directions/prose from a Seedance Compiler output (brace lines inside the compiled prompt are speech). */
export function seedanceTexts(sc) {
  const lines = [], directions = [], prose = [];
  const segs = sc?.segments ?? [];
  segs.forEach((g, si) => {
    const p = `segments.${si}`;
    for (const m of String(g.compiledPrompt ?? '').matchAll(/\{([^{}\n]{2,300})\}/g)) lines.push({ text: m[1], path: `${p}.compiledPrompt`, finale: si === segs.length - 1 && segs.length > 1 });
    (g.shots ?? []).forEach((h, hi) => directions.push({ text: h.action, path: `${p}.shots.${hi}.action` }));
    prose.push({ text: String(g.compiledPrompt ?? '').replace(/\{[^{}\n]*\}/g, ''), path: `${p}.compiledPrompt` });
  });
  return { lines, directions, prose };
}
export const validateWritingTells = (agent, out, t) => checkWritingTells(agent === 'seedance-compiler' ? seedanceTexts(out) : storyDirectorTexts(out), t);

/** Rubric-style points from linter issues (critic does the full score): hard 3, warnings 2, flagged words 1. */
export function tellsScore(issues) {
  const pts = (i) => (i.code === 'WRITING_TELL_FLAGGED_WORD' ? 1 : i.severity === 'error' ? 3 : 2);
  const score = issues.reduce((n, i) => n + pts(i), 0);
  const band = score <= 5 ? 'CLEAN' : score <= 15 ? 'LIGHT EDIT' : score <= 30 ? 'REWRITE PASS' : score <= 50 ? 'HEAVY REWRITE' : 'START OVER';
  return { score, band };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir] = process.argv.slice(2);
  if (!dir) { console.error('usage: writing-tells.mjs <runs/<id>/outputs>'); process.exit(2); }
  let total = [];
  for (const a of ['story-director', 'seedance-compiler']) {
    let out; try { out = JSON.parse(readFileSync(`${dir}/${a}.json`, 'utf8')); } catch { console.log(`${a}: no output`); continue; }
    const iss = validateWritingTells(a, out); total = total.concat(iss);
    console.log(`\n## ${a}: ${iss.filter((i) => i.severity === 'error').length} hard, ${iss.filter((i) => i.severity !== 'error').length} warnings`);
    for (const i of iss) console.log(`- ${i.severity === 'error' ? 'HARD' : 'warn'} [${i.code}] ${i.message}`);
  }
  const s = tellsScore(total); console.log(`\nLinter points: ${s.score} (${s.band}); report only, the critic adds judgment tells.`);
}
