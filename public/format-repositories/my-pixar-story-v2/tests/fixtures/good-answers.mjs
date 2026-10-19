// The family answers good-stage-play.json traces to (its lines cite these answer ids). Test input data, not rules.
import { readFileSync } from 'node:fs';
export const GOOD_INPUT = JSON.parse(readFileSync(new URL('./good-answers.json', import.meta.url), 'utf8'));
export const GOOD_ANSWERS = GOOD_INPUT.answers;
