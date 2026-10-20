// Deterministic sheet assembly: fullPrompt text (single line for Nano Banana 2.1 in Google Flow) and the per-sheet
// reference list (approved character images + location plates, in attach order). Layout matches the slicer's grid.
import { sheetIdOf } from './schema.mjs';
import { signatureAccessories } from '../linter/check-storyboard.mjs';

export const GRID = Object.freeze({ panelAspect: 16 / 9 }); // layout follows the panel count (sheetLayout)
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
/** Rows for n panels, no empty slots: 1-3 one row; 4 = 2x2; 5 = 3 over 2; 6 = 2x3; 7 = 4 over 3; 8 = 2x4. */
export function sheetLayout(n) {
  const rows = n <= 3 ? [n] : n === 4 ? [2, 2] : n === 5 ? [3, 2] : n === 6 ? [3, 3] : n === 7 ? [4, 3] : [4, 4];
  return { rows, cols: Math.max(...rows), n };
}
const rowsText = (L) => (L.rows.length === 1 ? `a single row of ${WORDS[L.n]} panels` : L.rows[0] === L.rows[1] ? `${WORDS[L.rows.length]} even rows of ${WORDS[L.rows[0]]} panels`
  : `a top row of ${WORDS[L.rows[0]]} panels and a bottom row of ${WORDS[L.rows[1]]} panels centred under it`);
export const SB_SHEET_OPENING = 'A colour storyboard sheet';
export const sbHead = (n) => { const L = sheetLayout(n); return `${SB_SHEET_OPENING} with exactly ${WORDS[n]} (${n}) panels from a feature animation studio's pre-production, arranged in ${rowsText(L)} on a plain warm off-white page, with no empty boxes, no extra panels and no repeated panels. Every panel is the same size and is a WIDE 16:9 landscape cinema frame (much wider than tall, never square), surrounded by a thick solid dark border, with clear off-white space between panels. Above each panel, outside its border, its shot label is hand-written small and dark. Each panel is a polished 3D Pixar-style animated film render with appealing stylized characters, soft global illumination and clear colour design. The attached reference images are the approved character designs and background plates: every character must match their reference exactly (face, hair, skin, outfit, accessories) and every background must match its plate. The ${WORDS[n]} panels, in reading order (left to right, top row first), are: ${'${LIST}'}.`; };
export const SB_TAIL = 'Each character keeps their own outfit and accessories in every panel they appear in; no two characters share an outfit. Draw each panel exactly once. Cohesive colour design across the sheet. No text other than the shot labels above the panels. No watermark, no logos, no border around the page.';
export const sbPanelLabel = (k, shotId) => `Panel ${k} of the sheet, labelled "${shotId}":`;

const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const nd = (s) => one(s).replace(/[.\s]+$/, '');
const article = (n) => (/^(8|11|18|8\d)$/.test(String(n)) ? 'an' : 'a');
const noun = (c) => (c.age == null ? 'person' : c.age < 13 ? (c.gender === 'female' ? 'girl' : 'boy') : c.age < 25 ? (c.gender === 'female' ? 'young woman' : 'young man') : (c.gender === 'female' ? 'woman' : 'man'));

/** References for one sheet: characters first (cast order), then locations; each gets its 1-based attach position. */
export function sheetReferences(sheet, input) {
  const tags = new Set(sheet.panels.flatMap((p) => p.characters.map((c) => c.tag)));
  const locTags = new Set(sheet.panels.map((p) => p.locationTag));
  const refs = [];
  for (const c of input.characters) if (tags.has(c.tag)) refs.push({ kind: 'character', tag: c.tag, imageTag: c.imageTag, name: c.name });
  for (const l of input.locations) if (locTags.has(l.tag)) refs.push({ kind: 'location', tag: l.tag, settingName: l.settingName });
  return refs.map((r, i) => ({ ...r, position: i + 1 }));
}

export function panelLine(p, input, refs) {
  const pos = (t) => refs.find((r) => r.tag === t)?.position;
  const loc = input.locations.find((l) => l.tag === p.locationTag);
  const who = p.characters.map((pc) => {
    const c = input.characters.find((x) => x.tag === pc.tag) ?? { name: pc.tag };
    const id = [`${c.name} (reference image ${pos(pc.tag)})`, c.age != null ? `${article(c.age)} ${c.age}-year-old ${noun(c)}` : '', c.skinTone ? `with ${nd(c.skinTone)} skin` : ''].filter(Boolean).join(', ');
    const sig = c.tag ? signatureAccessories(c, p.segmentId ?? 0) : [];
    return `${id}, wearing ${nd(pc.wardrobe)}${sig.length ? ` (always visible on ${c.name}: ${sig.join('; ')})` : ''}${pc.props.length ? `, with ${pc.props.map(nd).join(' and ')}` : ''}, ${nd(pc.pose)}, ${nd(pc.expression)}`;
  });
  return [sbPanelLabel(p.panelNumber, p.shotId), `${nd(p.shotSizeAndAngle)}.`, `Background: ${loc ? nd(loc.settingName) : p.locationTag} (reference image ${pos(p.locationTag)}).`,
    who.length ? `${who.join('. ')}.` : 'No characters in frame.', `Staging: ${nd(p.staging)}.`, `Light: ${nd(p.lightAndPalette)}.`].join(' ');
}

/** Full single-line sheet prompt. */
export function sheetPrompt(sheet, input, refs = sheetReferences(sheet, input)) {
  const n = sheet.panels.length;
  const list = sheet.panels.map((p, i) => `${i + 1}) "${p.shotId}"`).join(', ');
  const panels = sheet.panels.map((p) => ({ ...p, segmentId: sheet.segmentId }));
  const lines = panels.map((p) => panelLine(p, input, refs));
  return one([sbHead(n).replace('${LIST}', list), ...lines, `That is all ${n} panels: ${list}. Nothing else on the page.`, SB_TAIL].join(' '));
}

/** Compiled sheets: { sheetId, segmentId, references, panels: [{panelNumber, shotId, row, col}], fullPrompt }. */
export function compileSheets(out, input) {
  return out.sheets.map((s) => {
    const references = sheetReferences(s, input);
    return { sheetId: sheetIdOf(s), segmentId: s.segmentId, references, layout: sheetLayout(s.panels.length),
      panels: s.panels.map((p) => ({ panelNumber: p.panelNumber, shotId: p.shotId })),
      fullPrompt: sheetPrompt(s, input, references) };
  });
}
