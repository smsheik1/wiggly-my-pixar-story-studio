// WIGGLY: deterministic clean-up of a compiled clip, run in code after the model submits (no model call).
//  1. Look lines carry the character's full outfit (the approved sheet's look when there is one): every garment and the
//     shoes, with near-duplicate items merged ('hijab fully covering…' + 'green hijab fully covering…' -> one item),
//     plus locked accessories and visual tells word for word.
//  2. A prop named in full by the scene ('black two-door coupe with faded paint') is never shortened to its bare
//     head noun elsewhere ('faded coupe', 'the coupe').
//  3. Actions name a prop plainly ('the trading cards'); its resting state lives only on the Props line, and when someone
//     holds it the Props line says so ('trading cards in @A's hands; more scattered face-up across the rug').
//  4. [MAINTAIN CONSISTENCY] states each body scale once.
//  5. Automatic deterministic stamping of camera directions, on-screen cast, locked wardrobe, voiceover mouth state,
//     mandatory exclusions, and teen word sanitization.
import { dedupeItems } from './look-dedupe.mjs';
import { accentOf } from '../story-director/schema.mjs';

const STATE_START = /\s+(?:parked|stacked|scattered|glowing|lying|resting|leaning|propped|hanging|sitting|standing|placed|set|plugged|piled|fanned|spread|open|closed|on|in|against|across|under|beside|by|next)\b/i;
const HOLD = /\b(?:clutch|clutches|clutching|grip|grips|gripping|hold|holds|holding|lift|lifts|lifting|raise|raises|raising|wave|waves|waving|fan|fans|fanning|shuffle|shuffles|shuffling|grab|grabs|grabbing|hug|hugs|hugging|clasp|clasps|clasping|pick|picks|picking up|cradle|cradles|cradling)\b/i;
const words = (s) => String(s ?? '').toLowerCase().replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter(Boolean);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const TEEN_WORDS = /\b(teen|teens|teenage|teenager|minor|(?:thirteen|fourteen|fifteen|sixteen|seventeen|1[3-7])[- ]year[- ]old)\b/i;

/** Sanitize underage wording outside spoken braces {...} */
export function sanitizeTeenWords(text) {
  return String(text ?? '').split(/(\{[^}]*\}|"[^"]*")/g).map((part, i) => {
    if (i % 2 === 1) return part;
    return part
      .replace(/\b1[3-7][- ]year[- ]old\b/gi, 'eighteen-year-old')
      .replace(/\b(thirteen|fourteen|fifteen|sixteen|seventeen)[- ]year[- ]old\b/gi, 'eighteen-year-old')
      .replace(/\bteenagers\b/gi, 'young adults')
      .replace(/\bteenager\b/gi, 'young adult')
      .replace(/\bteenage\b/gi, 'young adult')
      .replace(/\bteens\b/gi, 'young adults')
      .replace(/(?<![@\w])teen\b/gi, 'young adult')
      .replace(/\bminor\b/gi, 'young adult');
  }).join('');
}

/** The locked wording for one character: signature accessories from the cast card, then the visual tell. */
export function lockPhrases(card = {}, character = {}) {
  const acc = [card?.signatureAccent, ...(card?.signatureAccessories ?? [])].map(accentOf).filter((x) => x.length >= 3);
  const tell = String(character?.visualTell ?? '').trim();
  const out = dedupeItems([...acc.map((x) => ({ kind: 'accessory', text: x })), ...(tell ? [{ kind: 'tell', text: tell }] : [])]);
  return out;
}

/** Canonical Look line for a character, combining locked phrases with full outfit items. */
export function canonicalLookLine(tag, card, character) {
  const phrases = lockPhrases(card, character).map((p) => p.text);
  const outfit = character?.mainOutfit;
  const items = fullLookLine(phrases, outfit);
  return items.length ? `Look ${tag}: ${items.join('; ')}.` : '';
}

/** 'black two-door coupe with faded paint parked with driver door closed' -> name + the state after it. */
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

