// v2 patch mode: fix one thing (a line, a shot or a part) without redoing the story. See docs/specs/patch-mode.md.
//   START -> story-director (patch) -> impact -> [character-architect? || location-scout?] -> join -> asset-approval
//         -> seedance-compiler (affected parts only)? -> finish -> END
// The Story Director gets its current output, the target and the user's note, and resubmits the whole output through
// the normal validated submit; its gate is the full Story Director gate PLUS checkPatchScope (nothing outside the
// target changed). Downstream, only what the change touches runs again; everything else is copied from the prior run.
import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { PipelineAnnotation } from './state.mjs';
import { makeAgentNode, makeApprovalNode, AGENT_SPECS, MAX_ATTEMPTS, gateCharacters, keepValidCharacters, mergeCharacters } from './graph.mjs';
import { deepAgentInvoke } from './deep-agent-node.mjs';
import { V2_MODELS } from '../config/models.mjs';
import { scopePatchIssues, parseTarget, checkPatchScope, describeScope, changedShots, diffPaths, pathText } from '../crew/linter/patch-scope.mjs';
import { selectStoryDirectorInput } from '../crew/story-director/input.mjs';
import { parseStagePlay } from '../crew/story-director/schema.mjs';
import { parseCharacterSheets } from '../crew/character-architect/schema.mjs';
import { parseLocationPlates } from '../crew/location-scout/schema.mjs';
import { validateStoryDirectorOutput } from '../crew/linter/check-stage-play.mjs';
import { selectCharacterArchitectInput } from '../crew/character-architect/input.mjs';
import { selectLocationScoutInput } from '../crew/location-scout/input.mjs';
import { validateLocationPlates } from '../crew/linter/check-location-plates.mjs';
import { selectSeedanceCompilerInput, seedanceSegmentsOf } from '../crew/seedance-compiler/input.mjs';
import { makeSeedancePatchSchema, withAssembledPrompts, SeedancePromptParseError, BLOCK_KEYS, parseSeedancePrompts } from '../crew/seedance-compiler/schema.mjs';
import { validateSeedancePrompts, shotBlocks } from '../crew/linter/check-seedance-prompts.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const gateResult = (issues) => { const errors = issues.filter((i) => i.severity === 'error').map((i) => i.message);
  return { isValid: errors.length === 0, errors, warnings: issues.filter((i) => i.severity !== 'error').map((i) => i.message), issues }; };
const halted = (s) => ['escalated', 'failed', 'awaiting-approval'].includes(s.status);

/** Reflection rounds for a Story Director patch: --reflection-rounds, else config patchReflectionRounds (default 1). */
export const patchReflectionRounds = (override) => (Number.isInteger(override) && override >= 0 ? override : V2_MODELS['story-director'].patchReflectionRounds ?? 1);

/** First user message of a Story Director patch run. */
export function patchTask(target, note) {
  return [
    `PATCH MODE. Do not write a new story: fix ONE thing in the existing Story Director output.`,
    `The current output is patch.currentOutput in /references/input.json. The target is ${target.id}. The user's note on what is wrong, in their words: "${note}"`,
    `Rewrite only the target so it fixes the note and still follows every rule in your SKILL.md (facts from the answers, line sources, shot locks, speech timing, finale). ${describeScope(target)}`,
    'Copy every other field exactly, character for character, from patch.currentOutput. A code check compares your output with it and rejects any change outside the target.',
    'Finish by calling submit_story_director with the complete output (the whole JSON, not a diff).',
  ].join('\n');
}
/** Shown to the self-review critic and the rewrite in patch mode. */
export const patchScopeText = (target, note) => `PATCH MODE: this review is scoped to the target ${target.id} only. The user's note: "${note}". Check that the target fixes the note and follows your rules; do not ask for changes anywhere else. ${describeScope(target)} Any change outside that is itself a problem: list it with the field path so it is copied back.`;

