import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export function makeSolidPng(width, height, r = 255, g = 0, b = 0) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  function makeChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const toCrc = Buffer.concat([typeBuf, data]);
    const c = crc32(toCrc);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(c >>> 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = makeChunk('IHDR', ihdr);

  const rowSize = 1 + width * 3;
  const rawData = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const offset = y * rowSize;
    rawData[offset] = 0;
    for (let x = 0; x < width; x++) {
      rawData[offset + 1 + x * 3] = r;
      rawData[offset + 1 + x * 3 + 1] = g;
      rawData[offset + 1 + x * 3 + 2] = b;
    }
  }
  const idatChunk = makeChunk('IDAT', deflateSync(rawData));
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function main() {
  const pngBytes = makeSolidPng(8, 8, 255, 0, 0);
  const pngHash = sha256Hex(pngBytes);
  const imageHashUrl = `data:image/png;sha256,${pngHash}`;

  // 1. OpenRouter synthetic cassette
  // Turn: Request 1 sends prompt + image_url (data URL hashed), Assistant responds with tool_call wiggly_tool viewImage.
  // Request 2 sends tool result + viewImage result, Assistant responds with final event.
  const orLines = [];
  orLines.push({
    type: 'header',
    version: 1,
    createdAt: '2026-10-10T00:00:00.000Z',
    argv: ['work-codex'],
    codexVersion: null,
    profiles: { codex: null, openrouter: 'openrouter-synthetic-profile' }
  });

  const orReq1 = {
    method: 'POST',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: { 'content-type': 'application/json', 'x-title': 'Wiggly memoir studio' },
    body: {
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: 'synthetic system prompt' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Task packet with image' },
            { type: 'image_url', image_url: { url: imageHashUrl } }
          ]
        }
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'wiggly_tool', description: 'synthetic tool' }
        }
      ],
      tool_choice: 'auto',
      provider: { require_parameters: true, max_price: { prompt: 0.3, completion: 1.2 } },
      max_tokens: 16000,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'event',
          strict: true,
          schema: {
            type: 'object',
            properties: { eventJson: { type: 'string' } },
            required: ['eventJson'],
            additionalProperties: false
          }
        }
      },
      reasoning: { effort: 'medium' }
    }
  };

  const orRes1 = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      model: 'deepseek/deepseek-v4.1-flash',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'wiggly_tool',
                  arguments: JSON.stringify({ name: 'viewImage', sha256: pngHash, referenceSha256: null })
                }
              }
            ]
          }
        }
      ]
    }
  };

  orLines.push({
    type: 'http',
    seq: 1,
    provider: 'openrouter',
    request: orReq1,
    response: orRes1
  });

  const sampleEvent = {
    taskId: 'synthetic-task-1',
    actor: 'agent',
    workerId: 'openrouter:text-reviewer:test',
    action: 'artifact',
    content: { notes: 'synthetic pass' }
  };

  const orReq2 = {
    method: 'POST',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: { 'content-type': 'application/json', 'x-title': 'Wiggly memoir studio' },
    body: {
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: 'synthetic system prompt' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Task packet with image' },
            { type: 'image_url', image_url: { url: imageHashUrl } }
          ]
        },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'wiggly_tool',
                arguments: JSON.stringify({ name: 'viewImage', sha256: pngHash, referenceSha256: null })
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: JSON.stringify({ perception: 'direct-image', sha256: pngHash, attached: true, note: 'attached below' })
        },
        {
          type: 'text',
          text: `viewImage result for sha256 ${pngHash}`
        },
        {
          type: 'image_url',
          image_url: { url: imageHashUrl }
        }
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'wiggly_tool', description: 'synthetic tool' }
        }
      ],
      tool_choice: 'auto',
      provider: { require_parameters: true, max_price: { prompt: 0.3, completion: 1.2 } },
      max_tokens: 16000,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'event',
          strict: true,
          schema: {
            type: 'object',
            properties: { eventJson: { type: 'string' } },
            required: ['eventJson'],
            additionalProperties: false
          }
        }
      },
      reasoning: { effort: 'medium' }
    }
  };

  const orRes2 = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      model: 'deepseek/deepseek-v4.1-flash',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: JSON.stringify({ eventJson: JSON.stringify(sampleEvent) })
          }
        }
      ]
    }
  };

  orLines.push({
    type: 'http',
    seq: 2,
    provider: 'openrouter',
    request: orReq2,
    response: orRes2
  });

  orLines.push({
    type: 'result',
    exitCode: 0,
    stdout: { completed: true },
    error: null
  });

  await writeFile(
    join(root, 'openrouter-synthetic.jsonl'),
    orLines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    { mode: 0o600 }
  );

  // 2. Codex synthetic cassette
  // Codex JSON-RPC interaction:
  // in: (leading notifications if any, or initialize)
  // out: initialize
  // in: result initialize
  // out: initialized
  // out: thread/start or thread/resume
  // in: result thread
  // out: turn/start
  // in: result turn/start
  // in: item/completed or tool call
  // out: item/tool/result (if tool call)
  // in: turn/completed
  const codexLines = [];
  codexLines.push({
    type: 'header',
    version: 1,
    createdAt: '2026-10-10T00:00:00.000Z',
    argv: ['work-codex'],
    codexVersion: 'codex 0.1.0-synthetic',
    profiles: { codex: 'codex-synthetic-profile', openrouter: null }
  });

  let cSeq = 0;
  // 1. initialize
  codexLines.push({
    type: 'codex',
    seq: ++cSeq,
    dir: 'out',
    message: {
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'wiggly_memoir', title: 'Wiggly memoir studio', version: '2.0.0' },
        capabilities: { experimentalApi: true }
      }
    }
  });
  codexLines.push({
    type: 'codex',
    seq: ++cSeq,
    dir: 'in',
    message: { id: 1, result: { platformFamily: 'unix' } }
  });

  // 2. initialized
  codexLines.push({
    type: 'codex',
    seq: ++cSeq,
    dir: 'out',
    message: { method: 'initialized', params: {} }
  });



  // 4. turn/start
  const codexTaskEvent = {
    taskId: 'synthetic-codex-task-1',
    actor: 'agent',
    workerId: 'bind-host-script-writer',
    action: 'artifact',
    content: { beats: [] }
  };

  codexLines.push({
    type: 'codex',
    seq: ++cSeq,
    dir: 'out',
    message: {
      id: 2,
      method: 'turn/start',
      params: {
        threadId: 'thr-synthetic-1',
        input: [{ type: 'text', text: JSON.stringify({ instruction: 'synthetic turn', task: { taskId: 'synthetic-codex-task-1' } }) }]
      }
    }
  });

  codexLines.push({
    type: 'codex',
    seq: ++cSeq,
    dir: 'in',
    message: { id: 2, result: { turn: { id: 'turn-synthetic-1' } } }
  });

  codexLines.push({
    type: 'codex',
    seq: ++cSeq,
    dir: 'in',
    message: {
      method: 'item/completed',
      params: {
        threadId: 'thr-synthetic-1',
        turnId: 'turn-synthetic-1',
        item: {
          type: 'agentMessage',
          text: JSON.stringify({ eventJson: JSON.stringify(codexTaskEvent) })
        }
      }
    }
  });

  codexLines.push({
    type: 'codex',
    seq: ++cSeq,
    dir: 'in',
    message: {
      method: 'turn/completed',
      params: {
        threadId: 'thr-synthetic-1',
        turn: { id: 'turn-synthetic-1', status: 'completed', error: null }
      }
    }
  });

  codexLines.push({
    type: 'result',
    exitCode: 0,
    stdout: { completed: true },
    error: null
  });

  await writeFile(
    join(root, 'codex-synthetic.jsonl'),
    codexLines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    { mode: 0o600 }
  );

  console.log('Synthetic cassettes generated successfully.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
