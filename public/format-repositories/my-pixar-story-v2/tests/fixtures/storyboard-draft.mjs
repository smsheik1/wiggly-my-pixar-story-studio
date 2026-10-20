// Test helper: a valid Storyboard Artist output built from its input slice (every shot, own outfit, no props).
import { outfitFor } from '../../crew/storyboard-artist/input.mjs';
export function draftStoryboard(input) {
  const sheets = [];
  for (const sh of input.shots) {
    let s = sheets.findLast((x) => x.segmentId === sh.segmentId);
    if (!s || s.panels.length === 8) sheets.push(s = { segmentId: sh.segmentId, sheetIndex: (s?.segmentId === sh.segmentId ? s.sheetIndex + 1 : 1), panels: [] });
    const cast = sh.onScreen.length ? sh.onScreen : [];
    s.panels.push({ panelNumber: s.panels.length + 1, shotId: sh.shotId, locationTag: sh.locationTag ?? '@Loc 1', shotSizeAndAngle: 'Medium shot, eye level',
      characters: cast.map((t) => { const c = input.characters.find((x) => x.tag === t); return { tag: t, wardrobe: c ? outfitFor(c, sh.segmentId) || 'plain everyday clothes' : 'plain', props: [], pose: 'stands relaxed facing camera', expression: 'soft smile' }; }),
      staging: 'centre frame, facing camera, mid ground', lightAndPalette: 'warm key light, soft shadows' });
  }
  return { sheets, assumptions: [] };
}