/** The Story Director's patch spec: normal parse, full gate + scope proof, scoped request. */
export function storyDirectorPatchSpec({ prior, target, note, rounds, animaticApproved = false }) {
  const base = AGENT_SPECS['story-director'];
  return {
    ...base,
    select: (state) => ({ ...selectStoryDirectorInput(state), patch: { target: target.id, note, editable: describeScope(target), currentOutput: prior } }),
    // the patch answers for its target: pre-existing errors elsewhere (and animatic-waived checks) are warnings
    gate: (out, input) => gateResult([...checkPatchScope(prior, out, target), ...scopePatchIssues(validateStoryDirectorOutput(out, input).issues, { target, priorIssues: validateStoryDirectorOutput(prior, input).issues, animaticApproved })]),
    request: () => ({ task: patchTask(target, note), scope: patchScopeText(target, note), rounds }),
  };
}

// ---- impact: what the Story Director change touches downstream (deterministic) ----
const noSource = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'source' ? undefined : x))); // the compiler never sees line sources
/** Compare the Seedance Compiler's per-part input slices before and after: a part is affected when its slice changed. */
export function affectedSeedanceParts(priorSd, nextSd) {
  const before = new Map(seedanceSegmentsOf(priorSd).map((s) => [s.segmentId, noSource(s)]));
  return seedanceSegmentsOf(nextSd).filter((s) => !same(before.get(s.segmentId), noSource(s))).map((s) => s.segmentId);
}
/** Prior location plates with sceneIds re-synced to the patched stage play (bookkeeping, no model call). */
export function resyncLocationScenes(lsOut, state) {
  if (!lsOut?.locations) return lsOut;
  const settings = selectLocationScoutInput(state).settings;
  return { ...lsOut, locations: lsOut.locations.map((l) => { const s = settings.find((x) => x.name === l.settingName); return s ? { ...l, sceneIds: s.sceneIds } : l; }) };
}
export function computeImpact(priorSd, nextSd) {
  const priorTags = new Set((priorSd.cast ?? []).map((c) => c.elementTag));
  const priorLocs = new Set((priorSd.locations ?? []).map((l) => l.name));
  return {
    sdChangedPaths: diffPaths(priorSd, nextSd).map((c) => pathText(c.path)),
    changedShots: changedShots(priorSd, nextSd),
    newCast: (nextSd.cast ?? []).map((c) => c.elementTag).filter((t) => !priorTags.has(t)),
    newLocations: (nextSd.locations ?? []).map((l) => l.name).filter((n) => !priorLocs.has(n)),
    // existing locations whose description was corrected: their plates are re-authored (same @Loc slot)
    changedLocations: (nextSd.locations ?? []).filter((l) => { const b = (priorSd.locations ?? []).find((x) => x.name === l.name); return b && b.description !== l.description; }).map((l) => l.name),
    scParts: affectedSeedanceParts(priorSd, nextSd),
  };
}

