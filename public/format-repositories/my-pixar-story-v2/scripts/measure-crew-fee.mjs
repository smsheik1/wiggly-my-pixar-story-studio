// One customer-path rehearsal up to the first still. OpenRouter only. Renderers are stubs.
// Prints CREW_FEE_USD and CREW_FEE_CREDITS. Does not print secrets.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSecrets, defaultSecretsPath } from './lib/secrets.mjs';
import { keyUsage, startBudgetGuard } from './lib/budget.mjs';
import { configureCallLog, summarizeCalls } from '../graph/call-log.mjs';
import { runCustomer } from './run-customer.mjs';

const runId = 'crew-fee-rehearsal';
const runsRoot = '/tmp/wiggly-crew-fee';
const runDir = join(runsRoot, runId);
const photo = join(runDir, 'Leo.jpg');
await mkdir(runDir, { recursive: true });
await writeFile(photo, Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxMTEhUTExMWFRUXGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYHSggGBolHRgYITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGxAQGy0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAMAAQMBIgACEQEDEQH/xAAbAAACAwEBAQAAAAAAAAAAAAACAwABBAUGB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvoAAA//Z', 'base64'));

const secrets = loadSecrets(defaultSecretsPath());
if (!secrets.OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is missing. Open https://openrouter.ai/settings/keys, copy a key, and paste it as OPENROUTER_API_KEY= in secrets.env.');
  process.exit(1);
}
const before = await keyUsage(secrets.OPENROUTER_API_KEY);
console.error(`[budget] remaining at start ${before.remaining === null ? 'n/a' : before.remaining.toFixed(4)}`);
if (typeof before.remaining === 'number' && before.remaining < 8) {
  console.error(`OpenRouter remaining balance is $${before.remaining.toFixed(2)}. This rehearsal needs more than $8 so it can finish. Open https://openrouter.ai/settings/credits, add at least $10, and run it again. Nothing was spent.`);
  process.exit(1);
}

const calls = join(runDir, 'calls.jsonl');
configureCallLog(calls);
const guard = await startBudgetGuard({
  apiKey: secrets.OPENROUTER_API_KEY,
  maxUsd: 8,
  log: (line) => console.error(line),
  onExceed: () => process.exit(3),
});
let stills = 0;
let clips = 0;
const log = (line) => console.error(line);
const startedAt = Date.now();
let status = 'threw';
try {
  const result = await runCustomer({
    runId,
    runsRoot,
    secrets,
    apiKey: 'rehearsal-no-replicate',
    log,
    project: {
      inputs: {
        subject: 'Leo',
        answers: {
          title: 'Sunday',
          memories: [
            'Leo wakes up, looks out the kitchen window, and smiles.',
            'Leo pours coffee and sits at the table.',
            'Leo reads a letter from his sister.',
            'Leo laughs and shakes his head.',
            'Leo stands and looks up.',
            'Leo folds the letter and puts it in his pocket.',
            'Leo walks outside into the morning light.',
          ],
          people: ['Leo'],
        },
        photoReferences: [{
          id: 'Leo',
          name: 'Leo',
          realPerson: 'Leo',
          skinTone: 'olive',
          description: 'An adult man with short dark hair faded on the sides, a trimmed beard, and a rust long-sleeve shirt.',
          path: photo,
        }],
      },
    },
    renderStill: async () => {
      stills += 1;
      const error = new Error('Rehearsal stops at the first still.');
      error.code = 'REHEARSAL_STOP';
      throw error;
    },
    renderClip: async () => {
      clips += 1;
      throw new Error('Rehearsal must not render a clip.');
    },
  });
  status = result.state?.status ?? 'done';
} catch (error) {
  status = `error: ${error instanceof Error ? error.message : 'unknown'}`;
  console.error(status);
}
const after = await keyUsage(secrets.OPENROUTER_API_KEY);
const usd = Math.max(0, after.usage - before.usage);
const credits = Math.ceil(usd * 100 - 1e-9);
const summary = summarizeCalls(calls);
console.error(`[budget] status ${status}; stills ${stills}; clips ${clips}; wall ${Math.round((Date.now() - startedAt) / 1000)}s`);
console.log(JSON.stringify({ status, stills, clips, usd, credits, summary }));
