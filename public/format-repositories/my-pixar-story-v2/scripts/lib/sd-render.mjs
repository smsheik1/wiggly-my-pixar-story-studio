// Deterministic Story Director artifacts: the HTML script card deck and the storyboard sheet prompts are built in
// code from the SD's JSON (they used to be written by the model on every draft, which drifted and cost tokens).
// Storyboard rules (3-script-writer.md §5, now enforced here): one sheet per part (extra sheets when a part has more than 8
// shots), always eight panels in two even rows of four, every shot exactly once in story order, real panels labelled
// "P.S", unused slots written as empty panels, skin tone and worn accessories named for every person in frame,
// single-line prompt for Nano Banana 2.1 in Google Flow.
export const IMAGE_ENGINE = 'nano-banana-2.1';
export const PANELS_PER_SHEET = 8;
export const SHEET_OPENING = 'An eight-panel colour storyboard sheet';
export const SHEET_LAYOUT = 'two even rows of four panels';
export const panelLabel = (k, seg, shot) => `Panel ${k}, labelled "${seg}.${shot}":`;
export const emptyPanelLine = (k) => `Panel ${k} [empty]: a plain blank off-white frame with a thin dark border, clearly empty, no characters, no drawing, no text.`;
export const SHEET_HEAD = `${SHEET_OPENING} from a feature animation studio's pre-production, arranged in ${SHEET_LAYOUT} on a warm off-white page. Each panel is a 16:9 landscape rectangle with a thin dark border, evenly spaced. Each panel has its exact label (part.shot, like 1.4) hand-written small in the corner, with no other codes; empty panels have no label. Each panel is a polished 3D Pixar-style animated film render with appealing stylized characters, soft global illumination, strong atmospheric lighting and clear colour design in every panel. Rich saturated colour, warm and cinematic, in the style of a feature animation colour script. Not photorealistic, not flat vector, not line art.`;
export const SHEET_TAIL = 'Cohesive colour design across the whole sheet. No text or writing in the panels other than the panel labels. No watermark, no logos, no border around the page.';

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const noDot = (s) => oneLine(s).replace(/[.\s]+$/, '');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const accentText = (v) => { const t = oneLine(v); return !t || /^(?:none|n\/?a|nil|null|-+)\.?$/i.test(t) ? '' : t; };
const noun = (c) => (c.age < 13 ? (c.gender === 'female' ? 'girl' : 'boy') : c.age < 25 ? (c.gender === 'female' ? 'young woman' : 'young man') : (c.gender === 'female' ? 'woman' : 'man'));

/** How a person is drawn in a panel: name, age, skin tone, the cast card's look, and every always-worn item. */
export function personInPanel(c) {
  const desc = noDot(c.physicalDescription);
  const key = (t) => ` ${t} `.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/ the /g, ' ');
  const worn = [accentText(c.signatureAccent), ...(c.signatureAccessories ?? []).map(oneLine)].filter(Boolean)
    .filter((w, i, a) => a.indexOf(w) === i && !key(desc).includes(key(w)));
  return [`${c.name}, ${/^(8|11|18|80|8\d)$/.test(String(c.age)) ? 'an' : 'a'} ${c.age}-year-old ${noun(c)} with ${oneLine(c.skinTone)} skin`, desc, ...worn.map((w) => `wearing ${w}`)].filter(Boolean).join(', ');
}

/** One panel for one shot (the four storyboard fields the gate checks). */
export function panelFor(shot, k, sd) {
  const cast = new Map((sd.cast ?? []).map((c) => [c.elementTag, c]));
  const loc = (sd.locations ?? []).find((l) => l.name === shot.location);
  const name = (tag) => cast.get(tag)?.name ?? tag.replace(/^@/, '');
  const onScreen = (shot.onScreen ?? []).filter((t) => cast.has(t));
  const who = onScreen.length ? `In frame: ${onScreen.map((t) => personInPanel(cast.get(t))).join('; ')}.` : 'No people in frame.';
  const action = noDot(String(shot.whatWeSee ?? '').replace(/@[\w_]+/g, name));
  return {
    panelNumber: k,
    shotNumberRef: shot.shotNumber,
    shotSizeAndAngle: cap(`${noDot(shot.framing)} shot, ${noDot(shot.cameraAngle)}`),
    whatIsInFrame: `${who} ${cap(action)}`.trim(),
    lightAndPalette: `${loc ? `${noDot(loc.name)}: ${noDot(loc.description)}. ` : ''}Warm cinematic key light, soft shadows, rich colour consistent with the part`,
  };
}

/** The single-line Nano Banana prompt for one sheet. */
export function sheetPrompt(segmentId, panels) {
  const lines = panels.map((p) => `${panelLabel(p.panelNumber, segmentId, p.shotNumberRef)} ${noDot(p.shotSizeAndAngle)}. ${noDot(p.whatIsInFrame)}. ${noDot(p.lightAndPalette)}.`);
  for (let k = panels.length + 1; k <= PANELS_PER_SHEET; k++) lines.push(emptyPanelLine(k));
  return oneLine([SHEET_HEAD, ...lines, SHEET_TAIL].join(' '));
}

/** Every storyboard sheet for an SD output: one per part, extra sheets past 8 shots, every shot once in order. */
export function buildStoryboardSheets(sd) {
  const sheets = [];
  for (const seg of sd?.segments ?? []) {
    const shots = seg.shots ?? [];
    for (let i = 0; i < shots.length; i += PANELS_PER_SHEET) {
      const panels = shots.slice(i, i + PANELS_PER_SHEET).map((h, j) => panelFor(h, j + 1, sd));
      sheets.push({ segmentId: seg.segmentId, targetEngine: IMAGE_ENGINE, fullPrompt: sheetPrompt(seg.segmentId, panels), panels });
    }
  }
  return sheets;
}

