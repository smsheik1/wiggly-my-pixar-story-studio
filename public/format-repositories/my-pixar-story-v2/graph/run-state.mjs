// Polling snapshot of a v2 run. Written on every status change so wiggly_get_film can read outputs/state.json.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function runSnapshot(state = {}, extra = {}) {
  return {
    ...state,
    status: state.status ?? 'running',
    placeholderAssets: extra.placeholderAssets ?? false,
    approvedAssets: state.approvedAssets,
    assetFiles: state.assetFiles,
    pendingApproval: state.pendingApproval ?? [],
    ...(state.creditItemId ? { creditItemId: state.creditItemId } : {}),
    ...(state.credits ? { credits: state.credits } : {}),
    retryCounts: state.retryCounts ?? {},
    escalations: state.escalations ?? [],
    validationErrors: state.validationErrors ?? [],
  };
}

export async function writeRunState(file, state, extra) {
  await mkdir(dirname(file), { recursive: true });
  const snapshot = runSnapshot(state, extra);
  await writeFile(file, JSON.stringify(snapshot, null, 2));
  return snapshot;
}

function interruptStatus(value = {}) {
  if (value.kind === 'credits') return { status: 'awaiting-credits', pendingApproval: [], creditItemId: value.itemId, credits: value.credits };
  if (value.kind === 'production-approval') return { status: 'awaiting-production', pendingApproval: ['production'] };
  if (value.kind === 'animatic-approval') return { status: 'awaiting-approval', pendingApproval: ['animatic'] };
  return { status: 'awaiting-approval', pendingApproval: value.missing ?? [value.kind ?? 'gate'] };
}

export async function invokePersisting(graph, input, config, stateFile, extra = {}) {
  let streamed = graph.stream(input, { ...config, streamMode: 'values' });
  if (streamed && typeof streamed.then === 'function') streamed = await streamed;
  let last;
  for await (const chunk of streamed) {
    last = chunk;
    await writeRunState(stateFile, chunk, extra);
  }
  if (typeof graph.getState === 'function') {
    try {
      const snap = await graph.getState(config);
      const interrupts = (snap?.tasks ?? []).flatMap((task) => task.interrupts ?? []);
      if (interrupts.length) {
        last = { ...(snap.values ?? last ?? {}), ...interruptStatus(interrupts[0].value) };
        await writeRunState(stateFile, last, extra);
      }
    } catch (error) {
      if (error?.lc_error_code !== 'MISSING_CHECKPOINTER') throw error;
    }
  }
  if (!last) throw new Error('The graph finished without a state.');
  return last;
}
