// One speech-rate budget shared by the Story Director and Seedance Compiler gates (and both role.md files).
export const WORDS_PER_SECOND = 3;
export const MAX_LINE_WORDS = 18;
export const countWords = (line) => (String(line ?? '').replace(/[{}]/g, '').match(/\S+/g) ?? []).length;
/** Whole seconds a line needs at WORDS_PER_SECOND (minimum 1s). */
export const secondsNeeded = (words) => Math.max(1, Math.ceil(words / WORDS_PER_SECOND));
export const maxWordsFor = (secs) => WORDS_PER_SECOND * secs;
/** Exact, actionable feedback for an over-budget line. */
export function budgetMessage(label, words, secs) {
  const need = secondsNeeded(words);
  return `${label}: ${words}-word line needs ${need}s at ${WORDS_PER_SECOND} words/sec but the shot is ${secs}s. Fix: lengthen this shot to ${need}s (shift the following timecodes; keep the segment <= 30s, moving a shot to the next part if needed) or split the line across two shots at a natural pause. Never shorten or paraphrase the line to fit.`;
}