/** Rewrite one SHOT block with deterministic stamping. */
export function finalizeShotBlock(text, { outfits = {}, props = [], cards = new Map(), chars = new Map(), srcShot = null } = {}) {
  let lines = String(text).split('\n');
  const held = [];

  // Update existing Look lines or replace props in action lines
  lines = lines.map((l) => {
    const look = /^(\s*Look (@[\w_]+):\s*)(.*?)\.?\s*$/.exec(l);
    if (look) {
      const tag = look[2];
      const card = cards.get(tag), char = chars.get(tag);
      if (card || char) {
        const can = canonicalLookLine(tag, card, char);
        if (can) return can;
      }
      return outfits[tag] ? `${look[1]}${fullLookLine(look[3].split(/\s*;\s*/), outfits[tag]).join('; ')}.` : l;
    }
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

  for (const l of lines) {
    if (/^\s*(?:SHOT \d|Camera:|Composition|On screen:|Location:|Props:|Look |Hard cut)/.test(l) || /\{.*\}|"/.test(l)) continue;
    for (const st of props) {
      const { name, rest } = splitPropState(st);
      if (!rest || held.some((h) => h.st === st)) continue;
      const m = new RegExp(`\\b(?:the|his|her|their)\\s+${esc(name)}\\b`, 'i').exec(l);
      if (!m) continue;
      const clause = l.slice(0, m.index).split(/[.;]|\bwhile\b/).at(-1);
      const who = (l.slice(0, m.index).match(/@[\w_]+/g) ?? []).at(-1);
      if (HOLD.test(clause) && who) held.push({ st, name, rest, who });
    }
  }

  // Rewrite Props line if present
  let hasProps = false;
  lines = lines.map((l) => {
    const pm = /^(\s*Props:\s*)(.*?)\.?\s*$/.exec(l);
    if (pm) {
      hasProps = true;
      for (const st of props) {
        const { name, rest } = splitPropState(st);
        if (rest && /s$/i.test(name) && pm[2].includes(`${name} in @`) && pm[2].includes(st)) {
          return `${pm[1]}${pm[2].replace(st, `more ${rest}`)}.`;
        }
      }
      if (!held.length) return l;
      let body = pm[2];
      for (const h of [...new Map(held.map((x) => [x.st, x])).values()]) {
        const plural = /s$/i.test(h.name);
        body = body.replace(h.st, `${h.name} in ${h.who}'s hands${plural ? `; more ${h.rest}` : ''}`);
      }
      return `${pm[1]}${body}.`;
    }
    return l;
  });

  // Stamping: if srcShot is provided, enforce On screen, Look lines, Camera, and Props
  if (srcShot) {
    const wantOnScreen = srcShot.onScreen || srcShot.cast || [];
    if (wantOnScreen.length) {
      const onScreenLine = `On screen: ${wantOnScreen.join(', ')}.`;
      const onIdx = lines.findIndex((l) => /^\s*On screen:/i.test(l));
      if (onIdx >= 0) {
        lines[onIdx] = onScreenLine;
      } else {
        const insertAfter = lines.findIndex((l) => /^\s*(?:Location|Camera):/i.test(l));
        const at = insertAfter >= 0 ? insertAfter + 1 : 1;
        lines.splice(at, 0, onScreenLine);
      }

      // Ensure Look line for each character in wantOnScreen
      for (const tag of wantOnScreen) {
        const card = cards.get(tag), char = chars.get(tag);
        const can = canonicalLookLine(tag, card, char);
        if (can) {
          const lIdx = lines.findIndex((l) => new RegExp(`^\\s*Look ${esc(tag)}:`, 'i').test(l));
          if (lIdx >= 0) {
            lines[lIdx] = can;
          } else {
            const onPos = lines.findIndex((l) => /^\s*On screen:/i.test(l));
            lines.splice(onPos + 1, 0, can);
          }
        }
      }
    }

    // Camera line
    if (srcShot.framing) {
      const wantCam = `Camera: ${srcShot.framing}, ${srcShot.cameraAngle || 'eye level'}, ${srcShot.cameraMove || 'static'}.`;
      const camIdx = lines.findIndex((l) => /^\s*Camera:/i.test(l));
      if (camIdx >= 0) {
        lines[camIdx] = wantCam;
      } else {
        lines.splice(1, 0, wantCam);
      }
    }

    // Props line if missing but scene has props
    if (!hasProps && props.length) {
      const pLine = `Props: ${props.join('; ')}.`;
      const lastLook = lines.findLastIndex((l) => /^\s*(?:Look @|On screen:|Location:|Camera:)/i.test(l));
      lines.splice(Math.max(1, lastLook + 1), 0, pLine);
    }

    // Voiceover mouth closed line
    const isVoiceover = !!(srcShot.narration || (srcShot.dialogue && /voiceover|off[- ]?camera/i.test(srcShot.dialogue.mode || '')));
    if (isVoiceover && !lines.some((l) => /no one on screen speaks/i.test(l))) {
      const cutIdx = lines.findIndex((l) => /^\s*Hard cut\.?/i.test(l));
      const mouthLine = 'No one on screen speaks; every on-screen mouth stays closed.';
      if (cutIdx >= 0) {
        lines.splice(cutIdx, 0, mouthLine);
      } else {
        lines.push(mouthLine);
      }
    }
  }

  // Ensure ends with Hard cut.
  if (!lines.some((l) => /^\s*Hard cut\.?/i.test(l))) {
    lines.push('Hard cut.');
  }

  return lines.filter(Boolean).join('\n');
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
      if (preW.some((w) => proper.has(w.toLowerCase()))) return m0; // already named ('black 2000 two-door coupe with the faded paint')
      let k = preW.length; while (k > 0 && (nw.has(preW[k - 1].toLowerCase()) || /^(?:old|parked)$/i.test(preW[k - 1]))) k--;
      const keep = preW.slice(0, k).join(' ');
      const postKeep = post && nw.has(post.trim().toLowerCase()) ? '' : (post ?? '');
      const repl = seen ? head : name; seen = true;
      return `${keep ? keep + ' ' : ''}${repl}${postKeep}`;
    });
    // the full name once per line; later mentions in the same line read 'the <head>' ('… of the coupe')
    t = t.replace(new RegExp(`\\b([Aa])n\\s+(${esc(name)})`, 'g'), '$1 $2');
    let n = 0;
    t = t.replace(new RegExp(`(\\b(?:the|a)\\s+)?${esc(name)}`, 'gi'), (m0, det, off, all) => (!n++ ? m0 : det || !/\b(?:the|a|an|his|her|its|their)\s+(?:[\w-]+\s+)?$/i.test(all.slice(Math.max(0, off - 30), off)) ? `the ${head}` : head));
  }
  return t;
}

