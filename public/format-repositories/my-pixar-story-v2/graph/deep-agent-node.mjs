// v2 Deep Agent runner: each graph node runs its agent as a deepagents Deep Agent, mirroring v1's
// scripts/studio-spike/harness.ts workspaceAgent() (read-only copy of the pattern; v1 is untouched).
//   runs/<runId>/<agent>/drafts       writable scratch (the only writable mount)
//   runs/<runId>/<agent>/references   read-only: input.json (selector slice) + approved-assets.json + assets/
//   runs/<runId>/<agent>/versions     read-only: prior approved versions (empty by default)
//   runs/<runId>/<agent>/skills/<agent>/SKILL.md   the agent's role.md
// The agent finishes by calling submit_<agent>, whose Zod schema is the agent's schema.mjs output; returnDirect ends the run.
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
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
export async function prepareRunWorkspace({ runsRoot = RUNS_ROOT, runId, agent, input, approvedAssets = {}, assetFiles = {} }) {
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
export const zodIssues = (issues) => issues.map((i) => ({ severity: 'error', code: 'SCHEMA_REJECTED', path: (i.path ?? []).join('.'), message: i.message }));
const issueText = (issues, max = 40) => issues.slice(0, max).map((i) => `- ${i.path || '(root)'}: ${i.message}`).join('\n') + (issues.length > max ? `\n- …and ${issues.length - max} more` : '');

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

export const systemPromptFor = (agent, retryNotes = '') => [
  `You are the Wiggly v2 ${agent}. Load your skill from /skills/${agent}/SKILL.md first.`,
  'Read your input slice from /references/input.json and approved references from /references/approved-assets.json.',
  'Bind references by their approved asset keys only; never write URLs or file paths into prompts. Photos are never available.',
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

/**
 * Build the graph's invoke({ agent, config, input, attempt, retryNotes, state }) as a Deep Agent run.
 * createModel(config, agent) -> BaseChatModel (inject a fake in tests). Returns the submitted object.
 */
export function deepAgentInvoke({ createModel = openRouterModel, runsRoot = RUNS_ROOT, runId = randomUUID(), assetFiles = {}, recursionLimit = 60, maxInvalidSubmits = 3 } = {}) {
  return async ({ agent, config, input, attempt = 1, retryNotes = '', state = {}, signal }) => {
    const { root } = await prepareRunWorkspace({ runsRoot, runId: `${runId}/attempt-${attempt}`, agent, input, approvedAssets: state.approvedAssets ?? {}, assetFiles });
    const submissions = [];
    const done = new AbortController(); // ends the agent loop on a valid submit (or give-up)
    let giveUp = null;
    const submit = makeSubmitTool(agent, submissions, { maxInvalid: maxInvalidSubmits,
      onSubmitted: () => done.abort(new Error('submitted')), onGiveUp: (e) => { giveUp = e; done.abort(e); } });
    const model = await createModel(config, agent);
    const agentRun = workspaceAgent(model, root, `openai:${config.model}`, `wiggly-v2-${agent}`, [submit], systemPromptFor(agent, retryNotes));
    const sig = signal ? AbortSignal.any([signal, done.signal]) : done.signal;
    try {
      await agentRun.invoke({ messages: [{ role: 'user', content: `Produce the ${agent} output for this run.` }] }, { recursionLimit, signal: sig, runName: `${agent} deep agent`, tags: [`agent:${agent}`, `attempt:${attempt}`] });
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
}
