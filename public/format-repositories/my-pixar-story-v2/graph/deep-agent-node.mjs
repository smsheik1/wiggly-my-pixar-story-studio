// v2 Deep Agent runner: each graph node runs its agent as a deepagents Deep Agent, mirroring v1's
// scripts/studio-spike/harness.ts workspaceAgent() (read-only copy of the pattern; v1 is untouched).
//   runs/<runId>/<agent>/drafts       writable scratch (the only writable mount)
//   runs/<runId>/<agent>/references   read-only: input.json (selector slice) + approved-assets.json + assets/
//   runs/<runId>/<agent>/versions     read-only: prior approved versions (empty by default)
//   runs/<runId>/<agent>/skills/<agent>/SKILL.md   the agent's role.md
// The agent finishes by calling submit_<agent>, whose Zod schema is the agent's schema.mjs output; returnDirect ends the run.
import { isFatalProviderError, isStreamDrop, withCallRetry, CALL_RETRIES } from './provider-errors.mjs';
import { createMiddleware } from 'langchain';
import { noteStreamActivity } from './liveness.mjs';
import { thinkingTap } from './thinking-tap.mjs';
import { cutQuotaNote, judgeRewrite, runtimeOf } from './length-guard.mjs';
export { cutQuotaNote, judgeRewrite, runtimeOf };
import { parseFixShots, enforceScope, formatScopedRevisionInstructions } from './scoped-rewrite.mjs';
export { parseFixShots, enforceScope };
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDeepAgent, FilesystemBackend, CompositeBackend, registerHarnessProfile } from 'deepagents';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { StoryDirectorOutputSchema } from '../crew/story-director/schema.mjs';
import { CharacterArchitectOutputSchema } from '../crew/character-architect/schema.mjs';
import { LocationScoutOutputSchema } from '../crew/location-scout/schema.mjs';
import { SeedanceCompilerOutputSchema, SeedanceSubmitSchema, withAssembledPrompts } from '../crew/seedance-compiler/schema.mjs';
import { loadSkill, loadReview, outputCap } from '../config/models.mjs';
import { runColdRead } from './cold-read.mjs';
import { bestOfEnabled, runBestOf } from './best-of.mjs';
import { storyBeatsEnabled, runStoryBeats, shotsTask } from './story-beats.mjs';

export const RUNS_ROOT = fileURLToPath(new URL('../runs/', import.meta.url));
export const OUTPUT_SCHEMAS = {
  'story-director': StoryDirectorOutputSchema,
  'character-architect': CharacterArchitectOutputSchema,
  'location-scout': LocationScoutOutputSchema,
  'seedance-compiler': SeedanceCompilerOutputSchema,
};
export const PERMISSIONS = [
  { operations: ['read'], paths: ['/drafts/**', '/references/**', '/versions/**', '/skills/**'], mode: 'allow' },
  { operations: ['read'], paths: ['/**'], mode: 'deny' },
  { operations: ['write'], paths: ['/drafts/**'], mode: 'allow' },
  { operations: ['write'], paths: ['/**'], mode: 'deny' },
];
const SAFE = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');
const URLISH = /^(?:[a-z]+:\/\/|\/|~)/i;

/** Virtual path inside /references for an approved asset key. Never a URL. */
export const assetPath = (assetKey, ext = '.json') => `/references/assets/${SAFE(assetKey)}${ext}`;

/**
 * Prepare runs/<runId>/<agent>/. approvedAssets: { '@Image N'|'@Loc N': assetKey }.
 * assetFiles (optional): { assetKey: absolute local file } copied into references/assets (local only; runs/ is gitignored).
 */
