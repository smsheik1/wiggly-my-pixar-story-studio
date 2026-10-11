// Detector for slash abbreviations in prose. TTS engines narrate slashes aloud
// (e.g. "A/C" is read as "A slash C"). Narration text must spell them out.
const SLASH_RE = /(?:https?:\/\/\S+)|([\p{L}\p{N}]+(?:\/[\p{L}\p{N}]+)+|\p{L}+\/(?=\s|$|[.,;:!?])|\s+\/\s+)/giu;

export function findSlashAbbreviations(text) {
  if (typeof text !== 'string' || !text.includes('/')) return [];
  const matches = [];
  for (const match of text.matchAll(SLASH_RE)) {
    if (match[1]) {
      matches.push(match[1].trim());
    }
  }
  return matches;
}
