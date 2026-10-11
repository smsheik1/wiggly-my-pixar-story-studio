import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, cp, open } from 'node:fs/promises';
import { join, resolve, basename, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function normalizeForCassette(value, { secrets = [], aliases = {} } = {}) {
  const aliasPairs = Object.entries(aliases ?? {}).filter(([p]) => p && p.length > 1).sort((a, b) => b[0].length - a[0].length);
  // Extract non-empty secret strings
  const secretStrings = [];
  if (Array.isArray(secrets)) {
    for (const s of secrets) {
      if (typeof s === 'string' && s.length > 0) secretStrings.push(s);
    }
  } else if (typeof secrets === 'string' && secrets.length > 0) {
    secretStrings.push(secrets);
  }

  // Sort longest first to avoid partial replacements
  secretStrings.sort((a, b) => b.length - a.length);

  const redactString = (str) => {
    if (typeof str !== 'string' || !str) return str;
    let out = str;
    for (const s of secretStrings) {
      if (s && out.includes(s)) {
        out = out.split(s).join('[REDACTED]');
      }
    }
    return out;
  };

  const redactDataUrls = (str) => {
    if (typeof str !== 'string' || !str) return str;
    // replaces every data:<mime>;base64,<payload> substring with data:<mime>;sha256,<hex of the decoded bytes>
    return str.replace(/data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)/g, (match, mime, b64) => {
      try {
        const cleanedB64 = b64.replace(/\s+/g, '');
        const decoded = Buffer.from(cleanedB64, 'base64');
        return `data:${mime};sha256,${sha256Hex(decoded)}`;
      } catch {
        return match;
      }
    });
  };

  const processString = (str) => {
    let aliased = str;
    if (typeof aliased === 'string') for (const [p, token] of aliasPairs) if (aliased.includes(p)) aliased = aliased.split(p).join(token);
    const withHashedDataUrls = redactDataUrls(aliased);
    return redactString(withHashedDataUrls);
  };

  // Synchronous traversal for plain values; returns a promise if any Blob needs reading
  const normalize = (input) => {
    if (input === null || input === undefined) return input;

    // Buffer / Uint8Array / ArrayBuffer body
    if (Buffer.isBuffer(input)) {
      return { binarySha256: sha256Hex(input), bytes: input.length };
    }
    if (input instanceof Uint8Array) {
      const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
      return { binarySha256: sha256Hex(buf), bytes: buf.length };
    }
    if (input instanceof ArrayBuffer) {
      const buf = Buffer.from(input);
      return { binarySha256: sha256Hex(buf), bytes: buf.length };
    }
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
      // Async handling needed
      return input.arrayBuffer().then((ab) => {
        const buf = Buffer.from(ab);
        return { binarySha256: sha256Hex(buf), bytes: buf.length };
      });
    }
    if (typeof FormData !== 'undefined' && input instanceof FormData) {
      const promises = [];
      for (const [name, val] of input.entries()) {
        const cleanName = processString(name);
        if (typeof val === 'string') {
          promises.push(Promise.resolve({ name: cleanName, value: processString(val) }));
        } else if (typeof Blob !== 'undefined' && val instanceof Blob) {
          promises.push(
            val.arrayBuffer().then((ab) => {
              const buf = Buffer.from(ab);
              return { name: cleanName, value: { binarySha256: sha256Hex(buf), bytes: buf.length } };
            })
          );
        } else {
          promises.push(Promise.resolve({ name: cleanName, value: normalize(val) }));
        }
      }
      return Promise.all(promises);
    }

    if (typeof input === 'string') {
      return processString(input);
    }

    if (Array.isArray(input)) {
      const items = input.map(normalize);
      if (items.some((item) => item && typeof item.then === 'function')) {
        return Promise.all(items);
      }
      return items;
    }

    if (typeof input === 'object') {
      // Check for Gemini inline media part: { data: <base64>, mime_type }
      // Gemini inline parts: {data:<base64>, mime_type} -> {sha256, bytes:<length>, mime_type}
      if (typeof input.data === 'string' && typeof input.mime_type === 'string') {
        try {
          const decoded = Buffer.from(input.data, 'base64');
          const res = {
            sha256: sha256Hex(decoded),
            bytes: decoded.length,
            mime_type: processString(input.mime_type)
          };
          if (input.type !== undefined) res.type = processString(input.type);
          return res;
        } catch {
          // fall through
        }
      }

      const out = {};
      const pendingPromises = [];
      for (const [k, v] of Object.entries(input)) {
        const cleanKey = processString(k);
        const normVal = normalize(v);
        if (normVal && typeof normVal.then === 'function') {
          pendingPromises.push(
            normVal.then((resolved) => {
              out[cleanKey] = resolved;
            })
          );
        } else {
          out[cleanKey] = normVal;
        }
      }
      if (pendingPromises.length > 0) {
        return Promise.all(pendingPromises).then(() => out);
      }
      return out;
    }

    return input;
  };

  const result = normalize(value);
  if (result && typeof result.then === 'function') {
    return result;
  }
  return result;
}

