// One speech-rate budget shared by the Story Director and Seedance Compiler gates (and both skill files: story-director 3-script-writer.md, seedance-compiler role.md).
export const WORDS_PER_SECOND = 3;
export const MAX_LINE_WORDS = 18;
/** Lead-in + tail-out around the spoken words in a shot (0.5s each), so a line never starts on the cut or gets clipped. */
export const SPEECH_PAD_SEC = 1;
export const countWords = (line) => (String(line ?? '').replace(/[{}]/g, '').match(/\S+/g) ?? []).length;
/** Whole seconds a shot needs for `words` spoken words: words / WORDS_PER_SECOND + SPEECH_PAD_SEC, rounded up. */
export const secondsNeeded = (words) => Math.ceil(words / WORDS_PER_SECOND + SPEECH_PAD_SEC);
/** Most words that fit a shot of `secs` seconds (pad included). */
export const maxWordsFor = (secs) => Math.max(0, Math.floor(WORDS_PER_SECOND * (secs - SPEECH_PAD_SEC)));
/** Spoken words in one shot: its dialogue line plus its narration line (they play one after the other). */
export const shotWords = (shot) => countWords(shot?.dialogue?.line) + countWords(shot?.narration?.line);
/** Exact, actionable feedback for an over-budget shot. */
export function budgetMessage(label, words, secs) {
  const need = secondsNeeded(words);
  return `${label}: ${words} spoken words need ${need}s (${words} words at ${WORDS_PER_SECOND} words/sec plus ${SPEECH_PAD_SEC}s lead-in and tail) but the shot is ${secs}s. Fix: lengthen this shot to ${need}s (shift the following timecodes; keep the segment <= 30s, moving a shot to the next part if needed) or split the line across two shots at a natural pause.`;
}