// ---- downstream patch specs: run only for what is new, merge into the prior output ----
export function characterArchitectPatchSpec({ priorCa }) {
  const base = AGENT_SPECS['character-architect'];
  const priorByTag = Object.fromEntries((priorCa?.characters ?? []).map((c) => [c.elementTag, c]));
  return {
    ...base,
    select: (state) => {
      const full = selectCharacterArchitectInput(state), only = new Set(state.patch.impact.newCast);
      return { ...full, cast: full.cast.filter((c) => only.has(c.elementTag)), photoNotes: (full.photoNotes ?? []).filter((p) => only.has(p.elementTag)) };
    },
    merge: (kept, out, state) => mergeCharacters({ ...priorByTag, ...(kept ?? {}) }, out, state),
    carry: keepValidCharacters,
    gate: (out, _in, state) => gateCharacters(out.characters?.length === (state.storyDirector?.cast ?? []).length ? out : mergeCharacters(priorByTag, out, state), state.storyDirector),
    request: (input) => ({ rounds: 0, task: `PATCH MODE: the stage play gained new cast members (${input.cast.map((c) => c.elementTag).join(', ')}). Produce characters ONLY for the cast cards in /references/input.json; every existing character is already approved and kept as it is.` }),
  };
}
export function locationScoutPatchSpec() {
  const base = AGENT_SPECS['location-scout'];
  const mergeLs = (out, state) => {
    const prior = state.locationScout?.output ?? { locations: [], assumptions: [] }; // already re-synced by the impact node
    const have = new Set(prior.locations.map((l) => l.settingName));
    const redo = new Map((out.locations ?? []).filter((l) => have.has(l.settingName)).map((l) => [l.settingName, l]));
    const fresh = (out.locations ?? []).filter((l) => !have.has(l.settingName));
    const kept = prior.locations.map((l) => (redo.has(l.settingName) ? { ...redo.get(l.settingName), elementTag: l.elementTag } : l));
    return { ...prior, locations: [...kept, ...fresh.map((l, i) => ({ ...l, elementTag: `@Loc ${prior.locations.length + i + 1}` }))], assumptions: [...(prior.assumptions ?? []), ...(out.assumptions ?? [])] };
  };
  return {
    ...base,
    select: (state) => {
      const full = selectLocationScoutInput(state), only = new Set([...state.patch.impact.newLocations, ...(state.patch.impact.changedLocations ?? [])]);
      return { ...full, settings: full.settings.filter((s) => only.has(s.name)), scenes: full.scenes.filter((s) => only.has(s.location)) };
    },
    merge: (_kept, out, state) => mergeLs(out, state),
    gate: (out, _in, state) => validateLocationPlates(out, selectLocationScoutInput(state)),
    request: (input) => ({ rounds: 0, task: `PATCH MODE: the stage play gained or corrected locations (${input.settings.map((s) => s.name).join(', ')}). Produce plates ONLY for the settings in /references/input.json, following their descriptions exactly; every other plate is already approved and kept as it is.` }),
  };
}
const COMPILED = Symbol.for('wiggly.v2.patch.compiled');
export function seedanceCompilerPatchSpec({ priorSc, note }) {
  const base = AGENT_SPECS['seedance-compiler'];
  const positions = Object.fromEntries((priorSc?.segments ?? []).map((s) => [s.segmentId, s.segmentIndex]));
  const parseSchema = makeSeedancePatchSchema(positions);
  const mergeSc = (out, ids) => {
    const fresh = new Map((out.segments ?? []).filter((s) => ids.includes(s.segmentId)).map((s) => [s.segmentId, s]));
    const segments = priorSc.segments.map((s) => fresh.get(s.segmentId) ?? s);
    const merged = { ...priorSc, segments, totalRuntimeSec: segments.reduce((n, s) => n + s.totalDurationSec, 0),
      assumptions: [...(priorSc.assumptions ?? []), ...(out.assumptions ?? []).filter((a) => !(priorSc.assumptions ?? []).includes(a))] };
    Object.defineProperty(merged, COMPILED, { value: [...fresh.keys()], enumerable: false });
    return merged;
  };
  return {
    ...base,
    select: (state) => {
      const full = selectSeedanceCompilerInput(state), ids = state.patch.impact.scParts;
      return { ...full, segments: full.segments.filter((s) => ids.includes(s.segmentId)),
        patch: { compileParts: ids.map((id) => ({ segmentId: id, segmentIndex: positions[id], extendsFrom: positions[id] === 1 ? null : positions[id] - 1 })),
          changedShots: state.patch.impact.changedShots, note, priorSegments: priorSc.segments.filter((s) => ids.includes(s.segmentId)) } };
    },
    parse: (raw) => { const r = parseSchema.safeParse(withAssembledPrompts(typeof raw === 'string' ? JSON.parse(raw) : raw)); if (!r.success) throw new SeedancePromptParseError(r.error.issues); return r.data; },
    merge: (_kept, out, state) => mergeSc(out, state.patch.impact.scParts),
    gate: (out, _in, state) => {
      const ids = state.patch.impact.scParts;
      const merged = out[COMPILED] ? out : mergeSc(out, ids);
      const missing = ids.filter((id) => !merged[COMPILED].includes(id));
      return gateResult([...missing.map((id) => ({ severity: 'error', code: 'PATCH_SEGMENT_MISSING', message: `part ${id} is affected by the patch but was not compiled.`, path: 'segments' })),
        ...validateSeedancePrompts(merged, selectSeedanceCompilerInput(state)).issues]);
    },
    request: (input) => ({ rounds: 0, submitSchema: makeSeedancePatchSchema(positions, input.patch.compileParts.map((p) => p.segmentId)),
      task: [`PATCH MODE: the stage play changed in part(s) ${input.patch.compileParts.map((p) => p.segmentId).join(', ')} (changed shots: ${input.patch.changedShots.join(', ') || 'none'}). Compile ONLY those parts, which are the only segments in /references/input.json.`,
        'Each keeps its place in the whole film: use segmentIndex and extendsFrom exactly as patch.compileParts gives them. patch.priorSegments has the prompts before the change: keep their wording wherever the stage play did not change, and rewrite only what the change requires.',
        'Finish by calling submit_seedance_compiler with those parts only; totalRuntimeSec is the sum of the parts you submit.'].join('\n') }),
  };
}

