#!/usr/bin/env node
// Benchmark runner: freezes r4-dry6 baseline and deterministically scores runs against it.
// Zero model calls, zero network.
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { AGENT_SPECS } from '../graph/graph.mjs';
import { inputsFromProject, loadPhotoReferences, defaultPhotoRefsPath } from './run-rehearsal.mjs';

export const BENCHMARK_AGENTS = [
  'story-director',
  'character-architect',
  'location-scout',
  'seedance-compiler',
];

const expandHome = (p) => (typeof p === 'string' ? p.replace(/^~(?=$|\/|\\)/, os.homedir()) : p);

// AI Judge Registry
const judgeRegistry = new Map();

export function registerJudge(judge) {
  if (!judge || !judge.name) throw new Error('registerJudge: judge must have a name');
  judgeRegistry.set(judge.name, judge);
}

export function getJudges() {
  return Array.from(judgeRegistry.values());
}

export function clearJudges() {
  judgeRegistry.clear();
}

/** Compute structural metrics across agent outputs. */
export function computeStructuralMetrics(outputs = {}) {
  const sd = outputs['story-director']?.storyDirector ?? outputs['story-director'] ?? null;
  const ca = outputs['character-architect']?.output ?? outputs['character-architect'] ?? null;
  const ls = outputs['location-scout']?.output ?? outputs['location-scout'] ?? null;
  const sc = outputs['seedance-compiler']?.output ?? outputs['seedance-compiler'] ?? null;

  const castCount = sd?.cast ? sd.cast.length : null;
  const characterCount = ca?.characters ? ca.characters.length : null;
  const locationCount = sd?.locations ? sd.locations.length : null;
  const plateCount = ls?.locations ? ls.locations.length : null;
  const segmentCount = sd?.segments ? sd.segments.length : null;
  const shotCount = sd?.segments ? sd.segments.reduce((n, s) => n + (s.shots?.length ?? 0), 0) : null;
  const shotsPerSegment = sd?.segments ? sd.segments.map((s) => s.shots?.length ?? 0) : null;
  const runtimeSec = sd?.segments ? sd.segments.reduce((n, s) => n + (s.targetDurationSec ?? 0), 0) : null;
  const compiledRuntimeSec = sc && sc.totalRuntimeSec !== undefined ? sc.totalRuntimeSec : null;

  let shotFieldCompleteness = null;
  let dialogueLines = null;
  let narrationLines = null;

  if (sd && Array.isArray(sd.segments)) {
    const fields = ['location', 'framing', 'cameraAngle', 'cameraMove', 'whatWeSee', 'whatWeHear'];
    const checkField = (val) => {
      if (val === null || val === undefined) return false;
      if (typeof val === 'string') return val.trim().length > 0;
      if (Array.isArray(val)) return val.length > 0;
      if (typeof val === 'number') return Number.isFinite(val);
      return false;
    };

    let totalScore = 0;
    let shotTotal = 0;
    let minScore = 1;
    const incompleteShots = [];
    let diaCount = 0;
    let narCount = 0;

    for (const seg of sd.segments) {
      for (const shot of seg.shots ?? []) {
        shotTotal++;
        const missing = fields.filter((f) => !checkField(shot[f]));
        const score = (fields.length - missing.length) / fields.length;
        totalScore += score;
        if (score < minScore) minScore = score;
        if (missing.length > 0) {
          incompleteShots.push({
            segmentId: seg.segmentId,
            shotNumber: shot.shotNumber,
            missing,
          });
        }

        // Count dialogue lines
        if (Array.isArray(shot.dialogueLines)) {
          diaCount += shot.dialogueLines.length;
        } else if (Array.isArray(shot.dialogue)) {
          diaCount += shot.dialogue.length;
        } else if (shot.dialogue?.line || typeof shot.dialogue === 'string') {
          diaCount += 1;
        }

        // Count narration lines
        if (Array.isArray(shot.narrationLines)) {
          narCount += shot.narrationLines.length;
        } else if (Array.isArray(shot.narration)) {
          narCount += shot.narration.length;
        } else if (shot.narration?.line || typeof shot.narration === 'string') {
          narCount += 1;
        }
      }
    }

    const mean = shotTotal > 0 ? Number((totalScore / shotTotal).toFixed(3)) : 1;
    const min = shotTotal > 0 ? Number(minScore.toFixed(3)) : 1;
    shotFieldCompleteness = {
      mean,
      min,
      incompleteShots,
      incomplete: incompleteShots,
    };
    dialogueLines = diaCount;
    narrationLines = narCount;
  }

  return {
    castCount,
    characterCount,
    locationCount,
    plateCount,
    segmentCount,
    shotCount,
    shotsPerSegment,
    runtimeSec,
    compiledRuntimeSec,
    shotFieldCompleteness,
    dialogueLines,
    narrationLines,
  };
}

