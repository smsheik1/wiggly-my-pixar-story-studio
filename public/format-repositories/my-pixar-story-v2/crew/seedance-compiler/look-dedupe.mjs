// WIGGLY: one entry per item on a Look line. The accessory, the visual tell and the signature garment come from different
// sources and often repeat each other ('red cap; red cap', 'teal hoodie; teal hoodie with a zip'). Code removes an item that equals or is contained in
// another item (case-insensitive), keeping the longer one, in first-seen order.
const norm = (t) => String(t ?? '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').replace(/[.;\s]+$/, '').trim();
/** Dedupe a list of phrases (strings, or objects with .text). */
export function dedupeItems(items, text = (x) => (typeof x === 'string' ? x : x?.text)) {
  const xs = items.filter((x) => norm(text(x)));
  return xs.filter((x, i) => {
    const a = norm(text(x));
    return !xs.some((y, j) => { if (j === i) return false; const b = norm(text(y)); return b === a ? j < i : b.includes(a); });
  });
}
/** Rewrite every "Look @Tag: a; b; c." line of a [SHOTS] block with its items deduped. */
export function dedupeLookLines(shotsText) {
  return String(shotsText ?? '').replace(/^(\s*Look @[\w_]+:\s*)(.*?)\.?[ \t]*$/gm, (_, head, body) => `${head}${dedupeItems(body.split(/\s*;\s*/)).join('; ')}.`);
}