/** [MAINTAIN CONSISTENCY]: drop the generic scale sentence when per-character scale sentences already say it. */
export function dedupeScale(text) {
  const sents = String(text ?? '').split(/(?<=\.)\s+/);
  const specific = sents.filter((s) => /heads tall/i.test(s) && !/^toddler\b/i.test(s.trim()));
  return sents.filter((s) => !(/^toddler\b/i.test(s.trim()) && specific.length)).join(' ');
}

/** [REFERENCE MATERIALS]: each '@tag [ImageN]? = …' line carries the input's own description of that reference. */
export function referenceLines(text, refs = []) {
  const d = new Map(refs.map((r) => [r.tag, r.plainEnglishDescription]));
  return String(text ?? '').replace(/^(@[\w_]+)((?:\s*\[Image\d+\])?\s*=\s*)(.*)$/gm, (m0, tag, mid) => (d.get(tag) ? `${tag}${mid}${d.get(tag).replace(/\.?$/, '.')}` : m0));
}
const span = (ns) => (ns.length === 1 ? `shot ${ns[0]}` : `shots ${ns[0]} to ${ns.at(-1)}`);
/** [CONTINUITY]: the location and camera-side sentences say which shots are where (multi-location clips). */
export function continuityLocations(text, shots = [], locations = []) {
  const order = [...new Set(shots.map((s) => s.locationTag))];
  if (order.length < 2) return text;
  const name = new Map(locations.map((l) => [l.elementName, l.settingName]));
  const by = order.map((tag) => ({ tag, ns: shots.filter((s) => s.locationTag === tag).map((s) => s.shotNumber) }));
  const loc = `Location: ${by.map((b) => `the ${String(name.get(b.tag) ?? b.tag.slice(1).replaceAll('_', ' ')).toLowerCase()} in ${b.tag} for ${span(b.ns)}`).join(' and ')}. Never leave them.`;
  const cam = `The camera stays on the same side of the action ${by.map((b) => `as in ${b.tag} for ${span(b.ns)}`).join(' and ')} and never crosses to the other side.`;
  return String(text ?? '')
    .replace(/Location:[^\n]*?(?:throughout\.\s*Never leave (?:them|it|these places)\.|Never leave (?:them|it|these places)\.|throughout\.)/, loc)
    .replace(/The camera stays on the same side of the action[^.]*\./, cam);
}

