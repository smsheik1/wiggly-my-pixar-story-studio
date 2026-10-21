// Test helper: a valid Storyboard Artist output built from its input slice (every shot, own outfit, no props).
import { outfitFor } from '../../crew/storyboard-artist/input.mjs';
// House shot-size ladder (style.md): one wide opener, then medium / close-up alternating, never three alike in a row.
export const LADDER = ['Wide shot', 'Medium shot', 'Close-up', 'Medium two-shot', 'Medium close-up', 'Full shot', 'Close-up', 'Medium shot'];
export function draftStoryboard(input) {
  const sheets = []; const nth = new Map();
  for (const sh of input.shots) {
    let s = sheets.findLast((x) => x.segmentId === sh.segmentId);
    if (!s || s.panels.length === 8) sheets.push(s = { segmentId: sh.segmentId, sheetIndex: (s?.segmentId === sh.segmentId ? s.sheetIndex + 1 : 1), panels: [] });
    const cast = sh.onScreen.length ? sh.onScreen : [];
    s.panels.push({ panelNumber: s.panels.length + 1, shotId: sh.shotId, locationTag: sh.locationTag ?? '@Loc 1', shotSizeAndAngle: `${LADDER[(nth.set(sh.segmentId, (nth.get(sh.segmentId) ?? -1) + 1).get(sh.segmentId)) % LADDER.length]}, eye level`,
      characters: cast.map((t) => { const c = input.characters.find((x) => x.tag === t); return { tag: t, wardrobe: c ? outfitFor(c, sh.segmentId) || 'plain everyday clothes' : 'plain', props: [], pose: 'stands relaxed facing camera', expression: 'soft smile' }; }),
      staging: 'centre frame, facing camera, mid ground', lightAndPalette: 'warm key light, soft shadows' });
  }
  return { sheets, assumptions: [] };
}
