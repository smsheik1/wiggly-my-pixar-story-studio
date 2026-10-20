// LangSmith tracing for v2 rehearsals (mirrors v1 tracing.ts: Client + LangChainTracer, key redaction).
import { randomUUID } from 'node:crypto';

export const V2_PROJECT = 'wiggly-v2';
export const redact = (v) => {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, c]) => [k, /^(apiKey|api_key|authorization|x-api-key)$/i.test(k) ? '[REDACTED]' : redact(c)]));
  if (typeof v === 'string' && /WIGGLY_VIDEO_URL/.test(v)) return '[REDACTED]';
  return v;
};

/** Returns { callbacks, rootRunId, url(), flush() } or null when no LangSmith key. One root run per graph run. */
export async function makeTracing(secrets, { projectName = secrets.LANGSMITH_PROJECT || V2_PROJECT } = {}) {
  if (!secrets.LANGSMITH_API_KEY) return null;
  const { Client } = await import('langsmith');
  const { LangChainTracer } = await import('@langchain/core/tracers/tracer_langchain');
  const client = new Client({ apiKey: secrets.LANGSMITH_API_KEY, ...(secrets.LANGSMITH_ENDPOINT ? { apiUrl: secrets.LANGSMITH_ENDPOINT } : {}),
    hideInputs: redact, hideOutputs: redact, hideMetadata: redact, callerOptions: { maxRetries: 2 } });
  const tracer = new LangChainTracer({ client, projectName });
  const rootRunId = randomUUID();
  return {
    projectName, rootRunId, callbacks: [tracer],
    flush: () => client.awaitPendingTraceBatches?.(),
    url: async () => { try { return await client.getRunUrl({ runId: rootRunId, projectOpts: { projectName } }); } catch { return `https://smith.langchain.com/ (project ${projectName}, run ${rootRunId})`; } },
  };
}