/** Finalize one compiled clip (tenBlocks + shots) against the SC input. Returns a new clip (compiledPrompt not rebuilt). */
export function finalizeClip(seg, input) {
  if (!seg?.tenBlocks) return seg;
  const cards = new Map((input?.cast ?? []).map((c) => [c.elementTag, c]));
  const chars = new Map((input?.characters ?? []).map((c) => [c.elementTag, c]));
  const outfits = Object.fromEntries((input?.characters ?? []).filter((c) => c.mainOutfit).map((c) => [c.elementTag, c.mainOutfit]));
  const byScene = propsByScene(input);
  const srcSeg = (input?.segments ?? []).find((s) => s.segmentId === seg.segmentId);
  const sceneIds = (seg.shots ?? []).map((s) => s.sceneId);
  const names = [...new Set(sceneIds.flatMap((id) => byScene.get(id) ?? []).map((p) => splitPropState(p).name))];

  const tb = { ...seg.tenBlocks };
  tb.block5_shots = String(tb.block5_shots ?? '').split(/(?=^SHOT \d+ \|)/m).map((blk) => {
    const n = Number(/^SHOT (\d+)/.exec(blk)?.[1]);
    const sh = (seg.shots ?? []).find((s) => s.shotNumber === n);
    const srcShot = srcSeg?.shots?.find((x) => x.sceneId === sh?.sceneId) || srcSeg?.shots?.find((x) => x.shotNumber === n);
    return finalizeShotBlock(blk, {
      outfits,
      props: sh ? byScene.get(sh.sceneId) ?? [] : (srcShot ? byScene.get(srcShot.sceneId) ?? [] : []),
      cards,
      chars,
      srcShot
    });
  }).join('');

  for (const k of ['block3_goal', 'block4_continuity', 'block6_visualStyle', 'block8_audio', 'block10_maintainConsistency']) {
    tb[k] = fullPropNames(tb[k], names);
  }
  tb.block10_maintainConsistency = dedupeScale(tb.block10_maintainConsistency);
  tb.block1_referenceMaterials = referenceLines(tb.block1_referenceMaterials, input?.references ?? []);
  tb.block4_continuity = continuityLocations(tb.block4_continuity, seg.shots ?? [], input?.locations ?? []);

  // Ensure block1 reference closing law
  const refClosing = 'Each reference is one person or one object and appears once. No duplicates.';
  if (tb.block1_referenceMaterials && !tb.block1_referenceMaterials.includes('Each reference is one person or one object and appears once')) {
    tb.block1_referenceMaterials = `${tb.block1_referenceMaterials.trim()}\n${refClosing}`;
  }

  // Ensure block9 exclusions dialogue rule
  const exclDialogue = 'The only spoken words in the entire segment are the lines in braces.';
  if (tb.block9_exclusions && !tb.block9_exclusions.includes('The only spoken words in the entire segment are the lines in braces')) {
    tb.block9_exclusions = `${exclDialogue} ${tb.block9_exclusions.trim()}`;
  }
  const hasNarration = (seg.shots ?? []).some((s) => s.dialogue && /voiceover|off[- ]?camera/i.test(s.dialogue.mode || ''))
    || (srcSeg?.shots ?? []).some((s) => s.narration || (s.dialogue && /voiceover|off[- ]?camera/i.test(s.dialogue.mode || '')));
  if (tb.block9_exclusions && hasNarration && !/no humming, mumbling/i.test(tb.block9_exclusions)) {
    tb.block9_exclusions = `${tb.block9_exclusions.trim()} No humming, mumbling, breaths-as-words or partial words from anyone on screen.`;
  }

  // Sanitize teen words across all blocks
  for (const k of Object.keys(tb)) {
    tb[k] = sanitizeTeenWords(tb[k]);
  }

  const shots = (seg.shots ?? []).map((s) => {
    let action = s.action;
    for (const st of byScene.get(s.sceneId) ?? []) {
      const { name, rest } = splitPropState(st);
      if (rest) action = action.replace(new RegExp(`(\\b(?:the|his|her|their|its|a)\\s+)?${esc(st)}`, 'gi'), (m, d) => `${d ?? 'the '}${name}`);
    }
    return { ...s, action };
  });

  return { ...seg, tenBlocks: tb, shots };
}

/** Finalize every clip (or only the segmentIds in `only`, e.g. the parts a patch recompiled) of a Seedance Compiler output and rebuild each compiledPrompt from its blocks. */
export function finalizeOutput(out, input, assemble, only) {
  if (!out || !Array.isArray(out.segments)) return out;
  return { ...out, segments: out.segments.map((s) => { if (only && !only.includes(s.segmentId)) return s; const f = finalizeClip(s, input); return f?.tenBlocks ? { ...f, compiledPrompt: assemble(f.tenBlocks) } : f; }) };
}
