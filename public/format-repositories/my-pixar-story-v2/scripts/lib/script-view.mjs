// Readable "Script view" of a Story Director output: screenplay-style HTML, no JSON, no field names. Renderer only.
import { upsertSection } from './audit.mjs';

export const SCRIPT_START = '<!-- v2-script:start -->', SCRIPT_END = '<!-- v2-script:end -->';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const FRAMING = { 'extreme close-up': 'very close on', ecu: 'very close on', 'close-up': 'close on', cu: 'close on', 'medium close-up': 'chest-up on', mcu: 'chest-up on',
  medium: 'waist-up on', ms: 'waist-up on', 'medium wide': 'knees-up on', 'wide': 'wide view of', ws: 'wide view of', 'extreme wide': 'far wide view of', 'over-the-shoulder': 'over the shoulder of', ots: 'over the shoulder of', 'two-shot': 'two people together:' };
const plainCam = (sh) => {
  const f = String(sh.framing ?? '').toLowerCase().trim(), a = String(sh.cameraAngle ?? '').toLowerCase().trim(), m = String(sh.cameraMove ?? '').toLowerCase().trim();
  const parts = [];
  parts.push(f ? (FRAMING[f] ? `${FRAMING[f].replace(/ (on|of|:)$/, '')} shot` : `${f} shot`) : null);
  if (a && a !== 'eye level' && a !== 'eye-level') parts.push(a.includes('low') ? 'looking up' : a.includes('high') ? 'looking down' : a);
  else if (a) parts.push('at eye level');
  parts.push(!m || m === 'static' || m === 'locked' ? 'camera holds still' : `camera ${m.replace(/^slow /, 'slowly ')}`);
  return parts.filter(Boolean).join(', ');
};
const pretty = (t) => String(t ?? '').replace(/^\{|\}$/g, '').trim();
const runtime = (s) => (s.shots ?? []).reduce((n, h) => n + ((h.endSec ?? 0) - (h.startSec ?? 0)), 0) || s.targetDurationSec || 0;
const clock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

/** names: '@DadShaz' -> 'Shaz (adult)' style display names from the cast. */
function namer(cast) {
  const count = {}; for (const c of cast) count[c.name] = (count[c.name] ?? 0) + 1;
  const map = Object.fromEntries(cast.map((c) => [c.elementTag, count[c.name] > 1 ? `${c.name} (${c.age})` : c.name]));
  return { name: (tag) => map[tag] ?? String(tag ?? '').replace(/^@/, ''), text: (t) => String(t ?? '').replace(/@[\w_]+/g, (tag) => map[tag] ?? tag.slice(1)) };
}
const oneLine = (c) => { const d = String(c.physicalDescription ?? '').split(/(?<=\.)\s/)[0]; return `${c.oneWordRole ? `${c.oneWordRole}, ` : ''}age ${c.age}${c.ageNote ? ` (${c.ageNote})` : ''}. ${d}`; };

export function scriptViewHtml(sd) {
  if (!sd || !Array.isArray(sd.segments)) return `${SCRIPT_START}<section id='v2-script'><h2>Script view</h2><p class='muted'>No Story Director output for this run.</p></section>${SCRIPT_END}`;
  const cast = sd.cast ?? []; const N = namer(cast);
  const title = sd.masthead?.title ?? sd.title ?? 'Untitled';
  const total = sd.segments.reduce((n, s) => n + runtime(s), 0);
  const castHtml = cast.map((c) => `<li><b>${esc(N.name(c.elementTag))}</b>: ${esc(oneLine(c))}</li>`).join('');
  let t0 = 0;
  const parts = sd.segments.map((s, i) => {
    const shots = (s.shots ?? []).map((h) => {
      const who = [...new Set((String(h.whatWeSee ?? '').match(/@[\w_]+/g) ?? []))].map(N.name);
      const lines = [h.dialogue && ['says', h.dialogue], h.narration && ['narrates', h.narration]].filter(Boolean).map(([verb, d]) =>
        `<blockquote style='font-size:20px;margin:8px 0 4px;padding-left:12px;border-left:3px solid #9cc4ff'>“${esc(pretty(d.line))}”<div style='font-size:13px;color:#aaa'>${esc(N.name(d.speaker))} ${d.isVoiceover || verb === 'narrates' ? 'narrates (voiceover)' : d.isOffCamera ? 'says (off camera)' : verb}</div></blockquote>`).join('');
      const at = t0 + (h.startSec ?? 0);
      return `<div style='background:#0b0f16;border-radius:8px;padding:10px 12px;margin:8px 0'>
<div style='color:#9cc4ff;font-size:13px'>Shot ${esc(h.shotNumber)} · ${clock(at)}–${clock(t0 + (h.endSec ?? 0))} · ${esc(h.location ?? '')}</div>
<div style='color:#aaa;font-size:13px'>${esc(plainCam(h))}${who.length ? ` · On screen: ${esc(who.join(', '))}` : ''}</div>
<div style='margin-top:4px'>${esc(N.text(h.whatWeSee))}</div>${h.whatWeHear ? `<div style='color:#aaa;font-size:13px'>We hear: ${esc(N.text(h.whatWeHear))}</div>` : ''}${lines}</div>`;
    }).join('');
    const html = `<h3 style='color:#fff;margin-top:18px'>Part ${i + 1}: ${esc(s.title ?? '')} <span style='color:#888;font-weight:normal'>(${runtime(s)}s)</span></h3>${s.goalSummary ? `<p class='muted'>${esc(N.text(s.goalSummary))}</p>` : ''}${shots}`;
    t0 += runtime(s); return html;
  }).join('');
  return `${SCRIPT_START}<section id='v2-script' style='background:#161b22;border-radius:10px;padding:14px;margin:12px 0'><h2 style='color:#fff'>Script view: ${esc(title)} <span style='color:#888;font-weight:normal'>(${total}s)</span></h2>
${sd.masthead?.oneLinePremise ? `<p><i>${esc(N.text(sd.masthead.oneLinePremise))}</i></p>` : ''}<h3 style='color:#fff'>Cast</h3><ul style='list-style:disc;padding-left:20px'>${castHtml}</ul>${parts}</section>${SCRIPT_END}`;
}

/** Put the script view at the top of report.html (right after its <h1>), or before the dry-run section in the tracker. */
export function upsertScriptView(html, section, { report = true } = {}) {
  if (html.includes(SCRIPT_START)) return upsertSection(html, section, { start: SCRIPT_START, end: SCRIPT_END });
  if (report && /<h1>[^<]*<\/h1>/.test(html)) return html.replace(/(<h1>[^<]*<\/h1>)/, `$1${section}`);
  if (html.includes('<!-- v2-dry-run:start -->')) return html.replace('<!-- v2-dry-run:start -->', `${section}\n<!-- v2-dry-run:start -->`);
  return upsertSection(html, section, { start: SCRIPT_START, end: SCRIPT_END, after: null });
}
