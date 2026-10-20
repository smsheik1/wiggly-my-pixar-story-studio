// Deterministic sheet assembly: fullPrompt text (single line for Nano Banana 2.1 in Google Flow) and the per-sheet
// reference list (approved character images + location plates, in attach order). Layout matches the slicer's grid.
import { PANELS_PER_SHEET, sheetIdOf } from './schema.mjs';

export const GRID = Object.freeze({ rows: 2, cols: 4, panelAspect: 16 / 9 });
export const SB_SHEET_OPENING = 'An eight-panel colour storyboard sheet';
export const SB_SHEET_LAYOUT = 'two even rows of four panels';
export const SB_HEAD = `${SB_SHEET_OPENING} from a feature animation studio's pre-production, arranged in ${SB_SHEET_LAYOUT} filling a 16:9 page edge to edge with thin even gutters on a warm off-white background. Every panel is the same size, a 16:9 landscape rectangle with a thin dark border. Each panel has its exact shot label (part.shot, like 1.4) hand-written small in its top-left corner; empty panels have no label. Each panel is a polished 3D Pixar-style animated film render with appealing stylized characters, soft global illumination and clear colour design. The attached reference images are the approved character designs and background plates: every character must match their reference exactly (face, hair, skin, outfit) and every background must match its plate.`;
export const SB_TAIL = 'Each character keeps their own outfit and accessories only; no two characters share an outfit. Cohesive colour design across the sheet. No text in the panels other than the shot labels. No watermark, no logos, no border around the page.';
export const sbEmptyPanel = (k) => `Panel ${k} [empty]: a plain blank off-white frame with a thin dark border, no characters, no drawing, no text.`;
export const sbPanelLabel = (k, shotId) => `Panel ${k}, labelled "${shotId}":`;

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
    return `${id}, wearing ${nd(pc.wardrobe)}${pc.props.length ? `, with ${pc.props.map(nd).join(' and ')}` : ''}, ${nd(pc.pose)}, ${nd(pc.expression)}`;
  });
  return [sbPanelLabel(p.panelNumber, p.shotId), `${nd(p.shotSizeAndAngle)}.`, `Background: ${loc ? nd(loc.settingName) : p.locationTag} (reference image ${pos(p.locationTag)}).`,
    who.length ? `${who.join('. ')}.` : 'No characters in frame.', `Staging: ${nd(p.staging)}.`, `Light: ${nd(p.lightAndPalette)}.`].join(' ');
}

/** Full single-line sheet prompt. */
export function sheetPrompt(sheet, input, refs = sheetReferences(sheet, input)) {
  const lines = sheet.panels.map((p) => panelLine(p, input, refs));
  for (let k = sheet.panels.length + 1; k <= PANELS_PER_SHEET; k++) lines.push(sbEmptyPanel(k));
  return one([SB_HEAD, ...lines, SB_TAIL].join(' '));
}

/** Compiled sheets: { sheetId, segmentId, references, panels: [{panelNumber, shotId, row, col}], fullPrompt }. */
export function compileSheets(out, input) {
  return out.sheets.map((s) => {
    const references = sheetReferences(s, input);
    return { sheetId: sheetIdOf(s), segmentId: s.segmentId, references, grid: GRID,
      panels: s.panels.map((p) => ({ panelNumber: p.panelNumber, shotId: p.shotId, row: Math.floor((p.panelNumber - 1) / GRID.cols), col: (p.panelNumber - 1) % GRID.cols })),
      fullPrompt: sheetPrompt(s, input, references) };
  });
}