export function filterHeaders(headers, isResponse = false) {
  if (!headers) return {};
  const entries =
    typeof headers.entries === 'function'
      ? Array.from(headers.entries())
      : Array.isArray(headers)
      ? headers
      : Object.entries(headers);

  const out = {};
  for (const [key, val] of entries) {
    const k = key.toLowerCase();
    if (['authorization', 'x-goog-api-key', 'xi-api-key', 'cookie', 'set-cookie'].includes(k)) {
      continue;
    }
    if (isResponse) {
      if (['content-type', 'retry-after', 'x-goog-upload-url', 'x-goog-upload-status'].includes(k)) {
        out[k] = val;
      }
    } else {
      out[k] = val;
    }
  }
  return out;
}

export function findFirstDiff(recorded, now, path = '') {
  if (recorded === now) return null;
  if (typeof recorded !== typeof now || recorded === null || now === null) {
    return { path: path || 'root', recorded, now };
  }
  if (Array.isArray(recorded) !== Array.isArray(now)) {
    return { path: path || 'root', recorded, now };
  }
  if (Array.isArray(recorded)) {
    if (recorded.length !== now.length) {
      const min = Math.min(recorded.length, now.length);
      for (let i = 0; i < min; i++) {
        const d = findFirstDiff(recorded[i], now[i], `${path}[${i}]`);
        if (d) return d;
      }
      return { path: `${path}.length`, recorded: recorded.length, now: now.length };
    }
    for (let i = 0; i < recorded.length; i++) {
      const d = findFirstDiff(recorded[i], now[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (typeof recorded === 'object') {
    const keysA = Object.keys(recorded).sort();
    const keysB = Object.keys(now).sort();
    const allKeys = Array.from(new Set([...keysA, ...keysB])).sort();
    for (const k of allKeys) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in recorded)) return { path: p, recorded: undefined, now: now[k] };
      if (!(k in now)) return { path: p, recorded: recorded[k], now: undefined };
      const d = findFirstDiff(recorded[k], now[k], p);
      if (d) return d;
    }
    return null;
  }
  return { path: path || 'root', recorded, now };
}

function truncateString(val, maxLen = 200) {
  if (val === undefined) return 'undefined';
  const str = JSON.stringify(val);
  if (str === undefined) return String(val);
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

export class Cassette {
  constructor(dir, mode = 'replay') {
    this.dir = dir;
    this.mode = mode; // 'record' or 'replay'
    this.lines = [];
    this.header = null;
    this.result = null;
    this.httpEntries = [];
    this.codexEntries = [];
    this.nextHttpIndex = 0;
    this.nextCodexIndex = 0;
    this.secrets = [];
    this.aliases = {};
    this.mismatchError = null;
    this.filePath = dir.endsWith('.jsonl') ? dir : join(dir, 'cassette.jsonl');
    this.httpSeq = 0;
    this.codexSeq = 0;
  }

  static async create(dir, header, { secrets = [] } = {}) {
    await mkdir(dir, { recursive: true });
    const cassette = new Cassette(dir, 'record');
    cassette.header = header;
    cassette.secrets = secrets;
    // Write header line
    await cassette.writeLine(header);
    return cassette;
  }

  static async open(dir, { secrets = [] } = {}) {
    const cassette = new Cassette(dir, 'replay');
    cassette.secrets = secrets;
    const content = await readFile(cassette.filePath, 'utf8');
    const rawLines = content.trim().split('\n').filter((l) => l.trim().length > 0);
    for (const raw of rawLines) {
      const obj = JSON.parse(raw);
      cassette.lines.push(obj);
      if (obj.type === 'header') {
        cassette.header = obj;
      } else if (obj.type === 'http') {
        cassette.httpEntries.push(obj);
      } else if (obj.type === 'codex') {
        cassette.codexEntries.push(obj);
      } else if (obj.type === 'result') {
        cassette.result = obj;
      }
    }
    return cassette;
  }

  async writeLine(obj) {
    const serialized = JSON.stringify(obj);
    for (const s of this.secrets) {
      if (s && s.length > 0 && serialized.includes(s)) {
        throw new Error(`CASSETTE_SECRET_LEAK: a secret value would be written to ${this.filePath}; nothing was written.`);
      }
    }
    await writeFile(this.filePath, serialized + '\n', { mode: 0o600, flag: 'a' });
  }

  recordMismatch(error) {
    if (!this.mismatchError) {
      this.mismatchError = error;
    }
  }

  assertFullyConsumed() {
    if (this.nextHttpIndex < this.httpEntries.length) {
      const unmade = this.httpEntries[this.nextHttpIndex];
      const remaining = this.httpEntries.length - this.nextHttpIndex;
      const err = new Error(
        `REPLAY_INCOMPLETE: ${remaining} recorded http calls were never made; first unmade: #${unmade.seq} (${unmade.provider} ${unmade.request?.method} ${unmade.request?.url})`
      );
      this.recordMismatch(err);
      throw err;
    }
    if (this.nextCodexIndex < this.codexEntries.length) {
      // Find the first unconsumed 'out' message or next entry
      const remaining = this.codexEntries.length - this.nextCodexIndex;
      const unmade = this.codexEntries[this.nextCodexIndex];
      const method = unmade.message?.method ?? unmade.dir;
      const err = new Error(
        `REPLAY_INCOMPLETE: ${remaining} recorded codex calls were never made; first unmade: #${unmade.seq} (codex ${method})`
      );
      this.recordMismatch(err);
      throw err;
    }
  }
}

export function recordingFetcher(cassette, provider, realFetch = globalThis.fetch) {
  return async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const cleanHeaders = filterHeaders(init.headers, false);

    // Normalize request body
    let cleanBody = null;
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body === 'string') {
        try {
          cleanBody = JSON.parse(init.body);
        } catch {
          cleanBody = init.body;
        }
      } else {
        cleanBody = init.body;
      }
      cleanBody = await normalizeForCassette(cleanBody, { secrets: cassette.secrets, aliases: cassette.aliases });
    }

    const cleanUrl = await normalizeForCassette(url.toString(), { secrets: cassette.secrets, aliases: cassette.aliases });
    const normalizedRequest = {
      method: method.toUpperCase(),
      url: cleanUrl,
      headers: await normalizeForCassette(cleanHeaders, { secrets: cassette.secrets, aliases: cassette.aliases }),
      body: cleanBody
    };

    const response = await realFetch(url, init);
    const cloned = response.clone();

    // Read response body
    const contentType = cloned.headers.get('content-type') || '';
    let resBody = null;
    if (contentType.includes('application/json')) {
      try {
        resBody = await cloned.json();
      } catch {
        resBody = await cloned.text();
      }
    } else {
      const text = await cloned.text().catch(() => null);
      if (text !== null) {
        resBody = text;
      } else {
        const ab = await cloned.arrayBuffer().catch(() => null);
        if (ab) {
          const buf = Buffer.from(ab);
          resBody = { binarySha256: sha256Hex(buf), bytes: buf.length };
        }
      }
    }

    const normResBody = await normalizeForCassette(resBody, { secrets: cassette.secrets, aliases: cassette.aliases });
    const cleanResHeaders = filterHeaders(cloned.headers, true);
    const normResHeaders = await normalizeForCassette(cleanResHeaders, { secrets: cassette.secrets, aliases: cassette.aliases });

    const seq = ++cassette.httpSeq;
    const entry = {
      type: 'http',
      seq,
      provider,
      request: normalizedRequest,
      response: {
        status: cloned.status,
        headers: normResHeaders,
        body: normResBody
      }
    };

    await cassette.writeLine(entry);
    return response;
  };
}