// ---- what would need re-rendering (no rendering here) ----
export function rerenderList(priorSc, nextSc, changedSdShots = []) {
  if (!priorSc || !nextSc) return { parts: [], continuityFollowUps: [] };
  const parts = [];
  for (const seg of nextSc.segments) {
    const old = priorSc.segments.find((s) => s.segmentId === seg.segmentId);
    if (same(old, seg)) continue;
    const ob = new Map(shotBlocks(old?.tenBlocks?.block5_shots ?? '').map((b) => [b.n, b.text.trim()]));
    const nb = shotBlocks(seg.tenBlocks?.block5_shots ?? '');
    const changedPromptShots = [...new Set([...nb.filter((b) => ob.get(b.n) !== b.text.trim()).map((b) => b.n),
      ...seg.shots.filter((s) => !same(old?.shots?.find((x) => x.shotNumber === s.shotNumber), s)).map((s) => s.shotNumber)])].sort((a, b) => a - b);
    parts.push({ segmentId: seg.segmentId, segmentIndex: seg.segmentIndex, reason: 'its Seedance prompt changed; Seedance renders a part as one clip',
      stageShots: changedSdShots.filter((id) => id.startsWith(`${seg.segmentId}.`)), changedPromptShots,
      changedBlocks: BLOCK_KEYS.filter((k) => old?.tenBlocks?.[k] !== seg.tenBlocks?.[k]) });
  }
  const re = new Set(parts.map((p) => p.segmentIndex));
  const continuityFollowUps = nextSc.segments.filter((s) => s.extendsFrom && re.has(s.extendsFrom) && !re.has(s.segmentIndex))
    .map((s) => ({ segmentId: s.segmentId, extendsFrom: s.extendsFrom, reason: 'extends from the last frame of a re-rendered part; re-render if that last frame changes' }));
  return { parts, continuityFollowUps };
}

export const PatchAnnotation = Annotation.Root({ ...PipelineAnnotation.spec, patch: Annotation({ reducer: (a = {}, b = {}) => ({ ...a, ...b }), default: () => ({}) }) });

/**
 * Build the patch graph. prior: { storyDirector, characterArchitect, locationScout, seedanceCompiler } outputs of the
 * prior run; target: a target id (string) or parseTarget() result; note: the user's words.
 */
/**
 * Prior outputs in their parsed (contract) form, so every comparison is like for like (the parsers fill defaults and
 * drop nulls on optional fields). Throws PATCH_PRIOR_INVALID when a prior output no longer matches its contract.
 */
export function normalizePrior(prior = {}) {
  const parsers = { storyDirector: parseStagePlay, characterArchitect: parseCharacterSheets, locationScout: parseLocationPlates, seedanceCompiler: parseSeedancePrompts };
  const out = {};
  for (const [k, parse] of Object.entries(parsers)) {
    if (prior[k] === undefined || prior[k] === null) continue;
    try { out[k] = parse(prior[k]); } catch (e) {
      throw Object.assign(new Error(`PATCH_PRIOR_INVALID: the prior ${k} output does not match the current contract, so it cannot be patched (do a full run):\n${e.message}`), { code: 'PATCH_PRIOR_INVALID' });
    }
  }
  return out;
}

