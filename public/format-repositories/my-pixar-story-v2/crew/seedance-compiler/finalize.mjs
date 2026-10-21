// WIGGLY: deterministic clean-up of a compiled clip, run in code after the model submits (no model call).
//  1. Look lines carry the character's full outfit (the approved sheet's look when there is one): every garment and the
//     shoes, with near-duplicate items merged ('hijab fully covering…' + 'green hijab fully covering…' -> one item).
//  2. A prop named in full by the scene ('black Honda Accord coupe with faded paint') is never shortened to its bare
//     head noun elsewhere ('faded coupe', 'the coupe').
//  3. Actions name a prop plainly ('the trading cards'); its resting state lives only on the Props line, and when someone
//     holds it the Props line says so ('trading cards in @A's hands; more scattered face-up across the rug').
//  4. [MAINTAIN CONSISTENCY] states each body scale once.
import { dedupeItems } from './look-dedupe.mjs';

const STATE_START = /\s+(?:parked|stacked|scattered|glowing|lying|resting|leaning|propped|hanging|sitting|standing|placed|set|plugged|piled|fanned|spread|open|closed|on|in|against|across|under|beside|by|next)\b/i;
const HOLD = /\b(?:clutch|clutches|clutching|grip|grips|gripping|hold|holds|holding|lift|lifts|lifting|raise|raises|raising|wave|waves|waving|fan|fans|fanning|shuffle|shuffles|shuffling|grab|grabs|grabbing|hug|hugs|hugging|clasp|clasps|clasping|pick|picks|picking up|cradle|cradles|cradling)\b/i;
const words = (s) => String(s ?? '').toLowerCase().replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter(Boolean);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 'black Honda Accord coupe with faded paint parked with driver door closed' -> name + the state after it. */
export function splitPropState(state) {
  const s = String(state ?? '').trim().replace(/\.$/, '');
  const m = STATE_START.exec(s);
  return m ? { name: s.slice(0, m.index), rest: s.slice(m.index).trim() } : { name: s, rest: '' };
}
/** Head noun of a prop name: the last word before any 'with …' tail ('… coupe with faded paint' -> 'coupe'). */
export const headNoun = (name) => words(String(name).split(/\s+with\s+/i)[0]).at(-1);

/** Merge two look items when one is the other plus up to two extra words (usually a colour), e.g. 'green hijab …'. */
function mergeLook(items) {
  const out = [...items];
  for (let i = 0; i < out.length; i++) for (let j = 0; j < out.length; j++) {
    if (i === j || !out[i] || !out[j]) continue;
    const a = words(out[i]), b = new Set(words(out[j]));
    const extra = a.filter((w) => !b.has(w)), shared = a.length - extra.length;
    if (((shared >= 3 && extra.length <= 2) || (shared >= 2 && extra.length <= 1 && b.has(a.at(-1)))) && words(out[j]).length > a.length) { out[j] = extra.length && !words(out[j]).slice(0, 3).some((w) => extra.includes(w)) ? `${extra.join(' ')} ${out[j]}` : out[j]; out[i] = null; }
  }
  return out.filter(Boolean);
}
/** Split an outfit sentence into items on top-level commas. */
export const outfitItems = (o) => String(o ?? '').replace(/\.$/, '').split(/\s*,\s*/).filter(Boolean);
export function fullLookLine(lineItems, outfit) {
  return dedupeItems(mergeLook([...lineItems, ...outfitItems(outfit)]));
}

function propsByScene(input) {
  const m = new Map();
  for (const sg of input?.segments ?? []) for (const sc of sg.scenes ?? []) for (const n of sc.shots ?? []) {
    const sh = (sg.shots ?? []).find((x) => x.shotNumber === n);
    if (sh) m.set(sh.sceneId, sc.props ?? []);
  }
  return m;
}