// ---- HTML script card deck (3-script-writer.md §4 typography, palette and structure) ----
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dur = (seg) => (seg.shots ?? []).reduce((n, h) => n + (h.endSec - h.startSec), 0);
const CSS = `body{margin:0;background:#E4E6D9;color:#22272A;font-family:Karla,sans-serif;line-height:1.5}main{max-width:860px;margin:0 auto;padding:32px 20px}
h1,h2,h3{font-family:Fraunces,serif;margin:.2em 0}.mono,.eyebrow,.tc{font-family:'Space Mono',monospace}.eyebrow,.muted{color:#6B7280;font-size:13px}
.card{background:#F2F3EA;border-radius:10px;padding:14px 16px;margin:10px 0}.bar{display:flex;height:28px;border-radius:6px;overflow:hidden;margin-top:12px}
.bar div{background:#F2F3EA;border-right:2px solid #E4E6D9;font-family:'Space Mono',monospace;font-size:11px;padding:6px;overflow:hidden;white-space:nowrap}
.part{border-top:3px solid #C33A2C;margin-top:28px;padding-top:8px}.spk{color:#C33A2C;font-weight:bold}.row b{font-family:'Space Mono',monospace;font-size:12px;color:#6B7280;margin-right:6px}`;

/** The full HTML card deck: masthead, shape bar, how to read, cast cards, shots by part, footer. Says exactly what the JSON says. */
export function buildScriptDeckHtml(sd) {
  const cast = sd.cast ?? [], segs = sd.segments ?? [];
  const nameOf = new Map(cast.map((c) => [c.elementTag, c.name]));
  const txt = (t) => esc(String(t ?? '').replace(/@[\w_]+/g, (tag) => nameOf.get(tag) ?? tag.slice(1)));
  const total = segs.reduce((n, s) => n + dur(s), 0), shotCount = segs.reduce((n, s) => n + (s.shots ?? []).length, 0);
  const draft = sd.masthead?.draftNumber ?? 1;
  const bar = segs.map((s) => `<div style="flex:${dur(s) || 1}">${esc(s.title)} · ${dur(s)}s</div>`).join('');
  const castCards = cast.map((c) => `<div class="card"><h3>${esc(c.name)} <span class="mono muted">${esc(c.elementTag)}</span></h3><div class="muted">Age ${esc(c.age)}${c.ageNote ? ` (${esc(c.ageNote)})` : ''} · ${esc(c.oneWordRole)}</div><p>${esc(c.physicalDescription)} Skin tone: ${esc(c.skinTone)}.${accentText(c.signatureAccent) ? ` Always wears: ${esc(accentText(c.signatureAccent))}.` : ''}</p></div>`).join('');
  const line = (k, l) => `<div class="row"><b>${k}</b><span class="spk">${esc(nameOf.get(l.speaker) ?? l.speaker)}:</span> ${esc(l.line)}${l.isVoiceover ? ' <span class="muted">(voiceover)</span>' : l.isOffCamera ? ' <span class="muted">(off camera)</span>' : ''}</div>`;
  const parts = segs.map((s) => `<section class="part"><h2>${esc(s.title)}</h2><div class="mono muted">${dur(s)}s · ${(s.shots ?? []).length} shots</div><p>${txt(s.goalSummary)}</p>${(s.shots ?? []).map((h) => `<div class="card">
<div class="tc">SHOT ${esc(h.shotNumber)} | ${esc(h.startSec)}–${esc(h.endSec)}s${h.tag ? ` · <i>${esc(h.tag)}</i>` : ''}</div>
<div class="row"><b>WHERE</b>${esc(h.location)}</div><div class="row"><b>CAMERA</b>${esc(h.framing)}, ${esc(h.cameraAngle)}, ${esc(h.cameraMove)}</div>
<div class="row"><b>WE SEE</b>${txt(h.whatWeSee)}</div>${h.whatWeHear ? `<div class="row"><b>WE HEAR</b>${txt(h.whatWeHear)}</div>` : ''}${h.dialogue ? line('DIALOGUE', h.dialogue) : ''}${h.narration ? line('NARRATION', h.narration) : ''}${h.directorsNote ? `<div class="row"><b>DIRECTOR'S NOTE</b><i>${txt(h.directorsNote)}</i></div>` : ''}</div>`).join('')}</section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(sd.masthead?.title)} - Draft ${esc(draft)}</title><link href="https://fonts.googleapis.com/css2?family=Fraunces&family=Karla&family=Space+Mono" rel="stylesheet"><style>${CSS}</style></head><body><main>
<header><div class="eyebrow">3D animated short · Draft ${esc(draft)}</div><h1>${esc(sd.masthead?.title)}</h1><p>${txt(sd.masthead?.oneLinePremise)}</p><div class="bar">${bar}</div></header>
<section class="card"><h3>How to read this</h3><p class="muted">Each card is one shot: its number and time, where we are, the camera in plain words, what we see, what we hear, and any spoken line. Speaker names are in red.</p></section>
<section><h2>Cast</h2>${castCards}</section>${parts}
<footer class="mono muted" style="margin-top:28px">Draft ${esc(draft)} · ${shotCount} shots · ${total}s</footer></main></body></html>`;
}

/** SD output with code-built storyboardSheets and htmlScriptDocument (any model-written versions are replaced). */
export function withRenderedArtifacts(sd) {
  if (!sd || !Array.isArray(sd.segments)) return sd;
  return { ...sd, storyboardSheets: buildStoryboardSheets(sd), htmlScriptDocument: buildScriptDeckHtml(sd) };
}