export function buildPatchGraph({ prior: rawPrior, target, note, animaticApproved = false, invoke, deepAgent = {}, maxAttempts = MAX_ATTEMPTS, reflectionRounds, autoApprove, onEvent, runTag, liveness, timeouts } = {}) {
  if (!rawPrior?.storyDirector) throw new Error('buildPatchGraph: the prior run has no Story Director output');
  const prior = normalizePrior(rawPrior);
  if (!note || !String(note).trim()) throw new Error('buildPatchGraph: a note saying what is wrong is required');
  const t = typeof target === 'string' ? parseTarget(target, prior.storyDirector) : target;
  if (invoke === undefined) invoke = deepAgentInvoke(deepAgent);
  const specs = {
    'story-director': storyDirectorPatchSpec({ prior: prior.storyDirector, target: t, note, animaticApproved, rounds: patchReflectionRounds(reflectionRounds) }),
    'character-architect': characterArchitectPatchSpec({ priorCa: prior.characterArchitect }),
    'location-scout': locationScoutPatchSpec(),
    'seedance-compiler': seedanceCompilerPatchSpec({ priorSc: prior.seedanceCompiler, note }),
  };
  const runStop = new AbortController(); // a fatal provider error in any node stops the whole patch run
  const node = (a) => makeAgentNode(a, invoke, { maxAttempts, specs, onEvent, runTag, liveness, timeouts, runStop });
  const impact = async (s) => {
    const im = computeImpact(prior.storyDirector, s.storyDirector);
    const ls = resyncLocationScenes(s.locationScout?.output, s);
    const resynced = !same(ls, s.locationScout?.output);
    const skipped = !prior.seedanceCompiler && im.scParts.length ? 'the prior run has no Seedance Compiler output, so no part is compiled' : null;
    const upd = { patch: { target: t.id, note, impact: { ...im, locationScenesResynced: resynced, ...(skipped ? { seedanceSkipped: skipped } : {}) } } };
    if (resynced) upd.locationScout = { output: ls };
    if (resynced && !im.newLocations.length && !(im.changedLocations ?? []).length) { // no model call: the re-synced plates must still pass the plate gate
      const r = validateLocationPlates(ls, selectLocationScoutInput(s));
      if (!r.isValid) return { ...upd, status: 'failed', gateIssues: { 'location-scout': r.issues },
        escalations: [{ agent: 'location-scout', reason: 'the existing location plates no longer match the patched stage play', attempts: 0, issues: r.issues }] };
    }
    return upd;
  };
  const afterImpact = (s) => {
    if (halted(s)) return 'finish';
    const im = s.patch.impact, next = [];
    if (im.newCast.length) next.push('character-architect');
    if (im.newLocations.length || (im.changedLocations ?? []).length) next.push('location-scout');
    return next.length ? next : 'join';
  };
  const afterApproval = (s) => (halted(s) || !prior.seedanceCompiler || !s.patch.impact.scParts.length ? 'finish' : 'seedance-compiler');
  const finish = async (s) => {
    const sc = s.seedanceCompiler?.output;
    const pending = halted(s) ? s.patch.impact?.scParts ?? [] : [];
    return { ...(halted(s) ? {} : { status: 'done' }), patch: { rerender: { ...rerenderList(prior.seedanceCompiler, sc, s.patch.impact?.changedShots ?? []), ...(pending.length ? { notCompiledYet: pending } : {}) } } };
  };
  const g = new StateGraph(PatchAnnotation)
    .addNode('story-director', node('story-director'))
    .addNode('impact', impact)
    .addNode('character-architect', node('character-architect'))
    .addNode('location-scout', node('location-scout'))
    .addNode('join', async () => ({}))
    .addNode('asset-approval', makeApprovalNode({ autoApprove }))
    .addNode('seedance-compiler', node('seedance-compiler'))
    .addNode('finish', finish)
    .addEdge(START, 'story-director')
    .addConditionalEdges('story-director', (s) => (halted(s) ? 'finish' : 'impact'), ['impact', 'finish'])
    .addConditionalEdges('impact', afterImpact, ['character-architect', 'location-scout', 'join', 'finish'])
    .addEdge('character-architect', 'join')
    .addEdge('location-scout', 'join')
    .addConditionalEdges('join', (s) => (halted(s) ? 'finish' : 'asset-approval'), ['asset-approval', 'finish'])
    .addConditionalEdges('asset-approval', afterApproval, ['seedance-compiler', 'finish'])
    .addEdge('seedance-compiler', 'finish')
    .addEdge('finish', END);
  return g.compile();
}
