// Disk copy of LangGraph's memory checkpointer. A paused run can resume after the process exits.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemorySaver } from '@langchain/langgraph';

function replacer(_key, value) {
  if (value instanceof Uint8Array) return { __u8: Buffer.from(value).toString('base64') };
  return value;
}

function reviver(_key, value) {
  if (value && typeof value === 'object' && typeof value.__u8 === 'string') {
    return new Uint8Array(Buffer.from(value.__u8, 'base64'));
  }
  return value;
}

export class FileMemorySaver extends MemorySaver {
  constructor(file) {
    super();
    this.file = file;
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'), reviver);
      this.storage = saved.storage ?? Object.create(null);
      this.writes = saved.writes ?? Object.create(null);
    }
  }

  flush() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ storage: this.storage, writes: this.writes }, replacer));
  }

  async put(config, checkpoint, metadata) {
    const result = await super.put(config, checkpoint, metadata);
    this.flush();
    return result;
  }

  async putWrites(config, writes, taskId, taskPath) {
    const result = await super.putWrites(config, writes, taskId, taskPath);
    this.flush();
    return result;
  }
}