export function replayFetcher(cassette, provider) {
  return async (url, init = {}) => {
    const seq = ++cassette.httpSeq;
    if (cassette.nextHttpIndex >= cassette.httpEntries.length) {
      const err = new Error(
        `REPLAY_EXHAUSTED: http call #${seq} has no recorded response (the new code made more calls than the recording)`
      );
      cassette.recordMismatch(err);
      throw err;
    }

    const recorded = cassette.httpEntries[cassette.nextHttpIndex++];
    const method = (init.method ?? 'GET').toUpperCase();
    const cleanHeaders = filterHeaders(init.headers, false);

    let cleanBody = null;
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body === 'string') {
        try {
          cleanBody = JSON.parse(init.body);
        } catch {
          cleanBody = init.body;
        }
      } else {
        cleanBody = init.body;
      }
      cleanBody = await normalizeForCassette(cleanBody, { secrets: cassette.secrets, aliases: cassette.aliases });
    }

    const cleanUrl = await normalizeForCassette(url.toString(), { secrets: cassette.secrets, aliases: cassette.aliases });
    const normalizedRequest = {
      method,
      url: cleanUrl,
      headers: await normalizeForCassette(cleanHeaders, { secrets: cassette.secrets, aliases: cassette.aliases }),
      body: cleanBody
    };

    // Compare normalizedRequest vs recorded.request
    const diff = findFirstDiff(recorded.request, normalizedRequest);
    if (diff) {
      const diffMsg = `REPLAY_MISMATCH: http call #${recorded.seq} (${provider} ${method.toUpperCase()} ${cleanUrl}) differs at ${diff.path}: recorded ${truncateString(diff.recorded)} vs now ${truncateString(diff.now)}`;
      const err = new Error(diffMsg);
      cassette.recordMismatch(err);
      throw err;
    }

    // Build Response from recorded.response
    const recRes = recorded.response;
    const status = recRes.status ?? 200;
    const headers = new Headers(recRes.headers ?? {});

    let bodyData;
    if (recRes.body && typeof recRes.body === 'object' && 'binarySha256' in recRes.body && 'bytes' in recRes.body && Object.keys(recRes.body).length === 2) {
      // Binary body
      bodyData = new ReadableStream({
        start(controller) {
          controller.error(new Error('REPLAY_BINARY_UNAVAILABLE'));
        }
      });
    } else if (typeof recRes.body === 'object' && recRes.body !== null) {
      bodyData = JSON.stringify(recRes.body);
    } else if (typeof recRes.body === 'string') {
      bodyData = recRes.body;
    } else {
      bodyData = '';
    }

    return new Response(bodyData, { status, headers });
  };
}