/** Rebuild state and score an agent run against determinism gates. */
export async function scoreRun({ outputs = {}, inputs = {}, approvedAssets, runDir } = {}, { judges = [] } = {}) {
  const sdOutput = outputs['story-director']?.storyDirector ?? outputs['story-director']?.output ?? outputs['story-director'] ?? null;
  const caOutput = outputs['character-architect']?.output ?? outputs['character-architect'] ?? null;
  const lsOutput = outputs['location-scout']?.output ?? outputs['location-scout'] ?? null;
  const scOutput = outputs['seedance-compiler']?.output ?? outputs['seedance-compiler'] ?? null;

  const assets = approvedAssets ?? outputs.state?.approvedAssets ?? {};

  const state = {
    inputs: inputs ?? {},
    storyDirector: sdOutput ?? undefined,
    characterArchitect: caOutput ? { output: caOutput } : undefined,
    locationScout: lsOutput ? { output: lsOutput } : undefined,
    seedanceCompiler: scOutput ? { output: scOutput } : undefined,
    approvedAssets: assets,
  };

  const agentRecords = {};

  for (const agent of BENCHMARK_AGENTS) {
    const rawOut = outputs[agent];
    if (!rawOut) {
      agentRecords[agent] = {
        status: 'missing',
        errors: [],
        warnings: [],
        codeCounts: {},
      };
      continue;
    }

    const spec = AGENT_SPECS[agent];
    if (!spec) {
      agentRecords[agent] = {
        status: 'fail',
        errors: [{ code: 'UNKNOWN_AGENT', path: '', message: `No spec for agent ${agent}` }],
        warnings: [],
        codeCounts: { UNKNOWN_AGENT: 1 },
      };
      continue;
    }

    let agentInput;
    try {
      agentInput = spec.select(state);
    } catch (e) {
      agentRecords[agent] = {
        status: 'fail',
        errors: [{ code: 'INPUT_SELECTOR_FAILED', path: '', message: e.message }],
        warnings: [],
        codeCounts: { INPUT_SELECTOR_FAILED: 1 },
      };
      continue;
    }

    let parsed;
    try {
      parsed = spec.parse(JSON.stringify(rawOut));
    } catch (e) {
      const schemaIssues = (e.issues ?? [{ path: [], message: e.message }]).map((i) => {
        const path = Array.isArray(i.path) ? i.path.join('.') : (i.path ?? '');
        return { code: 'SCHEMA_REJECTED', path, message: path ? `${path}: ${i.message}` : i.message };
      });
      agentRecords[agent] = {
        status: 'fail',
        errors: schemaIssues,
        warnings: [],
        codeCounts: { SCHEMA_REJECTED: schemaIssues.length },
      };
      continue;
    }

    try {
      const r = spec.gate(parsed, agentInput, state);
      const errors = (r.issues ?? []).filter((i) => i.severity === 'error').map((i) => ({ code: i.code, path: i.path ?? '', message: i.message }));
      const warnings = (r.issues ?? []).filter((i) => i.severity !== 'error').map((i) => ({ code: i.code, path: i.path ?? '', message: i.message }));
      const codeCounts = {};
      for (const i of [...errors, ...warnings]) {
        codeCounts[i.code] = (codeCounts[i.code] || 0) + 1;
      }
      agentRecords[agent] = {
        status: errors.length === 0 ? 'pass' : 'fail',
        errors,
        warnings,
        codeCounts,
      };
    } catch (e) {
      agentRecords[agent] = {
        status: 'fail',
        errors: [{ code: 'GATE_FAILED', path: '', message: e.message }],
        warnings: [],
        codeCounts: { GATE_FAILED: 1 },
      };
    }
  }

  const totals = {
    passed: 0,
    failed: 0,
    missing: 0,
    errors: 0,
    warnings: 0,
  };
  for (const agent of BENCHMARK_AGENTS) {
    const r = agentRecords[agent];
    if (r.status === 'pass') totals.passed++;
    else if (r.status === 'fail') totals.failed++;
    else if (r.status === 'missing') totals.missing++;
    totals.errors += r.errors.length;
    totals.warnings += r.warnings.length;
  }

  const structural = computeStructuralMetrics(outputs);

  const resultJudges = {};
  const activeJudges = judges && judges.length ? judges : getJudges();
  for (const judge of activeJudges) {
    try {
      const res = await judge.run({ outputs, inputs, runDir });
      resultJudges[judge.name] = res;
    } catch (err) {
      resultJudges[judge.name] = { error: err?.message ?? String(err) };
    }
  }

  return {
    agents: agentRecords,
    totals,
    structural,
    judges: resultJudges,
  };
}

