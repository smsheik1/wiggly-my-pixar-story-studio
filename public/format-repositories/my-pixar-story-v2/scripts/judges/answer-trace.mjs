// Benchmark judge (docs/specs/benchmark.md section 5): score = storyFaithfulness.
// Reads a cached runs/<id>/answer-trace.json when present and makes no model
// call. Only when the cache is missing — i.e. this judge runs via
// `benchmark.mjs --judge answer-trace` — does it trace live through the
// OpenCode CLI.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { museCall as realMuseCall } from '../lib/muse-opencode.mjs';
import { answersFromInputs, traceRun } from '../lib/answer-trace.mjs';

const toDetails = (model) => Object.fromEntries(Object.entries(model.agents ?? {}).map(([a, r]) => [a, r.counts]));

export default {
  name: 'answer-trace',
  run: async ({ outputs, inputs, runDir }, { museCall } = {}) => {
    const cached = runDir ? join(runDir, 'answer-trace.json') : null;
    if (cached && existsSync(cached)) {
      const model = JSON.parse(await readFile(cached, 'utf8'));
      return { score: model.storyFaithfulness, details: toDetails(model) };
    }
    const answers = answersFromInputs(inputs ?? {});
    const { model } = await traceRun({ answers, outputs, museCall: museCall ?? realMuseCall, log: () => {} });
    return { score: model.storyFaithfulness, details: toDetails(model) };
  },
};
