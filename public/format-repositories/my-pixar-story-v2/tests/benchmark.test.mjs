import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scoreRun, compareRuns, benchmarkMarkdown, loadOutputs } from '../scripts/benchmark.mjs';

test('baseline vs itself -> SAME, zero deltas', { timeout: 10000 }, async () => {
  const baselineChecks = JSON.parse(await readFile('benchmarks/r4-dry6/checks.json', 'utf8'));
  const comparison = compareRuns(baselineChecks, baselineChecks);
  assert.equal(comparison.verdict, 'SAME');

  for (const [key, m] of Object.entries(comparison.structural)) {
    if (key === 'shotFieldCompleteness') {
      assert.equal(m.delta, 0);
      assert.equal(m.mean.delta, 0);
      assert.equal(m.min.delta, 0);
      assert.equal(m.changed, false);
    } else if (key === 'shotsPerSegment') {
      assert.equal(m.delta, 0);
      assert.equal(m.changed, false);
    } else {
      assert.equal(m.delta, 0);
      assert.equal(m.changed, false);
    }
  }

  for (const [, a] of Object.entries(comparison.agents)) {
    assert.deepEqual(a.newCodes, []);
    assert.deepEqual(a.goneCodes, []);
    assert.deepEqual(a.changedCodes, []);
    assert.equal(a.statusChange, null);
  }
});

test('copy with one SD shot whatWeSee emptied -> completeness drops, shot is listed, SD gate result compared', { timeout: 10000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'benchmark-test-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const baselineChecks = JSON.parse(await readFile('benchmarks/r4-dry6/checks.json', 'utf8'));
  const outputs = await loadOutputs('benchmarks/r4-dry6/outputs');
  const inputs = JSON.parse(await readFile('benchmarks/r4-dry6/inputs.json', 'utf8'));

  outputs['story-director'].segments[0].shots[0].whatWeSee = '';

  const candScore = await scoreRun({
    outputs,
    inputs,
    approvedAssets: outputs.state?.approvedAssets,
  });

  assert(candScore.structural.shotFieldCompleteness.mean < baselineChecks.structural.shotFieldCompleteness.mean, 'mean completeness should drop');

  const incomplete = candScore.structural.shotFieldCompleteness.incompleteShots;
  const targetShot = incomplete.find((s) => s.segmentId === 1 && s.shotNumber === 1);
  assert(targetShot, 'shot 1.1 must be listed in incomplete shots');
  assert(targetShot.missing.includes('whatWeSee'), 'missing fields must include whatWeSee');

  const comparison = compareRuns(baselineChecks, candScore);
  assert(comparison.agents['story-director'], 'SD agent comparison must exist');
  assert.equal(candScore.agents['story-director'].status, 'fail');
  assert(comparison.agents['story-director'].candidateErrors.length > 0);
  assert.equal(comparison.verdict, 'REGRESSION');
});

test('copy with broken SC (delete segments) -> SC fail with SCHEMA_REJECTED, verdict REGRESSION', { timeout: 10000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'benchmark-test-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const baselineChecks = JSON.parse(await readFile('benchmarks/r4-dry6/checks.json', 'utf8'));
  const outputs = await loadOutputs('benchmarks/r4-dry6/outputs');
  const inputs = JSON.parse(await readFile('benchmarks/r4-dry6/inputs.json', 'utf8'));

  delete outputs['seedance-compiler'].segments;

  const candScore = await scoreRun({
    outputs,
    inputs,
    approvedAssets: outputs.state?.approvedAssets,
  });

  assert.equal(candScore.agents['seedance-compiler'].status, 'fail');
  const hasSchemaRejected = candScore.agents['seedance-compiler'].errors.some((e) => e.code === 'SCHEMA_REJECTED');
  assert(hasSchemaRejected, 'SC must fail with SCHEMA_REJECTED');

  const comparison = compareRuns(baselineChecks, candScore);
  assert.equal(comparison.verdict, 'REGRESSION');
  assert(comparison.agents['seedance-compiler'].newCodes.includes('SCHEMA_REJECTED'));
  assert.equal(comparison.agents['seedance-compiler'].statusChange, 'pass->fail');
});