/** Compare candidate run scoring against baseline. */
export function compareRuns(baseline, candidate) {
  const agentsComparison = {};
  let isRegression = false;
  let isImproved = false;

  for (const agent of BENCHMARK_AGENTS) {
    const baseAgent = baseline.agents?.[agent] ?? { status: 'missing', errors: [], warnings: [], codeCounts: {} };
    const candAgent = candidate.agents?.[agent] ?? { status: 'missing', errors: [], warnings: [], codeCounts: {} };

    const statusChange = baseAgent.status !== candAgent.status ? `${baseAgent.status}->${candAgent.status}` : null;

    const baseCodes = baseAgent.codeCounts ?? {};
    const candCodes = candAgent.codeCounts ?? {};
    const allCodes = new Set([...Object.keys(baseCodes), ...Object.keys(candCodes)]);

    const newCodes = Object.keys(candCodes).filter((c) => !baseCodes[c] || baseCodes[c] === 0);
    const goneCodes = Object.keys(baseCodes).filter((c) => !candCodes[c] || candCodes[c] === 0);
    const changedCodes = [...allCodes]
      .filter((c) => (baseCodes[c] || 0) > 0 && (candCodes[c] || 0) > 0 && baseCodes[c] !== candCodes[c])
      .map((c) => ({
        code: c,
        baseline: baseCodes[c],
        candidate: candCodes[c],
        baselineCount: baseCodes[c],
        candidateCount: candCodes[c],
      }));

    // Regression checks: pass->fail or new error code
    if (baseAgent.status === 'pass' && candAgent.status === 'fail') {
      isRegression = true;
    }
    const baseErrorCodes = new Set((baseAgent.errors ?? []).map((e) => e.code));
    for (const err of candAgent.errors ?? []) {
      if (!baseErrorCodes.has(err.code)) {
        isRegression = true;
      }
    }

    agentsComparison[agent] = {
      statusChange,
      status: { baseline: baseAgent.status, candidate: candAgent.status },
      newCodes,
      goneCodes,
      changedCodes,
      baselineErrors: baseAgent.errors ?? [],
      candidateErrors: candAgent.errors ?? [],
      baselineWarnings: baseAgent.warnings ?? [],
      candidateWarnings: candAgent.warnings ?? [],
    };
  }

  if (!isRegression) {
    for (const agent of BENCHMARK_AGENTS) {
      const baseAgent = baseline.agents?.[agent];
      const candAgent = candidate.agents?.[agent];
      if (baseAgent?.status === 'fail' && candAgent?.status === 'pass') {
        isImproved = true;
      }
    }
    const baseTotalErrors = baseline.totals?.errors ?? 0;
    const candTotalErrors = candidate.totals?.errors ?? 0;
    if (candTotalErrors < baseTotalErrors) {
      isImproved = true;
    }
  }

  const verdict = isRegression ? 'REGRESSION' : (isImproved ? 'IMPROVED' : 'SAME');

  // Structural metrics comparison
  const structuralComparison = {};
  const scalarKeys = [
    'castCount', 'characterCount', 'locationCount', 'plateCount',
    'segmentCount', 'shotCount', 'runtimeSec', 'compiledRuntimeSec',
    'dialogueLines', 'narrationLines',
  ];

  for (const k of scalarKeys) {
    const b = baseline.structural?.[k] ?? null;
    const c = candidate.structural?.[k] ?? null;
    const changed = b !== c;
    const delta = (typeof b === 'number' && typeof c === 'number') ? (changed ? c - b : 0) : null;
    structuralComparison[k] = { baseline: b, candidate: c, delta, changed };
  }

  // shotsPerSegment
  const bShots = baseline.structural?.shotsPerSegment ?? null;
  const cShots = candidate.structural?.shotsPerSegment ?? null;
  const shotsChanged = JSON.stringify(bShots) !== JSON.stringify(cShots);
  structuralComparison.shotsPerSegment = {
    baseline: bShots,
    candidate: cShots,
    delta: shotsChanged && bShots && cShots ? cShots.map((s, i) => s - (bShots[i] ?? 0)) : 0,
    changed: shotsChanged,
  };

  // shotFieldCompleteness
  const bComp = baseline.structural?.shotFieldCompleteness ?? null;
  const cComp = candidate.structural?.shotFieldCompleteness ?? null;
  const bMean = bComp?.mean ?? null;
  const cMean = cComp?.mean ?? null;
  const bMin = bComp?.min ?? null;
  const cMin = cComp?.min ?? null;
  const meanChanged = bMean !== cMean;
  const minChanged = bMin !== cMin;
  const compChanged = meanChanged || minChanged;

  const meanDelta = (typeof bMean === 'number' && typeof cMean === 'number') ? (meanChanged ? Number((cMean - bMean).toFixed(3)) : 0) : null;
  const minDelta = (typeof bMin === 'number' && typeof cMin === 'number') ? (minChanged ? Number((cMin - bMin).toFixed(3)) : 0) : null;

  structuralComparison.shotFieldCompleteness = {
    baseline: bComp,
    candidate: cComp,
    delta: meanDelta,
    changed: compChanged,
    mean: {
      baseline: bMean,
      candidate: cMean,
      delta: meanDelta,
      changed: meanChanged,
    },
    min: {
      baseline: bMin,
      candidate: cMin,
      delta: minDelta,
      changed: minChanged,
    },
  };

  // Judges comparison
  const judgesComparison = {};
  const allJudgeNames = new Set([
    ...Object.keys(baseline.judges ?? {}),
    ...Object.keys(candidate.judges ?? {}),
  ]);
  for (const name of allJudgeNames) {
    const bJ = baseline.judges?.[name] ?? null;
    const cJ = candidate.judges?.[name] ?? null;
    const bScore = typeof bJ?.score === 'number' ? bJ.score : null;
    const cScore = typeof cJ?.score === 'number' ? cJ.score : null;
    const delta = (bScore !== null && cScore !== null) ? Number((cScore - bScore).toFixed(3)) : null;
    judgesComparison[name] = {
      baseline: bJ,
      candidate: cJ,
      delta: (bScore !== null && cScore !== null && bScore === cScore) ? 0 : delta,
      changed: delta !== null && delta !== 0,
    };
  }

  return {
    verdict,
    agents: agentsComparison,
    structural: structuralComparison,
    judges: judgesComparison,
  };
}

