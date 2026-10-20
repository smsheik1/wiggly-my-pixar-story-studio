// Check an SC omni run against the gate + clip inspections; with --export write ~/wiggly-sc-omni/<clipId>.txt + plan.json.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { selectSeedanceCompilerInput } from '../crew/seedance-compiler/input.mjs';
import { validateSeedancePrompts, shotBlocks } from '../crew/linter/check-seedance-prompts.mjs';
import { parseSeedancePrompts } from '../crew/seedance-compiler/schema.mjs';
const [suffix, exp] = process.argv.slice(2);
const o = 'runs/r5-dry6/outputs', r = (f) => JSON.parse(readFileSync(join(o, f), 'utf8'));
const st = r('state.json'), scst = r(`sc-state-${suffix}.json`);
const approvedAssets = scst.approvedAssets;
const input = selectSeedanceCompilerInput({ videoEngine: 'omni-1.1-flash', storyDirector: r('story-director.json'), characterArchitect: { output: r('character-architect.json') }, locationScout: { output: r('location-scout.json') }, approvedAssets });
const out = parseSeedancePrompts(r(`seedance-compiler-${suffix}.json`));
const g = validateSeedancePrompts(out, input);
console.log('GATE', g.isValid ? 'PASS' : 'FAIL', g.errors.length, 'errors', g.warnings.length, 'warnings');
for (const i of g.issues) console.log(' ', i.severity, i.code, i.message.slice(0, 200));
const bad = [];
const plan = out.segments.map((s) => {
  const id = s.clipId ?? String(s.segmentId);
  const src = input.segments.find((x) => x.segmentId === s.segmentId);
  if (s.totalDurationSec > 10) bad.push(`${id} >10s`);
  for (const b of shotBlocks(s.tenBlocks.block5_shots)) if (/,\s*(voice[- ]?over|off[- ]?camera)\s*:/i.test(b.text) && !/No one on screen speaks; every on-screen mouth stays closed\./.test(b.text)) bad.push(`${id} SHOT ${b.n} no mouths line`);
  const onScr = new Set(s.shots.flatMap((x) => x.cast)); for (const ref of s.references) if (ref.kind === 'character' && !onScr.has(ref.tag)) bad.push(`${id} extra ref ${ref.tag}`);
  const p = { clipId: id, sourcePart: s.segmentId, sourceShots: s.sourceShotNumbers ?? src.shots.map((x) => x.shotNumber), sourceStartSec: s.sourceStartSec ?? 0, trueLenSec: s.totalDurationSec, durationSec: s.generationPayload.durationSec, refs: s.references.map((x) => x.tag), promptChars: s.compiledPrompt.length };
  console.log(JSON.stringify(p)); return { ...p, s };
});
console.log('INSPECT', bad.length ? bad : 'clean', '| assumptions:', JSON.stringify(out.assumptions));
console.log('cost', scst.keySpentUsd, 'wall', scst.wallSec, 'attempts', JSON.stringify(scst.attempts));
if (exp) { const d = join(homedir(), 'wiggly-sc-omni'); rmSync(d, { recursive: true, force: true }); mkdirSync(d);
  for (const p of plan) writeFileSync(join(d, `${p.clipId}.txt`), p.s.compiledPrompt + '\n');
  writeFileSync(join(d, 'plan.json'), JSON.stringify(plan.map(({ s, ...p }) => p), null, 2)); console.log('exported', d); }