test('missing agent output -> missing', { timeout: 10000 }, async () => {
  const outputs = await loadOutputs('benchmarks/r4-dry6/outputs');
  const inputs = JSON.parse(await readFile('benchmarks/r4-dry6/inputs.json', 'utf8'));

  delete outputs['location-scout'];

  const candScore = await scoreRun({
    outputs,
    inputs,
    approvedAssets: outputs.state?.approvedAssets,
  });

  assert.equal(candScore.agents['location-scout'].status, 'missing');
  assert.equal(candScore.totals.missing, 1);
  assert.deepEqual(candScore.agents['location-scout'].errors, []);
  assert.deepEqual(candScore.agents['location-scout'].warnings, []);
  assert.deepEqual(candScore.agents['location-scout'].codeCounts, {});
});

test('judge hook: fake judge score and delta, throwing judge recorded without failing scoring', { timeout: 10000 }, async () => {
  const outputs = await loadOutputs('benchmarks/r4-dry6/outputs');
  const inputs = JSON.parse(await readFile('benchmarks/r4-dry6/inputs.json', 'utf8'));

  const fakeJudge = {
    name: 'test-judge',
    run: async () => ({ score: 0.95, details: 'top notch' }),
  };

  const throwingJudge = {
    name: 'broken-judge',
    run: async () => {
      throw new Error('exploded in judge');
    },
  };

  const candScore = await scoreRun(
    { outputs, inputs, approvedAssets: outputs.state?.approvedAssets },
    { judges: [fakeJudge, throwingJudge] }
  );

  assert.equal(candScore.judges['test-judge'].score, 0.95);
  assert.equal(candScore.judges['test-judge'].details, 'top notch');

  assert(candScore.judges['broken-judge'], 'broken-judge must be recorded');
  assert.equal(candScore.judges['broken-judge'].error, 'exploded in judge');

  const fakeBaseline = {
    agents: {},
    totals: {},
    structural: {},
    judges: {
      'test-judge': { score: 0.85, details: 'decent' },
    },
  };
  const comparison = compareRuns(fakeBaseline, candScore);
  assert.equal(comparison.judges['test-judge'].delta, 0.1);
});

test('privacy: no file under benchmarks/ contains /Users/, an image extension, or data:image', { timeout: 10000 }, async () => {
  async function checkDir(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await checkDir(fullPath);
      } else if (entry.isFile()) {
        const content = await readFile(fullPath, 'utf8');
        assert(!content.includes('/Users/'), `File ${fullPath} contains /Users/`);
        assert(!/\.(jpg|jpeg|png|heic|webp)\b/i.test(content), `File ${fullPath} contains image extension`);
        assert(!content.includes('data:image'), `File ${fullPath} contains data:image`);
      }
    }
  }

  await checkDir('benchmarks');
});

test('markdown renders verdict and both tables', { timeout: 10000 }, async () => {
  const baselineChecks = JSON.parse(await readFile('benchmarks/r4-dry6/checks.json', 'utf8'));
  const comparison = compareRuns(baselineChecks, baselineChecks);
  const md = benchmarkMarkdown(comparison, { candidateName: 'my-candidate', baselineName: 'my-baseline' });

  assert(md.includes('# Benchmark: my-candidate vs my-baseline  ->  SAME'), 'Must render verdict line');
  assert(md.includes('| Agent | Baseline | Candidate | New codes | Gone codes |'), 'Must render Agent table');
  assert(md.includes('| Metric | Baseline | Candidate | Δ |'), 'Must render Metric table');
  assert(md.includes('| story-director |'), 'Must contain agent rows');
  assert(md.includes('| Cast count |'), 'Must contain metric rows');
});