/** Render comparison Markdown report. */
export function benchmarkMarkdown(comparison, { candidateName = 'candidate', baselineName = 'baseline' } = {}) {
  const lines = [];
  lines.push(`# Benchmark: ${candidateName} vs ${baselineName}  ->  ${comparison.verdict}`);
  lines.push('');

  // Agents table
  lines.push('| Agent | Baseline | Candidate | New codes | Gone codes |');
  lines.push('|---|---|---|---|---|');
  for (const agent of BENCHMARK_AGENTS) {
    const a = comparison.agents?.[agent];
    if (!a) continue;
    const baseStatus = a.status?.baseline ?? 'missing';
    const candStatus = a.status?.candidate ?? 'missing';
    const newCodesStr = a.newCodes?.length ? a.newCodes.join(', ') : '-';
    const goneCodesStr = a.goneCodes?.length ? a.goneCodes.join(', ') : '-';
    lines.push(`| ${agent} | ${baseStatus} | ${candStatus} | ${newCodesStr} | ${goneCodesStr} |`);
  }
  lines.push('');

  // Metric table
  const metricLabels = {
    castCount: 'Cast count',
    characterCount: 'Character count',
    locationCount: 'Location count',
    plateCount: 'Plate count',
    segmentCount: 'Segment count',
    shotCount: 'Shot count',
    shotsPerSegment: 'Shots per segment',
    runtimeSec: 'Runtime (sec)',
    compiledRuntimeSec: 'Compiled runtime (sec)',
    shotFieldCompleteness: 'Shot completeness (mean)',
    dialogueLines: 'Dialogue lines',
    narrationLines: 'Narration lines',
  };

  lines.push('| Metric | Baseline | Candidate | Δ |');
  lines.push('|---|---|---|---|');
  for (const [key, label] of Object.entries(metricLabels)) {
    const m = comparison.structural?.[key];
    if (!m) continue;
    let bStr, cStr, dStr;
    if (key === 'shotFieldCompleteness') {
      bStr = m.mean?.baseline !== null && m.mean?.baseline !== undefined ? String(m.mean.baseline) : '-';
      cStr = m.mean?.candidate !== null && m.mean?.candidate !== undefined ? String(m.mean.candidate) : '-';
      dStr = m.mean?.delta !== null && m.mean?.delta !== undefined ? (m.mean.delta > 0 ? `+${m.mean.delta}` : String(m.mean.delta)) : '-';
    } else if (key === 'shotsPerSegment') {
      bStr = Array.isArray(m.baseline) ? m.baseline.join(', ') : (m.baseline ?? '-');
      cStr = Array.isArray(m.candidate) ? m.candidate.join(', ') : (m.candidate ?? '-');
      dStr = m.changed ? (Array.isArray(m.delta) ? m.delta.map((d) => (d > 0 ? `+${d}` : d)).join(', ') : String(m.delta)) : '0';
    } else {
      bStr = m.baseline !== null && m.baseline !== undefined ? String(m.baseline) : '-';
      cStr = m.candidate !== null && m.candidate !== undefined ? String(m.candidate) : '-';
      if (m.delta !== null && m.delta !== undefined) {
        dStr = m.delta > 0 ? `+${m.delta}` : String(m.delta);
      } else {
        dStr = '-';
      }
    }
    lines.push(`| ${label} | ${bStr} | ${cStr} | ${dStr} |`);
  }
  lines.push('');

  // Judges
  const judges = Object.entries(comparison.judges ?? {});
  if (judges.length > 0) {
    for (const [name, j] of judges) {
      const bScore = j.baseline?.score !== undefined ? String(j.baseline.score) : 'none';
      const cScore = j.candidate?.score !== undefined ? String(j.candidate.score) : 'none';
      lines.push(`Judges: ${name}: ${bScore} -> ${cScore}`);
    }
    lines.push('');
  }

  // Up to 10 incomplete shots
  const incompleteShots = comparison.structural?.shotFieldCompleteness?.candidate?.incompleteShots ?? [];
  if (incompleteShots.length > 0) {
    lines.push('### Incomplete shots');
    const displayShots = incompleteShots.slice(0, 10);
    for (const s of displayShots) {
      lines.push(`- Segment ${s.segmentId} shot ${s.shotNumber}: missing ${s.missing.join(', ')}`);
    }
    if (incompleteShots.length > 10) {
      lines.push(`- ... and ${incompleteShots.length - 10} more`);
    }
    lines.push('');
  }

  // Full new-code messages
  const newCodeMessages = [];
  for (const agent of BENCHMARK_AGENTS) {
    const a = comparison.agents?.[agent];
    if (!a?.newCodes?.length) continue;
    const newSet = new Set(a.newCodes);
    for (const err of [...a.candidateErrors, ...a.candidateWarnings]) {
      if (newSet.has(err.code)) {
        newCodeMessages.push(`- [${agent}] [${err.code}]${err.path ? ` (${err.path})` : ''}: ${err.message}`);
      }
    }
  }
  if (newCodeMessages.length > 0) {
    lines.push('### New code messages');
    for (const msg of newCodeMessages) {
      lines.push(msg);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Load run outputs from a directory. */
export async function loadOutputs(dir) {
  const outputs = {};
  if (!existsSync(dir)) return outputs;
  const files = ['story-director.json', 'character-architect.json', 'location-scout.json', 'seedance-compiler.json', 'state.json'];
  for (const f of files) {
    const p = join(dir, f);
    if (existsSync(p)) {
      try {
        const text = await readFile(p, 'utf8');
        outputs[f.replace(/\.json$/, '')] = JSON.parse(text);
      } catch {
        // Leave undefined or null
      }
    }
  }
  return outputs;
}

/** Freeze baseline from an existing run and project input. */
export async function freezeBaseline({
  runId = 'r4-dry6',
  projectPath,
  photoRefsPath,
  outDir,
  runsRoot = 'runs',
  repoRoot = process.cwd(),
} = {}) {
  if (!projectPath) throw new Error('--project <file> is required for freeze');
  const targetDir = outDir ?? join(repoRoot, 'benchmarks', runId);
  const candRunDir = join(runsRoot, runId);
  const srcOutputsDir = join(candRunDir, 'outputs');
  const destOutputsDir = join(targetDir, 'outputs');

  await mkdir(destOutputsDir, { recursive: true });

  // 1. Byte copies of outputs
  const outputFiles = ['story-director.json', 'character-architect.json', 'location-scout.json', 'seedance-compiler.json', 'state.json'];
  const outputs = {};
  for (const file of outputFiles) {
    const srcFile = join(srcOutputsDir, file);
    const destFile = join(destOutputsDir, file);
    await copyFile(srcFile, destFile);
    const content = await readFile(srcFile, 'utf8');
    const agentName = file.replace(/\.json$/, '');
    outputs[agentName] = JSON.parse(content);
  }

  // 2. inputs.json
  const project = JSON.parse(await readFile(expandHome(projectPath), 'utf8'));
  const inputs = inputsFromProject(project);
  const resolvedPhotoRefsPath = photoRefsPath
    ? expandHome(photoRefsPath)
    : defaultPhotoRefsPath(expandHome(projectPath));
  const refs = await loadPhotoReferences(resolvedPhotoRefsPath);
  if (refs?.length) {
    inputs.photoReferences = refs.map(({ path, ...r }) => r);
  }

  // Check privacy constraints
  const inputsJsonStr = JSON.stringify(inputs, null, 2);
  if (inputsJsonStr.includes('/Users/')) {
    throw new Error('Privacy check failed: inputs contains /Users/');
  }
  if (/\.(jpg|jpeg|png|heic|webp)\b/i.test(inputsJsonStr)) {
    throw new Error('Privacy check failed: inputs contains image extension');
  }
  if (inputsJsonStr.includes('data:image')) {
    throw new Error('Privacy check failed: inputs contains data:image');
  }

  await writeFile(join(targetDir, 'inputs.json'), inputsJsonStr, 'utf8');

  // 3. checks.json (scored result)
  const approvedAssets = outputs.state?.approvedAssets ?? {};
  const checks = await scoreRun({
    outputs,
    inputs,
    approvedAssets,
    runDir: targetDir,
  });
  await writeFile(join(targetDir, 'checks.json'), JSON.stringify(checks, null, 2), 'utf8');

  // 4. README.md: exactly 5 lines
  const readmeContent = [
    `# Baseline: ${runId}`,
    '',
    'Frozen outputs and sanitized inputs for regression benchmarking.',
    'Re-freeze with:',
    `node scripts/benchmark.mjs --freeze ${runId} --project ~/bible-work/r4-project.json --photo-refs ~/bible-work/r4-project-photo-refs.json`,
  ].join('\n') + '\n';
  await writeFile(join(targetDir, 'README.md'), readmeContent, 'utf8');

  return { targetDir, checks };
}

// CLI entrypoint
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i >= 0 && i < process.argv.length - 1 ? process.argv[i + 1] : undefined;
  };
  const has = (k) => process.argv.includes(k);

  (async () => {
    try {
      if (has('--freeze')) {
        const runId = arg('--freeze');
        const projectPath = arg('--project');
        const photoRefsPath = arg('--photo-refs');
        if (!runId || !projectPath) {
          console.error('Usage: node scripts/benchmark.mjs --freeze <runId> --project <project.json> [--photo-refs <file>]');
          process.exit(1);
        }
        await freezeBaseline({ runId, projectPath, photoRefsPath });
        console.log(`Frozen baseline benchmarks/${runId}/ created successfully.`);
        process.exit(0);
      }

      if (has('--run')) {
        const runArg = arg('--run');
        if (!runArg) {
          console.error('Error: --run requires a runId or path');
          process.exit(1);
        }

        const baselineArg = arg('--baseline') ?? 'benchmarks/r4-dry6';
        const isJson = has('--json');
        const outFile = arg('--out');
        const judgeName = arg('--judge');

        // Resolve candidate run directory
        let candRunDir = runArg;
        if (!existsSync(candRunDir)) {
          candRunDir = join('runs', runArg);
          if (!existsSync(candRunDir)) {
            console.error(`Run directory not found: ${runArg}`);
            process.exit(1);
          }
        }

        // Resolve baseline directory
        let baselineDir = baselineArg;
        if (!existsSync(baselineDir)) {
          console.error(`Baseline directory not found: ${baselineArg}`);
          process.exit(1);
        }

        // Load baseline checks
        let baselineScore;
        const baselineChecksPath = join(baselineDir, 'checks.json');
        if (existsSync(baselineChecksPath)) {
          baselineScore = JSON.parse(await readFile(baselineChecksPath, 'utf8'));
        } else {
          const bOutputs = await loadOutputs(join(baselineDir, 'outputs'));
          const bInputs = existsSync(join(baselineDir, 'inputs.json'))
            ? JSON.parse(await readFile(join(baselineDir, 'inputs.json'), 'utf8'))
            : {};
          baselineScore = await scoreRun({ outputs: bOutputs, inputs: bInputs, approvedAssets: bOutputs.state?.approvedAssets });
        }

        // Load candidate outputs
        const candOutputs = await loadOutputs(join(candRunDir, 'outputs'));

        // Load candidate inputs
        let candInputs = {};
        if (existsSync(join(candRunDir, 'inputs.json'))) {
          candInputs = JSON.parse(await readFile(join(candRunDir, 'inputs.json'), 'utf8'));
        } else if (existsSync(join(baselineDir, 'inputs.json'))) {
          candInputs = JSON.parse(await readFile(join(baselineDir, 'inputs.json'), 'utf8'));
        }

        // Load judges
        const judges = [];
        if (judgeName) {
          const judgePath = fileURLToPath(new URL(`./judges/${judgeName}.mjs`, import.meta.url));
          if (!existsSync(judgePath)) {
            console.error(`Judge not found: ${judgePath}`);
            process.exit(1);
          }
          const judgeModule = await import(pathToFileURL(judgePath).href);
          judges.push(judgeModule.default ?? judgeModule);
        }

        const candidateScore = await scoreRun({
          outputs: candOutputs,
          inputs: candInputs,
          approvedAssets: candOutputs.state?.approvedAssets,
          runDir: candRunDir,
        }, { judges });

        const comparison = compareRuns(baselineScore, candidateScore);
        const candidateName = basename(candRunDir);
        const baselineName = basename(baselineDir);
        const md = benchmarkMarkdown(comparison, { candidateName, baselineName });

        // Also write runs/<id>/benchmark.md
        try {
          await writeFile(join(candRunDir, 'benchmark.md'), md, 'utf8');
        } catch {
          // ignore write errors if directory not writable
        }

        if (outFile) {
          await writeFile(outFile, md, 'utf8');
        }

        if (isJson) {
          console.log(JSON.stringify(comparison, null, 2));
        } else {
          console.log(md);
        }
        process.exit(0);
      }

      console.error('Usage: node scripts/benchmark.mjs --run <runId> | --freeze <runId> --project <file>');
      process.exit(1);
    } catch (err) {
      console.error(`Benchmark failed: ${err.message}`);
      process.exit(1);
    }
  })();
}
