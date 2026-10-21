// Deterministic gate for the Storyboard Artist. Generic rules (no story-specific names):
//  coverage: every shot drawn exactly once, story order, one part per sheet, panels numbered 1..n, max 8 per sheet
//  staging:  panel background = the plate that owns the shot; panel cast = the shot's on-screen cast; only known cast
//  WARDROBE: each character wears their own Character Architect outfit for that part (copied word for word)
//  TWINS:    no two characters in one panel share an outfit (siblings must never read as twins)
//  ACCESSORY: every accessory in a character's approved outfit or identity is named in each panel they appear in
//  PROP_LEAK: a character's signature accessory / prop appears only on that character, never on anyone else
import { outfitFor } from '../storyboard-artist/input.mjs';
import { PANELS_PER_SHEET } from '../storyboard-artist/schema.mjs';
import { checkShotMix } from '../storyboard-artist/style.mjs';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Worn / carried accessory nouns. Matched as whole words, singular or plural.
export const ACCESSORIES = ['hijab', 'headscarf', 'scarf', 'veil', 'turban', 'hat', 'cap', 'beanie', 'hood', 'headband', 'bandana', 'glasses', 'goggles',
  'earrings', 'earring', 'necklace', 'bracelet', 'watch', 'ring', 'tie', 'bowtie', 'backpack', 'bag', 'purse', 'apron', 'gloves', 'mask', 'bow', 'cape', 'crown', 'headphones', 'lanyard'];
// eyewear: tinted and plain glasses are told apart (the prefixed word is captured whole)
const ACC_RE = new RegExp(`\\b(${ACCESSORIES.map((a) => (a === 'glasses' ? '(?:sun)?glasses' : a)).join('|')})s?\\b`, 'g');
// Strip negations ("no hijab", "without glasses", "uncovered") so a stated absence is not read as wearing it.
const stripNeg = (s) => norm(s).replace(/\b(?:no|without|not|never|free of|instead of|removed)\s+(?:a |an |the |any )?(?:[a-z]+ ){0,2}?[a-z]+/g, ' ');
export const accessoriesIn = (s) => { const t = stripNeg(s); const o = new Set(); for (const m of t.matchAll(ACC_RE)) o.add(m[1]); return o; };

/** The character's signature accessory phrases (outfit pieces or identity tell naming an accessory), e.g. 'gold stud earrings'. */
export function signatureAccessories(c, segmentId) {
  const parts = [...String(outfitFor(c, segmentId) ?? '').split(/,|;|\bwith\b/), c.visualTell ?? ''].map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const x of parts) if (accessoriesIn(x).size && !out.some((o) => norm(o) === norm(x))) out.push(x.replace(/^(?:and|a|an|matching)\s+/i, ''));
  return out.filter((x) => !out.some((o) => o !== x && norm(o).includes(norm(x))));
}

/** Accessories a character owns: those in their CA outfit for the part plus their visual tell. */
export const ownedAccessories = (c, segmentId) => accessoriesIn(`${outfitFor(c, segmentId)} ${c.visualTell ?? ''}`);