export function recordingSpawn(cassette, realSpawn) {
  return (command, args, options) => {
    const child = realSpawn(command, args, options);

    const origWrite = child.stdin.write.bind(child.stdin);
    let stdinBuffer = '';

    child.stdin.write = function (chunk, encoding, callback) {
      if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }
      const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      stdinBuffer += str;
      const lines = stdinBuffer.split('\n');
      stdinBuffer = lines.pop(); // keep remainder

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const rawMsg = JSON.parse(line);
          const normMsg = normalizeForCassette(rawMsg, { secrets: cassette.secrets, aliases: cassette.aliases });
          const seq = ++cassette.codexSeq;
          cassette.writeLine({
            type: 'codex',
            seq,
            dir: 'out',
            message: normMsg
          }).catch((err) => child.emit('error', err));
        } catch {}
      }
      return origWrite(chunk, encoding, callback);
    };

    const origEnd = child.stdin.end.bind(child.stdin);
    child.stdin.end = function (chunk, encoding, callback) {
      if (chunk) {
        child.stdin.write(chunk, encoding);
      }
      return origEnd(callback);
    };

    let stdoutBuffer = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const rawMsg = JSON.parse(line);
          const normMsg = normalizeForCassette(rawMsg, { secrets: cassette.secrets, aliases: cassette.aliases });
          const seq = ++cassette.codexSeq;
          cassette.writeLine({
            type: 'codex',
            seq,
            dir: 'in',
            message: normMsg
          }).catch((err) => child.emit('error', err));
        } catch {}
      }
    });

    return child;
  };
}