export async function prepareRunWorkspace({ runsRoot = RUNS_ROOT, runId, agent, input, approvedAssets = {}, assetFiles = {}, photoFiles = {} }) {
  const root = join(runsRoot, SAFE(runId), SAFE(agent));
  for (const d of ['drafts', 'references/assets', 'versions', `skills/${agent}`]) await mkdir(join(root, d), { recursive: true });
  await writeFile(join(root, `skills/${agent}/SKILL.md`), loadSkill(agent));
  await writeFile(join(root, 'references/input.json'), JSON.stringify(input ?? {}, null, 2));
  const manifest = [];
  for (const [tag, assetKey] of Object.entries(approvedAssets)) {
    if (URLISH.test(assetKey)) throw new Error(`prepareRunWorkspace: asset key for ${tag} must be a local asset key, not a URL or path`);
    const src = assetFiles[assetKey];
    let path = assetPath(assetKey);
    if (src) {
      if (!existsSync(src)) throw new Error(`prepareRunWorkspace: approved asset file missing for ${assetKey}`);
      path = assetPath(assetKey, extname(src).toLowerCase() || '.bin');
      await copyFile(src, join(root, path.replace(/^\//, '')));
    } else {
      await writeFile(join(root, path.replace(/^\//, '')), JSON.stringify({ tag, assetKey, status: 'approved' }, null, 2));
    }
    manifest.push({ tag, assetKey, path });
  }
  await writeFile(join(root, 'references/approved-assets.json'), JSON.stringify(manifest, null, 2));
  // WIGGLY: reference photos (read-only mount; runs/ is gitignored, photos are never committed).
  for (const [virtual, src] of Object.entries(photoFiles)) {
    if (!/^\/references\/photos\/[\w.-]+$/.test(virtual)) throw new Error(`prepareRunWorkspace: bad photo path ${virtual}`);
    if (!existsSync(src)) throw new Error(`prepareRunWorkspace: reference photo missing for ${virtual}`);
    await mkdir(join(root, 'references/photos'), { recursive: true });
    await copyFile(src, join(root, virtual.slice(1)));
  }
  return { root, manifest };
}

/** Deep Agent with v1's backend/permission pattern. */
// ---- Single-call retry for dropped streams (r5-dry4) ----
export { CALL_RETRIES, withCallRetry };
/** Agent middleware: the same single-call retry around every model request of a Deep Agent run. */
export const streamDropRetryMiddleware = (opts = {}) => createMiddleware({
  name: 'StreamDropRetryMiddleware',
  wrapModelCall: (request, handler) => withCallRetry(() => handler(request), opts),
});
const logRetry = (agent) => (e, n) => console.log(`[retry] ${agent}: model call dropped (${String(e?.message ?? e).slice(0, 120)}); retrying that call (${n}/${CALL_RETRIES})`);

export function workspaceAgent(model, root, profileKey, name, tools, systemPrompt, { retry = {} } = {}) {
  registerHarnessProfile(profileKey, { excludedTools: ['task', 'execute'], generalPurposeSubagent: { enabled: false } });
  const mount = (dir) => new FilesystemBackend({ rootDir: join(root, dir), virtualMode: true });
  const backend = new CompositeBackend(new FilesystemBackend({ rootDir: root, virtualMode: true }), {
    '/drafts/': mount('drafts'), '/references/': mount('references'), '/versions/': mount('versions'), '/skills/': mount('skills'),
  });
  return createDeepAgent({ model, backend, name, skills: ['/skills/'], tools, permissions: PERMISSIONS, systemPrompt, middleware: [streamDropRetryMiddleware(retry)] });
}

/** submit_<agent>: args are validated by the agent's output schema; returnDirect ends the agent run. */
const acceptsNull = (js) => !!js && (js.type === 'null' || (Array.isArray(js.type) && js.type.includes('null')) || (js.anyOf ?? js.oneOf ?? []).some(acceptsNull));
const nonNull = (js) => (js?.anyOf ?? js?.oneOf)?.find((b) => b.type !== 'null') ?? js;
/** Advertised tool schema: optional (non-required) properties also accept null, since models send null for "absent". */
export function nullTolerant(js) {
  if (!js || typeof js !== 'object') return js;
  if (Array.isArray(js)) return js.map(nullTolerant);
  const out = Object.fromEntries(Object.entries(js).map(([k, v]) => [k, k === 'properties' ? v : nullTolerant(v)]));
  if (js.properties) {
    const req = new Set(js.required ?? []);
    out.properties = Object.fromEntries(Object.entries(js.properties).map(([k, v]) => {
      const t = nullTolerant(v);
      return [k, req.has(k) || acceptsNull(v) ? t : { anyOf: [t, { type: 'null' }], ...(v.description ? { description: v.description } : {}) }];
    }));
  }
  return out;
}
/** Drop nulls the contract does not allow (null on an optional field means "absent"); keep nulls on nullable fields. */
/**
 * r5-dry2: the Seedance Compiler once sent `segments` as a JSON string instead of an array. A top-level field whose
 * schema wants an array/object but arrives as a string holding valid JSON of that type is parsed; anything else is
 * left as is for the schema to reject with its normal message.
 */
export function parseStringifiedFields(args, js) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || !js?.properties) return args;
  const wants = (p) => { const ts = [p?.type, ...(p?.anyOf ?? []).map((x) => x?.type)].flat().filter(Boolean); return { array: ts.includes('array'), object: ts.includes('object') }; };
  let out = args;
  for (const [k, p] of Object.entries(js.properties)) {
    const v = args[k];
    if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) continue;
    const w = wants(p);
    if (!w.array && !w.object) continue;
    let parsed;
    try { parsed = JSON.parse(v); } catch { continue; }
    if ((Array.isArray(parsed) && w.array) || (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && w.object)) out = { ...out, [k]: parsed };
  }
  return out;
}
export function dropDisallowedNulls(v, js) {
  js = nonNull(js);
  if (Array.isArray(v)) return v.map((x) => dropDisallowedNulls(x, js?.items));
  if (v && typeof v === 'object') {
    const props = js?.properties ?? {};
    return Object.fromEntries(Object.entries(v).filter(([k, x]) => x !== null || acceptsNull(props[k])).map(([k, x]) => [k, dropDisallowedNulls(x, props[k])]));
  }
  return v;
}
export const zodIssues = (issues) => issues.map((i) => { const path = (i.path ?? []).join('.'); return { severity: 'error', code: 'SCHEMA_REJECTED', path, message: path ? `${path}: ${i.message}` : i.message }; });
const issueText = (issues, max = 40) => issues.slice(0, max).map((i) => `- ${i.message}`).join('\n') + (issues.length > max ? `\n- …and ${issues.length - max} more` : '');

export class SubmitRejectedError extends Error {
  constructor(agent, issues) { super(`${agent}: submit rejected by the output schema (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n${issueText(issues, 15)}`); this.issues = issues; this.code = 'SCHEMA_REJECTED'; }
}

/**
 * The wrapper's own input check only says "did not match expected schema" and never reaches our code, so the
 * agent cannot see what to fix (the r4-dry1 failure). The model still gets the full JSON schema at bind time;
 * at call time we validate in code with Zod and return exact paths/messages.
 */
class CodeValidatedTool extends DynamicStructuredTool {
  async call(arg, configArg, tags) {
    const advertised = this.schema;
    this.schema = { type: 'object' };
    try { return await super.call(arg, configArg, tags); } finally { this.schema = advertised; }
  }
}

/**
 * Typed submit tool. Validation happens in code (not by the tool wrapper) so an invalid submit returns the
 * exact Zod paths/messages to the agent, which fixes and resubmits inside the same attempt.
 * onSubmitted() ends the run on a valid submit; after maxInvalid bad submits onGiveUp(err) ends it with the issues.
 */
export function makeSubmitTool(agent, submissions, { onSubmitted = () => {}, onGiveUp = () => {}, maxInvalid = 3, schema: override } = {}) {
  // override: a run-specific validation schema (patch mode: the Seedance Compiler submits only the affected parts)
  const schema = override ?? OUTPUT_SCHEMAS[agent];
  // Seedance Compiler: compiledPrompt is assembled in code from tenBlocks, so the tool takes the blocks only.
  const toolZod = agent === 'seedance-compiler' ? SeedanceSubmitSchema : schema;
  const prep = agent === 'seedance-compiler' ? withAssembledPrompts : (x) => x;
  const js = toJsonSchema(toolZod);
  let invalid = 0;
  const t = new CodeValidatedTool({ func: async (args) => {
    const r = schema.safeParse(prep(dropDisallowedNulls(parseStringifiedFields(args, js), js)));
    if (r.success) { submissions.push(r.data); onSubmitted(r.data); return JSON.stringify({ submitted: true }); }
    const issues = zodIssues(r.error.issues);
    t.lastIssues = issues;
    if (++invalid >= maxInvalid) { onGiveUp(new SubmitRejectedError(agent, issues)); return 'Submission rejected again; stopping this attempt.'; }
    return `SUBMISSION REJECTED (${invalid}/${maxInvalid}): fix exactly these fields and call ${t.name} again with the complete corrected output. Omit optional fields you do not use (do not send null).\n${issueText(issues)}`;
  },
    name: `submit_${agent.replaceAll('-', '_')}`,
    description: `Submit the final ${agent} output. Arguments must match the JSON contract in your SKILL.md exactly. If rejected, fix the listed fields and resubmit.`,
    schema: nullTolerant(js),
  });
  return t;
}

/** Only the Character Architect receives reference photos: { virtualPath: hostPath } for photoNotes with a photoFile. */
export function photoFilesFor(agent, input, state = {}) {
  if (agent !== 'character-architect') return {};
  const refs = state.inputs?.photoReferences ?? [];
  const out = {};
  for (const n of input?.photoNotes ?? []) {
    if (!n.photoFile) continue;
    const id = n.photoFile.split('/').pop().replace(/\.[^.]+$/, '');
    const r = refs.find((x) => String(x.id).replace(/[^\w-]/g, '_') === id);
    if (r?.path) out[n.photoFile] = r.path;
  }
  return out;
}

export const systemPromptFor = (agent, retryNotes = '', { photos = false } = {}) => [
  `You are the Wiggly v2 ${agent}. Load your skill from /skills/${agent}/SKILL.md first.`,
  'Read your input slice from /references/input.json and approved references from /references/approved-assets.json.',
  'Bind references by their approved asset keys only; never write URLs or file paths into prompts.',
  photos ? 'Read-only reference photos of the real people are in /references/photos/ (see photoNotes[].photoFile in input.json). Match their likeness, skin tone, hair and face shape; never copy a photo path into a prompt.' : 'Photos are not available to you.',
  'You may write scratch notes only under /drafts/. No delegation, no media generation.',
  `Finish by calling submit_${agent.replaceAll('-', '_')} with the full JSON output.`,
  retryNotes,
].filter(Boolean).join('\n');

/** Default production model: OpenRouter via ChatOpenAI (lazy; never constructed in tests). */
/**
 * Count what the SDK hides: SSE keepalive comments (": OPENROUTER PROCESSING") and `reasoning` deltas (LangChain only
 * maps `reasoning_content`), reported to the heartbeat via noteStreamActivity. The response body passes through untouched.
 */
export function sseActivity(text) {
  let keepalives = 0, reasoning = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith(':')) keepalives++;
    else if (line.startsWith('data:') && /"reasoning(?:_details|_content)?"\s*:\s*(?:"[^"]|\[\s*\{)/.test(line)) reasoning++;
  }
  return { keepalives, reasoning };
}
export function observingFetch(agent, base = globalThis.fetch, note = noteStreamActivity) {
  return async (url, init) => {
    const res = await base(url, init);
    if (!res.body || !String(res.headers?.get?.('content-type') ?? '').includes('event-stream')) return res;
    const dec = new TextDecoder();
    const think = thinkingTap(agent);
    const tap = new TransformStream({ transform(chunk, ctl) { const t = dec.decode(chunk, { stream: true }); const a = sseActivity(t); if (a.keepalives || a.reasoning) note(agent, a); think.feed(t); ctl.enqueue(chunk); }, flush() { think.end(); } });
    return new Response(res.body.pipeThrough(tap), { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}
export async function openRouterModel(config, _agent, { apiKey = process.env.OPENROUTER_API_KEY } = {}) {
  const { ChatOpenAI } = await import('@langchain/openai');
  if (!apiKey) throw new Error('openRouterModel: OPENROUTER_API_KEY is not set');
  return new ChatOpenAI({ model: config.model, apiKey, maxTokens: outputCap(config),
    streaming: true, configuration: { baseURL: 'https://openrouter.ai/api/v1', fetch: observingFetch(_agent) }, modelKwargs: { reasoning: { effort: config.effort }, include_reasoning: true } });
}

// ---- Reflection: the agent critiques its own draft, then rewrites it (config.reflectionRounds rounds) ----
/** Symbol under which deepAgentInvoke attaches the reflection log to its output (never serialized, never parsed). */
export const REFLECTION = Symbol.for('wiggly.v2.reflection');
/** Symbol for the story-first artifacts (beats, critique, approved beats) attached to the Story Director output. */
export const STORY = Symbol.for('wiggly.v2.story');
/** Rounds of self-critique + rewrite for an agent: config.reflectionRounds (integer >= 0), default 0. */
export const reflectionRoundsFor = (config, override) => {
  const n = override ?? config?.reflectionRounds ?? 0;
  return Number.isInteger(n) && n > 0 ? n : 0;
};
/** Plain text of a chat model reply (drops reasoning blocks). */
export const replyText = (m) => (typeof m?.content === 'string' ? m.content
  : Array.isArray(m?.content) ? m.content.filter((b) => typeof b === 'string' || b?.type === 'text').map((b) => (typeof b === 'string' ? b : b.text ?? '')).join('') : String(m?.content ?? ''));

/** What the critic checks, by agent. Generic for every family; the Story Director adds the finale and answer-tracing checks. */
export const REFLECTION_FOCUS = {
  default: [
    'Every rule in your SKILL.md: quote any line or field that breaks one.',
    'Faithfulness to /references/input.json: anything invented (people, objects, events, dates, ages, places, motives) or a detail changed from what the input says.',
  ],
  'story-director': [
    'Ending coherence: does the final part build to the ONE idea in finaleThesis? Name every finale line that does not serve it, any callback that does not fit it, and whether the last line says or shows it plainly.',
    'Traceability: for every spoken or narrated line, is its source the answer whose facts it tells? Quote each line that cannot be traced, each detail borrowed from a different answer, and each invented fact (people, objects, events, dates, ages, places, motives), including in whatWeSee, which the trace table does not check. Connective lines must be few, short and fact-free. Every cast card must be a person the family names.',
    'Nothing crammed: details squeezed in from a different moment of the answers, separate thoughts merged into one punchy line, or a family sentence compressed into a slogan to fit a short shot (lengthen or split the shot instead).',
    'Abstract claims: each piece of advice or wisdom in the finale should play over a shot where someone does something that shows it.',
    'Every other rule in your SKILL.md (including its do-not-write list): quote the line or field that breaks one.',
  ],
};

/** Runtime facts for the critic's length check: delegates to cutQuotaNote. */
export const runtimeNote = cutQuotaNote;

/**
 * Messages for one critique call: the agent reviews its own draft against its rules, the input and (if any) the gate.
 * With a review rubric (crew/<agent>/REVIEW.md, loadReview) the call is an editor's pass: score each rubric item
 * PASS/FAIL with evidence, list at most 8 fixes, end on VERDICT. Without one it uses the generic focus list.
 */
export function critiqueMessages({ agent, skill, review = null, input, draft, round, rounds, gateIssues = [], trace = '', scope = '', firstRuntime = null, prevDraft = null, coldNotes = '' }) {
  const focus = REFLECTION_FOCUS[agent] ?? REFLECTION_FOCUS.default;
  const gate = gateIssues.filter((i) => i.severity === 'error');
  const warns = gateIssues.filter((i) => i.severity === 'warning');
  const rt = cutQuotaNote(input, draft, prevDraft, { firstRuntime });
  // Patch mode: the prior output is the draft's own baseline; do not send it twice.
  if (input?.patch?.currentOutput) input = { ...input, patch: { ...input.patch, currentOutput: '(the output before this patch; outside the target the draft must equal it exactly)' } };
  const system = review
    ? `You are the Wiggly v2 ${agent}, reviewing your own draft before it ships (review round ${round} of ${rounds}). In this call you are the editor, not the writer: you score and give fix instructions, you never rewrite.\n\n${review}\n\nThe writing rules the draft must follow (SKILL.md), for reference:\n\n${skill}`
    : `You are the Wiggly v2 ${agent}, reviewing your own draft before it ships (review round ${round} of ${rounds}). Be a strict, specific editor. You do not rewrite the draft here; you list what must change.\n\nYour rules (SKILL.md):\n\n${skill}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: [
      ...(scope ? [scope] : []),
      'The input for this run (/references/input.json):', '```json', JSON.stringify(input ?? {}), '```',
      'Your current draft:', '```json', JSON.stringify(draft), '```',
      gate.length ? `The deterministic gate currently fails this draft; the rewrite must fix these:\n${gate.map((i) => `- ${i.code}${i.path ? ` (${i.path})` : ''}: ${i.message}`).join('\n')}` : 'The deterministic gate currently passes this draft; the rewrite must keep it passing.',
      ...(review && warns.length ? [`Gate warnings (not blocking; check each against the rubric and list a fix only if it is a real problem):\n${warns.map((i) => `- ${i.code}${i.path ? ` (${i.path})` : ''}: ${i.message}`).join('\n')}`] : []),
      ...(rt ? [rt] : []),
      ...(coldNotes ? [`Cold viewer notes (a first-time viewer read the script without the answers; turn real issues into FIXES, ignore notes that are wrong):\n${coldNotes}`] : []),
      ...(trace ? ['Line-by-line trace of the draft against the answers (from the deterministic checker; "match" is word overlap with the cited answer):', trace] : []),
      ...(review
        ? ['Review the draft with your rubric: read it once as a viewer, then answer R1 to R9 in order, PASS or FAIL with exact evidence, then FIXES (at most 8, most important first, cuts before additions), in the rubric\'s reply format.']
        : ['Check the draft for:', ...focus.map((f, i) => `${i + 1}. ${f}`),
          'Reply in plain text: a numbered list of concrete problems, most important first. For each one give where it is (part/shot or field), the exact quote, why it is a problem, and the exact fix. Only list real problems; say what already works in one line at the end.']),
      ...(trace ? [UNTRACEABLE_ASK] : []),
      'Finish with one line: VERDICT: REVISE or VERDICT: SHIP.',
    ].join('\n') },
  ];
}
/** The critic's last VERDICT line: 'SHIP', 'REVISE', or null when it gave none. */
export function parseVerdict(critique) {
  const all = [...String(critique ?? '').matchAll(/VERDICT[*_`\s]*[:\-][*_`\s]*(SHIP|REVISE)\b/gi)];
  return all.length ? all.at(-1)[1].toUpperCase() : null;
}
/** True when the critique scores any rubric item FAIL (e.g. "R4 Cast in the scene: FAIL"). */
export const hasRubricFail = (critique) => /^\s*[*_]*R\d+\b[^\n]*:[\s*_]*FAIL\b/im.test(String(critique ?? ''));
/** Count of numbered items in the critique's FIXES list (0 when it has none). */
export function countFixes(critique) {
  const m = /^\s*[*_#]*\s*FIXES\b[^\n]*\n([\s\S]*?)(?:^\s*(?:Works|VERDICT)\b|$(?![\s\S]))/im.exec(String(critique ?? ''));
  return m ? (m[1].match(/^\s*\d+[.)]\s+\S/gm) ?? []).length : 0;
}
/** Early stop: the critic says SHIP, no rubric item failed and the gate has no errors, so no rewrite runs. */
export const shipsAsIs = (critique, gateIssues = []) => parseVerdict(critique) === 'SHIP' && !hasRubricFail(critique) && !gateIssues.some((i) => i.severity === 'error');
/** Asked of the critic when an answer trace is available: its own traceability findings as data. */
export const UNTRACEABLE_ASK = 'Then give your traceability findings as data in one fenced json block: ```json {"untraceable": [{"where": "<part.shot>", "line": "<exact line>", "why": "<invented | borrowed from another answer | wrong source | changed detail>", "fix": "<answer id to cite, or cut>"}]} ``` (an empty list if every line traces).';
/** The critic's {"untraceable": [...]} block, or null if it gave none or it does not parse. */
export function parseUntraceable(critique) {
  for (const m of String(critique ?? '').matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    try { const v = JSON.parse(m[1]); if (v && Array.isArray(v.untraceable)) return v.untraceable.filter((x) => x && typeof x === 'object'); } catch { /* not this block */ }
  }
  return null;
}
/** User message for a rewrite run: the draft plus the agent's own critique. */
export const revisionMessage = ({ agent, draft, critique, round, rounds, scope = '', allowedShots }) => [
  `Revise your ${agent} draft (revision round ${round} of ${rounds}). Below are your current draft and your own critique of it.`,
  ...(scope ? [scope] : []),
  ...(allowedShots && (allowedShots.size > 0 || (Array.isArray(allowedShots) && allowedShots.length > 0))
    ? [formatScopedRevisionInstructions(allowedShots)]
    : []),
  'Apply only the fixes your critique lists (its FIXES list, or its numbered problems), most important first. Change nothing else: every line, shot and field the critique does not name stays exactly as it is. Do not add anything the input does not support.',
  'Do not make the output longer (more parts or shots, a higher shapeBar.totalRuntimeSec) unless a listed fix requires it; when a fix can be a cut, cut. The result must still follow every rule in your SKILL.md and pass the gate.',
  `Finish by calling submit_${agent.replaceAll('-', '_')} with the complete revised JSON (the whole output, not a diff).`,
  'Your critique:', critique,
  'Your current draft:', '```json', JSON.stringify(draft), '```',
].join('\n');

/**
 * Build the graph's invoke({ agent, config, input, attempt, retryNotes, state, gate }) as a Deep Agent run.
 * createModel(config, agent) -> BaseChatModel (inject a fake in tests). Returns the submitted object.
 * With config.reflectionRounds = N > 0 (or the reflectionRounds override, a number or { agent: number }), the first
 * draft is followed by N rounds of critique (a plain model call) + rewrite (a Deep Agent run that resubmits).
 * Critiques and every draft are saved under runs/<runId>/attempt-N/<agent>/reflection/, and the log is attached to
 * the returned object under REFLECTION. N = 0 is exactly the single-draft behaviour.
 * storyBeats (boolean, optional) overrides config.storyBeats (graph/story-beats.mjs: beats + critique calls before the shots call).
 */
export function deepAgentInvoke({ createModel = openRouterModel, runsRoot = RUNS_ROOT, runId = randomUUID(), assetFiles = {}, recursionLimit = 60, maxInvalidSubmits = 3, reflectionRounds, storyBeats, callRetry = {} } = {}) {
  // Patch mode (graph/patch.mjs) adds: task (the first user message), scope (shown to the critic and the rewrite),
  // rounds (reflection rounds for this run; overrides config and the reflectionRounds option) and submitSchema.
  return async ({ agent, config, input, attempt = 1, retryNotes = '', state = {}, signal, gate, trace, task, scope = '', rounds: reqRounds, submitSchema }) => {
    const photoFiles = photoFilesFor(agent, input, state);
    const { root } = await prepareRunWorkspace({ runsRoot, runId: `${runId}/attempt-${attempt}`, agent, input, approvedAssets: state.approvedAssets ?? {}, assetFiles, photoFiles });
    const model = await createModel(config, agent);
    const sysPrompt = systemPromptFor(agent, retryNotes, { photos: Object.keys(photoFiles).length > 0 });
    /** One Deep Agent run that ends in submit_<agent>; returns the submitted (schema-valid) object or throws. */
    const runOnce = async (content, runName, extraTags = [], workspaceRoot = root) => {
      const submissions = [];
      const done = new AbortController(); // ends the agent loop on a valid submit (or give-up)
      let giveUp = null;
      const submit = makeSubmitTool(agent, submissions, { maxInvalid: maxInvalidSubmits, ...(submitSchema ? { schema: submitSchema } : {}),
        onSubmitted: () => done.abort(new Error('submitted')), onGiveUp: (e) => { giveUp = e; done.abort(e); } });
      const agentRun = workspaceAgent(model, workspaceRoot, `openai:${config.model}`, `wiggly-v2-${agent}`, [submit], sysPrompt, { retry: { onRetry: logRetry(agent), signal, ...callRetry } });
      const sig = signal ? AbortSignal.any([signal, done.signal]) : done.signal;
      try {
        await agentRun.invoke({ messages: [{ role: 'user', content }] }, { recursionLimit, signal: sig, runName, tags: [`agent:${agent}`, `attempt:${attempt}`, ...extraTags] });
      } catch (e) {
        if (submissions.length) return submissions.at(-1);
        if (giveUp) throw giveUp;
        if (signal?.aborted) throw signal.reason ?? e;
        throw e;
      }
      if (submissions.length) return submissions.at(-1);
      if (giveUp) throw giveUp;
      if (submit.lastIssues) throw new SubmitRejectedError(agent, submit.lastIssues);
      throw new Error(`${agent}: the deep agent finished without calling submit`);
    };

    const rounds = reflectionRoundsFor(config, reqRounds ?? (typeof reflectionRounds === 'object' && reflectionRounds ? reflectionRounds[agent] : reflectionRounds));
    let out;
    let bestOf = null;
    let initialGateIssues = null;
    // Story first: calls A (beats) and B (critique + rewrite) before call C (shots). Artifacts in <attempt>/<agent>/story/.
    const story = storyBeatsEnabled(agent, storyBeats === undefined ? config : { ...config, storyBeats }, { scope, task, patch: Boolean(input?.patch) })
      ? await runStoryBeats({ agent, input, model, dir: join(root, 'story'), signal, attempt, callRetry: { onRetry: logRetry(agent), ...callRetry } }) : null;
    const shotsMsg = story ? shotsTask(agent, story.approved) : undefined;
    if (bestOfEnabled(agent, config, { scope, task, rounds })) {
      const picked = await runBestOf({
        agent, input, model, gate, signal, runsRoot, root, task: shotsMsg, runOnce,
        prepareWorkspace: prepareRunWorkspace, state, assetFiles, photoFiles,
      });
      out = picked.winnerDraft;
      bestOf = picked.bestOf;
      initialGateIssues = picked.gateIssues;
    } else {
      out = await runOnce(task ?? shotsMsg ?? `Produce the ${agent} output for this run.`, `${agent} deep agent`);
    }
    if (story) Object.defineProperty(out, STORY, { value: { files: story.files.map((f) => relative(runsRoot, join(root, 'story', f))) }, enumerable: false, configurable: true });
    if (!rounds) return out;

    const dir = join(root, 'reflection');
    await mkdir(dir, { recursive: true });
    const rel = (f) => relative(runsRoot, join(dir, f));
    await writeFile(join(dir, 'draft-0.json'), JSON.stringify(out, null, 2));
    const skill = loadSkill(agent);
    const review = loadReview(agent); // the rubric, for the critique call only (never in the writer's prompt)
    const firstRuntime = runtimeOf(out);
    let prevDraft = null;
    let gateIssues = initialGateIssues;
    if (!gateIssues) {
      try { gateIssues = gate ? (gate(out)?.issues ?? []) : []; } catch { gateIssues = []; }
    }
    const log = [];
    let stoppedEarly = false;
    for (let round = 1; round <= rounds; round++) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const cold = await runColdRead({ agent, config, draft: out, model, round, attempt, signal, dir, rel, scope });
      const meta = { runName: `${agent} reflection round ${round} critique`, tags: [`agent:${agent}`, `attempt:${attempt}`, `reflection:${round}`], metadata: { agent, attempt, reflectionRound: round }, signal };
      let tr = null;
      try { tr = trace ? trace(out) : null; } catch { tr = null; }
      const critique = replyText(await withCallRetry(() => model.invoke(critiqueMessages({ agent, skill, review, input, draft: out, round, rounds, gateIssues, trace: tr?.text ?? '', scope, firstRuntime, prevDraft, coldNotes: cold?.notes ?? '' }), meta), { onRetry: logRetry(agent), signal, ...callRetry })).trim();
      await writeFile(join(dir, `round-${round}-critique.md`), critique + '\n');
      const entry = { round, critique, critiqueFile: rel(`round-${round}-critique.md`), gateErrorsBefore: gateIssues.filter((i) => i.severity === 'error').length };
      if (cold) { entry.coldRead = cold.notes; entry.coldReadFile = cold.file; }
      if (tr?.data) { entry.trace = tr.data; entry.untraceable = parseUntraceable(critique); }
      entry.verdict = parseVerdict(critique); entry.fixes = countFixes(critique); entry.runtimeBefore = runtimeOf(out);
      if (shipsAsIs(critique, gateIssues)) {
        // Nothing fails: ship the draft as it is and skip this rewrite and every later round (saves their cost).
        entry.changed = false; entry.stoppedEarly = true; stoppedEarly = true; log.push(entry);
        break;
      }
      const isScoped = agent === 'story-director' && !input?.patch && !scope;
      const fixShots = isScoped ? parseFixShots(critique) : null;
      if (fixShots?.unscopedFixes?.length) entry.unscopedFixes = fixShots.unscopedFixes;
      const totalFixCount = (fixShots?.size ?? 0) + (fixShots?.unscopedFixes?.length ?? 0);
      if (isScoped && totalFixCount > 0 && fixShots.size === 0) { // fixes listed, none names a shot: nothing scoped to rewrite
        entry.changed = false;
        entry.skipped = 'no scoped fixes';
        entry.runtimeAfter = runtimeOf(out);
        log.push(entry);
        continue;
      }
      try {
        const revised = await runOnce(revisionMessage({ agent, draft: out, critique, round, rounds, scope, allowedShots: fixShots?.size ? fixShots : undefined }), `${agent} reflection round ${round} rewrite`, [`reflection:${round}`]);
        let nextDraft = revised;
        if (isScoped && fixShots?.size) {
          const enforced = enforceScope(out, revised, fixShots);
          if (enforced.reverted?.length) {
            entry.reverted = enforced.reverted;
            for (const id of enforced.reverted) console.log(`rewrite touched unnamed shot ${id}: reverted`);
          }
          nextDraft = enforced;
        }
        let gateIssuesAfter = [];
        try { gateIssuesAfter = gate ? (gate(nextDraft)?.issues ?? []) : []; } catch { gateIssuesAfter = []; }
        const judgment = judgeRewrite({ input, before: out, after: nextDraft, gateBefore: gateIssues, gateAfter: gateIssuesAfter });
        if (!judgment.accepted) {
          console.log(judgment.message);
          entry.changed = false;
          entry.rejected = judgment.rejected;
          entry.runtimeAfter = runtimeOf(out);
        } else {
          entry.changed = JSON.stringify(nextDraft) !== JSON.stringify(out);
          prevDraft = out;
          out = nextDraft;
          gateIssues = gateIssuesAfter;
          entry.runtimeAfter = runtimeOf(out);
          await writeFile(join(dir, `draft-${round}.json`), JSON.stringify(out, null, 2));
          entry.draftFile = rel(`draft-${round}.json`);
        }
      } catch (e) {
        if (signal?.aborted) throw signal.reason ?? e;
        if (isFatalProviderError(e)) throw e; // spent key / no credits: never swallowed as a failed rewrite
        // A failed rewrite keeps the previous valid draft; the gate still checks it and the node's retries still apply.
        entry.changed = false; entry.revisionError = String(e?.message ?? e).slice(0, 2000);
      }
      log.push(entry);
    }
    await writeFile(join(dir, 'reflection.json'), JSON.stringify({ agent, attempt, rounds, roundsRun: log.length, stoppedEarly, rubric: Boolean(review), ...(bestOf ? { bestOf } : {}), log }, null, 2));
    Object.defineProperty(out, REFLECTION, { value: { rounds, roundsRun: log.length, stoppedEarly, ...(bestOf ? { bestOf } : {}), log }, enumerable: false, configurable: true });
    return out;
  };
}