/** Rewrite one SHOT block. */
export function finalizeShotBlock(text, { outfits = {}, props = [] } = {}) {
  const lines = String(text).split('\n');
  const held = [];
  const out = lines.map((l) => {
    const look = /^(\s*Look (@[\w_]+):\s*)(.*?)\.?\s*$/.exec(l);
    if (look) return outfits[look[2]] ? `${look[1]}${fullLookLine(look[3].split(/\s*;\s*/), outfits[look[2]]).join('; ')}.` : l;
    if (/^\s*(?:SHOT \d|Camera:|Composition|On screen:|Location:|Props:|Hard cut)/.test(l) || /\{.*\}|"/.test(l)) return l;
    let a = l;
    for (const st of props) {
      const { name, rest } = splitPropState(st);
      if (!rest) continue;
      a = a.replace(new RegExp(`(\\b(?:the|his|her|their|its|a)\\s+)?${esc(st)}`, 'gi'), (m0, det, off) => {
        const before = a.slice(Math.max(0, off - 40), off);
        if (HOLD.test(before.split(/[.;]/).at(-1))) { const who = (a.slice(0, off).match(/@[\w_]+/g) ?? []).at(-1); if (who) held.push({ st, name, rest, who }); }
        return `${det ?? 'the '}${name}`;
      });
    }
    return a;
  });
  return out.map((l) => {
    const pm = /^(\s*Props:\s*)(.*?)\.?\s*$/.exec(l);
    if (pm) for (const st of props) { const { name, rest } = splitPropState(st); if (rest && /s$/i.test(name) && pm[2].includes(`${name} in @`) && pm[2].includes(st)) { l = `${pm[1]}${pm[2].replace(st, `more ${rest}`)}.`; return l; } }
    if (!pm || !held.length) return l;
    let body = pm[2];
    for (const h of [...new Map(held.map((x) => [x.st, x])).values()]) {
      const plural = /s$/i.test(h.name);
      body = body.replace(h.st, `${h.name} in ${h.who}'s hands${plural ? `; more ${h.rest}` : ''}`);
    }
    return `${pm[1]}${body}.`;
  }).join('\n');
}

/** Replace bare head-noun mentions ('faded coupe', 'the coupe') with the full prop name in free text. Per line: the
 *  first mention gets the full name, later ones in the same line stay 'the <head>'. Spoken lines are never touched. */
export function fullPropNames(text, names) {
  return String(text ?? '').split('\n').map((line) => (/\{[^}]*\}|"[^"]*"/.test(line) ? line : fullNamesInLine(line, names))).join('\n');
}
function fullNamesInLine(line, names) {
  let t = line;
  for (const name of names) {
    const head = headNoun(name), nameW = name.split(/\s+/), nw = new Set(words(name));
    const proper = new Set(nameW.filter((w) => /^[A-Z0-9]/.test(w)).map((w) => w.toLowerCase()));
    if (!head || nameW.length < 3) continue;
    let seen = t.toLowerCase().includes(name.toLowerCase());
    const re = new RegExp(`(?<![@\\w])((?:[A-Za-z0-9-]+\\s+){0,3})${esc(head)}\\b(?![_\\w])(\\s+[A-Za-z-]+)?`, 'gi');
    t = t.replace(re, (m0, pre, post, off, all) => {
      if (all.slice(off).toLowerCase().startsWith(name.toLowerCase()) || all.slice(off + pre.length).toLowerCase().startsWith(name.slice(name.toLowerCase().indexOf(head)).toLowerCase())) return m0;
      if (post && /^\s*interior\b/i.test(post)) return m0;
      const preW = pre.trim() ? pre.trim().split(/\s+/) : [];
      if (preW.some((w) => proper.has(w.toLowerCase()))) return m0; // already named ('black 2000 Honda Accord coupe with the faded paint')
      let k = preW.length; while (k > 0 && (nw.has(preW[k - 1].toLowerCase()) || /^(?:old|parked)$/i.test(preW[k - 1]))) k--;
      const keep = preW.slice(0, k).join(' ');
      const postKeep = post && nw.has(post.trim().toLowerCase()) ? '' : (post ?? '');
      const repl = seen ? head : name; seen = true;
      return `${keep ? keep + ' ' : ''}${repl}${postKeep}`;
    });
    // the full name once per line; later mentions in the same line read 'the <head>' ('… of the coupe')
    let n = 0;
    t = t.replace(new RegExp(`(\\b(?:the|a)\\s+)?${esc(name)}`, 'gi'), (m0) => (n++ ? `the ${head}` : m0));
  }
  return t;
}

/** [MAINTAIN CONSISTENCY]: drop the generic scale sentence when per-character scale sentences already say it. */
export function dedupeScale(text) {
  const sents = String(text ?? '').split(/(?<=\.)\s+/);
  const specific = sents.filter((s) => /heads tall/i.test(s) && !/^toddler\b/i.test(s.trim()));
  return sents.filter((s) => !(/^toddler\b/i.test(s.trim()) && specific.length)).join(' ');
}

/** Finalize one compiled clip (tenBlocks + shots) against the SC input. Returns a new clip (compiledPrompt not rebuilt). */
export function finalizeClip(seg, input) {
  if (!seg?.tenBlocks) return seg;
  const outfits = Object.fromEntries((input?.characters ?? []).filter((c) => c.mainOutfit).map((c) => [c.elementTag, c.mainOutfit]));
  const byScene = propsByScene(input);
  const sceneIds = (seg.shots ?? []).map((s) => s.sceneId);
  const names = [...new Set(sceneIds.flatMap((id) => byScene.get(id) ?? []).map((p) => splitPropState(p).name))];
  const tb = { ...seg.tenBlocks };
  tb.block5_shots = String(tb.block5_shots ?? '').split(/(?=^SHOT \d+ \|)/m).map((blk) => {
    const n = Number(/^SHOT (\d+)/.exec(blk)?.[1]);
    const sh = (seg.shots ?? []).find((s) => s.shotNumber === n);
    return finalizeShotBlock(blk, { outfits, props: sh ? byScene.get(sh.sceneId) ?? [] : [] });
  }).join('');
  for (const k of ['block3_goal', 'block4_continuity', 'block5_shots', 'block6_visualStyle', 'block8_audio', 'block10_maintainConsistency']) {
    if (k === 'block5_shots') tb[k] = tb[k].split('\n').map((l) => (/^\s*(?:Props:|Look )/.test(l) ? l : fullPropNames(l, names))).join('\n');
    else tb[k] = fullPropNames(tb[k], names);
  }
  tb.block10_maintainConsistency = dedupeScale(tb.block10_maintainConsistency);
  const shots = (seg.shots ?? []).map((s) => {
    let action = s.action;
    for (const st of byScene.get(s.sceneId) ?? []) { const { name, rest } = splitPropState(st); if (rest) action = action.replace(new RegExp(`(\\b(?:the|his|her|their|its|a)\\s+)?${esc(st)}`, 'gi'), (m, d) => `${d ?? 'the '}${name}`); }
    return { ...s, action: fullPropNames(action, names) };
  });
  return { ...seg, tenBlocks: tb, shots };
}

/** Finalize every clip (or only the segmentIds in `only`, e.g. the parts a patch recompiled) of a Seedance Compiler output and rebuild each compiledPrompt from its blocks. */
export function finalizeOutput(out, input, assemble, only) {
  if (!out || !Array.isArray(out.segments)) return out;
  return { ...out, segments: out.segments.map((s) => { if (only && !only.includes(s.segmentId)) return s; const f = finalizeClip(s, input); return f?.tenBlocks ? { ...f, compiledPrompt: assemble(f.tenBlocks) } : f; }) };
}