export function replaySpawn(cassette) {
  return (_command, _args, _options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;

    child.kill = () => {
      child.killed = true;
      child.emit('exit', 0, null);
    };

    // Emit all leading 'in' messages recorded before the first 'out'
    const emitPendingIn = () => {
      while (
        cassette.nextCodexIndex < cassette.codexEntries.length &&
        cassette.codexEntries[cassette.nextCodexIndex].dir === 'in'
      ) {
        const item = cassette.codexEntries[cassette.nextCodexIndex++];
        child.stdout.write(JSON.stringify(item.message) + '\n');
      }
    };

    queueMicrotask(() => emitPendingIn());

    let inBuf = '';
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        inBuf += chunk.toString('utf8');
        const lines = inBuf.split('\n');
        inBuf = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          let rawMsg;
          try {
            rawMsg = JSON.parse(line);
          } catch {
            continue;
          }

          const normMsg = normalizeForCassette(rawMsg, { secrets: cassette.secrets, aliases: cassette.aliases });
          const seq = ++cassette.codexSeq;

          // Expect next recorded 'out' entry
          if (cassette.nextCodexIndex >= cassette.codexEntries.length) {
            const err = new Error(
              `REPLAY_EXHAUSTED: codex call #${seq} has no recorded response (the new code made more calls than the recording)`
            );
            cassette.recordMismatch(err);
            child.emit('error', err);
            callback(err);
            return;
          }

          const recorded = cassette.codexEntries[cassette.nextCodexIndex++];
          if (recorded.dir !== 'out') {
            const err = new Error(
              `REPLAY_MISMATCH: codex call #${seq} expected dir 'out' but recorded was '${recorded.dir}'`
            );
            cassette.recordMismatch(err);
            child.emit('error', err);
            callback();
            return;
          }

          const diff = findFirstDiff(recorded.message, normMsg);
          if (diff) {
            const method = recorded.message?.method ?? 'unknown';
            const diffMsg = `REPLAY_MISMATCH: codex call #${recorded.seq} (codex ${method}) differs at ${diff.path}: recorded ${truncateString(diff.recorded)} vs now ${truncateString(diff.now)}`;
            const err = new Error(diffMsg);
            cassette.recordMismatch(err);
            child.emit('error', err);
            callback();
            return;
          }

          // Matched! Emit every following recorded 'in' up to the next 'out'
          setTimeout(() => emitPendingIn(), 0);
        }
        callback();
      }
    });

    return child;
  };
}
