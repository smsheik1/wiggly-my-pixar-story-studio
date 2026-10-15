import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import Database from 'better-sqlite3';

export function ensureBlobsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blobs (
      hash TEXT PRIMARY KEY,
      content TEXT NOT NULL
    );
  `);
}

export function slimStudio(studio, db) {
  if (!studio || !studio.documents) return studio;
  ensureBlobsTable(db);
  const insert = db.prepare('INSERT OR IGNORE INTO blobs (hash, content) VALUES (?, ?)');
  const slimDocs = {};
  for (const [path, doc] of Object.entries(studio.documents)) {
    const hash = doc.hash || doc.sha256;
    if (doc.content) {
      insert.run(hash, doc.content);
    }
    slimDocs[path] = { hash };
  }
  return { ...studio, documents: slimDocs };
}

export function hydrateStudio(studio, db) {
  if (!studio || !studio.documents) return studio;
  let select, insert;
  if (db) {
    ensureBlobsTable(db);
    select = db.prepare('SELECT content FROM blobs WHERE hash = ?');
    insert = db.prepare('INSERT OR IGNORE INTO blobs (hash, content) VALUES (?, ?)');
  }
  const hydratedDocs = {};
  for (const [path, doc] of Object.entries(studio.documents)) {
    const hash = doc.hash || doc.sha256;
    if (doc.content) {
      if (insert) insert.run(hash, doc.content);
      hydratedDocs[path] = { content: doc.content, sha256: hash };
    } else {
      const row = select ? select.get(hash) : null;
      if (!row) {
        const err = new Error(`STUDIO_BLOB_MISSING: ${hash}`);
        err.name = 'STUDIO_BLOB_MISSING';
        err.code = 'STUDIO_BLOB_MISSING';
        err.hash = hash;
        throw err;
      }
      hydratedDocs[path] = { content: row.content, sha256: hash };
    }
  }
  return { ...studio, documents: hydratedDocs };
}

export function slimObj(obj, db) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj.project && obj.project.studio) {
    return { ...obj, project: { ...obj.project, studio: slimStudio(obj.project.studio, db) } };
  }
  if (obj.studio) {
    return { ...obj, studio: slimStudio(obj.studio, db) };
  }
  return obj;
}

export function hydrateObj(obj, db) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj.project && obj.project.studio) {
    return { ...obj, project: { ...obj.project, studio: hydrateStudio(obj.project.studio, db) } };
  }
  if (obj.studio) {
    return { ...obj, studio: hydrateStudio(obj.studio, db) };
  }
  return obj;
}

export class SlimSqliteSaver extends SqliteSaver {
  static fromConnString(connStringOrLocalPath) {
    return new SlimSqliteSaver(new Database(connStringOrLocalPath));
  }

  setup() {
    super.setup();
    ensureBlobsTable(this.db);
  }

  async put(config, checkpoint, metadata) {
    if (checkpoint?.channel_values) {
      checkpoint = {
        ...checkpoint,
        channel_values: Object.fromEntries(
          Object.entries(checkpoint.channel_values).map(([k, v]) => [k, slimObj(v, this.db)])
        )
      };
    }
    return super.put(config, checkpoint, metadata);
  }

  async putWrites(config, writes, taskId) {
    const slimmedWrites = writes.map(([ch, val]) => [ch, slimObj(val, this.db)]);
    return super.putWrites(config, slimmedWrites, taskId);
  }

  async getTuple(config) {
    const tuple = await super.getTuple(config);
    if (!tuple) return undefined;
    if (tuple.checkpoint?.channel_values) {
      tuple.checkpoint = {
        ...tuple.checkpoint,
        channel_values: Object.fromEntries(
          Object.entries(tuple.checkpoint.channel_values).map(([k, v]) => [k, hydrateObj(v, this.db)])
        )
      };
    }
    if (tuple.pendingWrites) {
      tuple.pendingWrites = tuple.pendingWrites.map(([taskId, channel, val]) => [taskId, channel, hydrateObj(val, this.db)]);
    }
    return tuple;
  }

  async *list(config, options) {
    for await (const tuple of super.list(config, options)) {
      if (tuple?.checkpoint?.channel_values) {
        tuple.checkpoint = {
          ...tuple.checkpoint,
          channel_values: Object.fromEntries(
            Object.entries(tuple.checkpoint.channel_values).map(([k, v]) => [k, hydrateObj(v, this.db)])
          )
        };
      }
      if (tuple?.pendingWrites) {
        tuple.pendingWrites = tuple.pendingWrites.map(([taskId, channel, val]) => [taskId, channel, hydrateObj(val, this.db)]);
      }
      yield tuple;
    }
  }
}