export function validateStoryboard(out, input) {
  const issues = [];
  const err = (code, message, path) => issues.push({ severity: 'error', code, message, ...(path ? { path } : {}) });
  const warn = (code, message, path) => issues.push({ severity: 'warning', code, message, ...(path ? { path } : {}) });
  const shots = input?.shots ?? [];
  const byId = new Map(shots.map((s) => [s.shotId, s]));
  const chars = new Map((input?.characters ?? []).map((c) => [c.tag, c]));
  const order = shots.map((s) => s.shotId);
  const drawn = [];
  (out?.sheets ?? []).forEach((sh, si) => {
    const p0 = `sheets.${si}`;
    if (sh.panels.length > PANELS_PER_SHEET) err('SB_SHEET_OVERFLOW', `sheet ${si + 1} has ${sh.panels.length} panels; max ${PANELS_PER_SHEET}`, `${p0}.panels`);
    sh.panels.forEach((p, pi) => {
      const pp = `${p0}.panels.${pi}`;
      if (p.panelNumber !== pi + 1) err('SB_PANEL_NUMBER', `sheet ${si + 1} panel ${pi + 1} is numbered ${p.panelNumber}; number panels 1..n in order`, `${pp}.panelNumber`);
      const shot = byId.get(p.shotId);
      if (!shot) { err('SB_UNKNOWN_SHOT', `panel ${p.shotId} is not a shot in the script`, `${pp}.shotId`); return; }
      drawn.push(p.shotId);
      if (shot.segmentId !== sh.segmentId) err('SB_WRONG_PART', `shot ${p.shotId} is drawn on the sheet for part ${sh.segmentId}; one part per sheet`, `${pp}.shotId`);
      if (shot.locationTag && p.locationTag !== shot.locationTag) err('SB_LOCATION_MISMATCH', `shot ${p.shotId} is set in ${shot.locationTag} (${shot.location}), not ${p.locationTag}`, `${pp}.locationTag`);
      const tags = p.characters.map((c) => c.tag);
      for (const t of tags) if (!chars.has(t)) err('SB_UNKNOWN_CHARACTER', `shot ${p.shotId}: ${t} is not an approved character`, `${pp}.characters`);
      if (new Set(tags).size !== tags.length) err('SB_DUPLICATE_CHARACTER', `shot ${p.shotId}: a character appears twice in one panel`, `${pp}.characters`);
      const want = new Set(shot.onScreen ?? []);
      if (want.size) {
        const miss = [...want].filter((t) => !tags.includes(t)), extra = tags.filter((t) => !want.has(t));
        if (miss.length || extra.length) err('SB_CAST_MISMATCH', `shot ${p.shotId}: on screen must be exactly ${[...want].join(', ')}${miss.length ? `; missing ${miss.join(', ')}` : ''}${extra.length ? `; not in this shot: ${extra.join(', ')}` : ''}`, `${pp}.characters`);
      }
      // WARDROBE + TWINS
      const seen = new Map();
      p.characters.forEach((pc, ci) => {
        const c = chars.get(pc.tag); if (!c) return;
        const ca = outfitFor(c, shot.segmentId);
        if (ca && norm(pc.wardrobe) !== norm(ca)) err('SB_WARDROBE_MISMATCH', `shot ${p.shotId}: ${c.name} must wear their own approved outfit word for word: "${ca}"`, `${pp}.characters.${ci}.wardrobe`);
        const k = norm(pc.wardrobe);
        if (seen.has(k)) err('SB_TWIN_OUTFITS', `shot ${p.shotId}: ${c.name} and ${seen.get(k)} wear the same outfit; every character keeps a distinct outfit so no two read as twins`, `${pp}.characters.${ci}.wardrobe`);
        seen.set(k, c.name);
      });
      // ACCESSORY continuity: every accessory a character owns is named in every panel they appear in.
      p.characters.forEach((pc, ci) => {
        const c = chars.get(pc.tag); if (!c) return;
        const have = accessoriesIn([pc.wardrobe, ...pc.props, pc.pose, pc.expression].join(' '));
        for (const a of ownedAccessories(c, shot.segmentId)) if (!have.has(a))
          err('SB_ACCESSORY_MISSING', `shot ${p.shotId}: ${c.name}'s signature "${a}" must be named in every panel ${c.name} appears in`, `${pp}.characters.${ci}`);
      });
      // PROP_LEAK: an accessory owned by another cast member (and not by this character) must not appear on this character.
      p.characters.forEach((pc, ci) => {
        const c = chars.get(pc.tag); if (!c) return;
        const mine = ownedAccessories(c, shot.segmentId);
        const text = [pc.wardrobe, ...pc.props, pc.pose, pc.expression].join(' ');
        for (const a of accessoriesIn(text)) {
          if (mine.has(a)) continue;
          const owners = [...chars.values()].filter((o) => o.tag !== c.tag && ownedAccessories(o, shot.segmentId).has(a)).map((o) => o.name);
          if (owners.length) err('SB_PROP_LEAK', `shot ${p.shotId}: ${c.name} has "${a}", which belongs to ${owners.join(', ')}; a character's signature accessory appears only on that character`, `${pp}.characters.${ci}`);
          else warn('SB_UNOWNED_ACCESSORY', `shot ${p.shotId}: ${c.name} has "${a}", which is not in their approved design`, `${pp}.characters.${ci}`);
        }
        if (c.visualTell) {
          for (const o of chars.values()) {
            if (o.tag === c.tag || !o.visualTell) continue;
            const tell = norm(o.visualTell);
            if (tell.length > 8 && norm(text).includes(tell) && !norm(`${outfitFor(c, shot.segmentId)} ${c.visualTell}`).includes(tell))
              err('SB_PROP_LEAK', `shot ${p.shotId}: ${c.name} copies ${o.name}'s signature "${o.visualTell}"`, `${pp}.characters.${ci}`);
          }
        }
      });
    });
  });
  // coverage + order
  const dup = drawn.filter((x, i) => drawn.indexOf(x) !== i);
  for (const d of new Set(dup)) err('SB_SHOT_DUPLICATE', `shot ${d} is drawn more than once`);
  for (const id of order) if (!drawn.includes(id)) err('SB_SHOT_MISSING', `shot ${id} has no panel; every shot is drawn exactly once`);
  const inOrder = order.filter((id) => drawn.includes(id));
  const firstDrawn = drawn.filter((x, i) => drawn.indexOf(x) === i && byId.has(x));
  if (!dup.length && firstDrawn.join() !== inOrder.join()) err('SB_SHOT_ORDER', 'panels must follow story order across sheets');
  // HOUSE STYLE: shot-size mix per part (style.md); characters large, one wide per three, a close-up per part
  const byPart = new Map();
  for (const sh of out?.sheets ?? []) for (const p of sh.panels) byPart.set(sh.segmentId, [...(byPart.get(sh.segmentId) ?? []), p]);
  for (const [seg, ps] of byPart) issues.push(...checkShotMix(ps, { path: `part.${seg}` }));
  const errors = issues.filter((i) => i.severity === 'error').map((i) => i.message);
  return { isValid: errors.length === 0, errors, warnings: issues.filter((i) => i.severity !== 'error').map((i) => i.message), issues };
}
