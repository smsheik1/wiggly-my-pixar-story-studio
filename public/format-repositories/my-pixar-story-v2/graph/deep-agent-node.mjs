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
import { tool } from 'langchain';
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
export function makeSubmitTool(agent, submissions) {
  const schema = OUTPUT_SCHEMAS[agent];
  // Seedance Compiler: compiledPrompt is assembled in code from tenBlocks, so the tool takes the blocks only.
  const toolSchema = agent === 'seedance-compiler' ? SeedanceSubmitSchema : schema;
  const prep = agent === 'seedance-compiler' ? withAssembledPrompts : (x) => x;
  return tool(async (args) => { const v = schema.parse(prep(args)); submissions.push(v); return JSON.stringify({ submitted: true }); }, {
    name: `submit_${agent.replaceAll('-', '_')}`,
    description: `Submit the final ${agent} output. Arguments must match the JSON contract in your SKILL.md exactly.`,
    schema: toolSchema, returnDirect: true,
  });
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
export function deepAgentInvoke({ createModel = openRouterModel, runsRoot = RUNS_ROOT, runId = randomUUID(), assetFiles = {}, recursionLimit = 60 } = {}) {
  return async ({ agent, config, input, attempt = 1, retryNotes = '', state = {}, signal }) => {
    const { root } = await prepareRunWorkspace({ runsRoot, runId: `${runId}/attempt-${attempt}`, agent, input, approvedAssets: state.approvedAssets ?? {}, assetFiles });
    const submissions = [];
    const model = await createModel(config, agent);
    const agentRun = workspaceAgent(model, root, `openai:${config.model}`, `wiggly-v2-${agent}`, [makeSubmitTool(agent, submissions)], systemPromptFor(agent, retryNotes));
    const res = await agentRun.invoke({ messages: [{ role: 'user', content: `Produce the ${agent} output for this run.` }] }, { recursionLimit, ...(signal ? { signal } : {}), runName: `${agent} deep agent`, tags: [`agent:${agent}`, `attempt:${attempt}`] });
    if (!submissions.length) {
      // An invalid submit_<agent> call fails schema validation; returnDirect ends the run with the tool error,
      // which the graph feeds into the next attempt's retry notes.
      const last = res?.messages?.at(-1);
      const txt = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
      if (last?.type === 'tool' && /Error invoking tool 'submit_/.test(txt))
      {
        // Drop the echoed kwargs (the whole submission) and keep the validation error.
        const k = txt.search(/\b(?:with error|because|Received tool input did not match)/);
        const reason = (k >= 0 ? txt.slice(k) : txt.slice(-1500)).slice(0, 2000);
        throw new Error(`${agent}: submit rejected by the output schema: ${reason}`);
      }
      throw new Error(`${agent}: the deep agent finished without calling submit`);
    }
    return submissions.at(-1);
  };
}
