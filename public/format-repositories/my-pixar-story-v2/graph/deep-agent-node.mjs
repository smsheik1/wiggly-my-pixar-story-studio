// v2 Deep Agent runner: each graph node runs its agent as a deepagents Deep Agent, mirroring v1's
// scripts/studio-spike/harness.ts workspaceAgent() (read-only copy of the pattern; v1 is untouched).
//   runs/<runId>/<agent>/drafts       writable scratch (the only writable mount)
//   runs/<runId>/<agent>/references   read-only: input.json (selector slice) + approved-assets.json + assets/
//   runs/<runId>/<agent>/versions     read-only: prior approved versions (empty by default)
//   runs/<runId>/<agent>/skills/<agent>/SKILL.md   the agent's role.md
// The agent finishes by calling submit_<agent>, whose Zod schema is the agent's schema.mjs output; returnDirect ends the run.
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
import { loadSkill } from '../config/models.mjs';

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
export function workspaceAgent(model, root, profileKey, name, tools, systemPrompt) {
  registerHarnessProfile(profileKey, { excludedTools: ['task', 'execute'], generalPurposeSubagent: { enabled: false } });
  const mount = (dir) => new FilesystemBackend({ rootDir: join(root, dir), virtualMode: true });
  const backend = new CompositeBackend(new FilesystemBackend({ rootDir: root, virtualMode: true }), {
    '/drafts/': mount('drafts'), '/references/': mount('references'), '/versions/': mount('versions'), '/skills/': mount('skills'),
  });
  return createDeepAgent({ model, backend, name, skills: ['/skills/'], tools, permissions: PERMISSIONS, systemPrompt });
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
export function makeSubmitTool(agent, submissions, { onSubmitted = () => {}, onGiveUp = () => {}, maxInvalid = 3 } = {}) {
  const schema = OUTPUT_SCHEMAS[agent];
  // Seedance Compiler: compiledPrompt is assembled in code from tenBlocks, so the tool takes the blocks only.
  const toolZod = agent === 'seedance-compiler' ? SeedanceSubmitSchema : schema;
  const prep = agent === 'seedance-compiler' ? withAssembledPrompts : (x) => x;
  const js = toJsonSchema(toolZod);
  let invalid = 0;
  const t = new CodeValidatedTool({ func: async (args) => {
    const r = schema.safeParse(prep(dropDisallowedNulls(args, js)));
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
export async function openRouterModel(config, _agent, { apiKey = process.env.OPENROUTER_API_KEY } = {}) {
  const { ChatOpenAI } = await import('@langchain/openai');
  if (!apiKey) throw new Error('openRouterModel: OPENROUTER_API_KEY is not set');
  return new ChatOpenAI({ model: config.model, apiKey, maxTokens: config.maxTokens,
    streaming: true, configuration: { baseURL: 'https://openrouter.ai/api/v1' }, modelKwargs: { reasoning: { effort: config.effort }, include_reasoning: true } });
}

// ---- Reflection: the agent critiques its own draft, then rewrites it (config.reflectionRounds rounds) ----
/** Symbol under which deepAgentInvoke attaches the reflection log to its output (never serialized, never parsed). */
export const REFLECTION = Symbol.for('wiggly.v2.reflection');
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
    'Traceability: for every spoken or narrated line, can you point to the answer it comes from? Quote each line that cannot be traced, and each invented fact (people, objects, events, dates, ages, places, motives).',
    'Nothing crammed: details squeezed in from a different moment of the answers, separate thoughts merged into one punchy line, or a family sentence compressed into a slogan to fit a short shot (lengthen or split the shot instead).',
    'Abstract claims: each piece of advice or wisdom in the finale should play over a shot where someone does something that shows it.',
    'Every other rule in your SKILL.md (including its do-not-write list): quote the line or field that breaks one.',
  ],
};

/** Messages for one critique call: the agent reviews its own draft against its rules, the input and (if any) the gate. */
export function critiqueMessages({ agent, skill, input, draft, round, rounds, gateIssues = [] }) {
  const focus = REFLECTION_FOCUS[agent] ?? REFLECTION_FOCUS.default;
  const gate = gateIssues.filter((i) => i.severity === 'error');
  return [
    { role: 'system', content: `You are the Wiggly v2 ${agent}, reviewing your own draft before it ships (review round ${round} of ${rounds}). Be a strict, specific editor. You do not rewrite the draft here; you list what must change.\n\nYour rules (SKILL.md):\n\n${skill}` },
    { role: 'user', content: [
      'The input for this run (/references/input.json):', '```json', JSON.stringify(input ?? {}), '```',
      'Your current draft:', '```json', JSON.stringify(draft), '```',
      gate.length ? `The deterministic gate currently fails this draft; the rewrite must fix these:\n${gate.map((i) => `- ${i.code}${i.path ? ` (${i.path})` : ''}: ${i.message}`).join('\n')}` : 'The deterministic gate currently passes this draft; the rewrite must keep it passing.',
      'Check the draft for:', ...focus.map((f, i) => `${i + 1}. ${f}`),
      'Reply in plain text: a numbered list of concrete problems, most important first. For each one give where it is (part/shot or field), the exact quote, why it is a problem, and the exact fix. Only list real problems; say what already works in one line at the end. Finish with one line: VERDICT: REVISE or VERDICT: SHIP.',
    ].join('\n') },
  ];
}
/** User message for a rewrite run: the draft plus the agent's own critique. */
export const revisionMessage = ({ agent, draft, critique, round, rounds }) => [
  `Revise your ${agent} draft (revision round ${round} of ${rounds}). Below are your current draft and your own critique of it.`,
  'Fix every real problem the critique lists. Keep everything that already works. Do not add anything the input does not support. The result must still follow every rule in your SKILL.md and pass the gate.',
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
 */
export function deepAgentInvoke({ createModel = openRouterModel, runsRoot = RUNS_ROOT, runId = randomUUID(), assetFiles = {}, recursionLimit = 60, maxInvalidSubmits = 3, reflectionRounds } = {}) {
  return async ({ agent, config, input, attempt = 1, retryNotes = '', state = {}, signal, gate }) => {
    const photoFiles = photoFilesFor(agent, input, state);
    const { root } = await prepareRunWorkspace({ runsRoot, runId: `${runId}/attempt-${attempt}`, agent, input, approvedAssets: state.approvedAssets ?? {}, assetFiles, photoFiles });
    const model = await createModel(config, agent);
    const sysPrompt = systemPromptFor(agent, retryNotes, { photos: Object.keys(photoFiles).length > 0 });
    /** One Deep Agent run that ends in submit_<agent>; returns the submitted (schema-valid) object or throws. */
    const runOnce = async (content, runName, extraTags = []) => {
      const submissions = [];
      const done = new AbortController(); // ends the agent loop on a valid submit (or give-up)
      let giveUp = null;
      const submit = makeSubmitTool(agent, submissions, { maxInvalid: maxInvalidSubmits,
        onSubmitted: () => done.abort(new Error('submitted')), onGiveUp: (e) => { giveUp = e; done.abort(e); } });
      const agentRun = workspaceAgent(model, root, `openai:${config.model}`, `wiggly-v2-${agent}`, [submit], sysPrompt);
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

    let out = await runOnce(`Produce the ${agent} output for this run.`, `${agent} deep agent`);
    const rounds = reflectionRoundsFor(config, typeof reflectionRounds === 'object' && reflectionRounds ? reflectionRounds[agent] : reflectionRounds);
    if (!rounds) return out;

    const dir = join(root, 'reflection');
    await mkdir(dir, { recursive: true });
    const rel = (f) => relative(runsRoot, join(dir, f));
    await writeFile(join(dir, 'draft-0.json'), JSON.stringify(out, null, 2));
    const skill = loadSkill(agent);
    const log = [];
    for (let round = 1; round <= rounds; round++) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      let gateIssues = [];
      try { gateIssues = gate ? (gate(out)?.issues ?? []) : []; } catch { gateIssues = []; }
      const meta = { runName: `${agent} reflection round ${round} critique`, tags: [`agent:${agent}`, `attempt:${attempt}`, `reflection:${round}`], metadata: { agent, attempt, reflectionRound: round }, signal };
      const critique = replyText(await model.invoke(critiqueMessages({ agent, skill, input, draft: out, round, rounds, gateIssues }), meta)).trim();
      await writeFile(join(dir, `round-${round}-critique.md`), critique + '\n');
      const entry = { round, critique, critiqueFile: rel(`round-${round}-critique.md`), gateErrorsBefore: gateIssues.filter((i) => i.severity === 'error').length };
      try {
        const revised = await runOnce(revisionMessage({ agent, draft: out, critique, round, rounds }), `${agent} reflection round ${round} rewrite`, [`reflection:${round}`]);
        entry.changed = JSON.stringify(revised) !== JSON.stringify(out);
        out = revised;
        await writeFile(join(dir, `draft-${round}.json`), JSON.stringify(out, null, 2));
        entry.draftFile = rel(`draft-${round}.json`);
      } catch (e) {
        if (signal?.aborted) throw signal.reason ?? e;
        // A failed rewrite keeps the previous valid draft; the gate still checks it and the node's retries still apply.
        entry.changed = false; entry.revisionError = String(e?.message ?? e).slice(0, 2000);
      }
      log.push(entry);
    }
    await writeFile(join(dir, 'reflection.json'), JSON.stringify({ agent, attempt, rounds, log }, null, 2));
    Object.defineProperty(out, REFLECTION, { value: { rounds, log }, enumerable: false, configurable: true });
    return out;
  };
}
