import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

export type { Database as DatabaseType } from 'better-sqlite3';
export { Database };

const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  node_type TEXT NOT NULL CHECK(node_type IN ('concept','decision','pattern','file','entity')),
  description TEXT NOT NULL DEFAULT '',
  affected_files TEXT NOT NULL DEFAULT '[]',
  strength REAL NOT NULL DEFAULT 1.0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  source_node_id TEXT NOT NULL REFERENCES nodes(id),
  target_node_id TEXT NOT NULL REFERENCES nodes(id),
  relationship_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_node_id);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  nodes_involved TEXT NOT NULL DEFAULT '[]',
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function buildSchemaSQL(dimension: number, provider: string): string {
  return BASE_SCHEMA_SQL + `
CREATE VIRTUAL TABLE IF NOT EXISTS node_embeddings USING vec0(
  node_id TEXT PRIMARY KEY,
  embedding FLOAT[${dimension}] distance_metric=cosine
);

INSERT OR IGNORE INTO metadata (key, value) VALUES ('embedding_provider', '${provider}');
INSERT OR IGNORE INTO metadata (key, value) VALUES ('embedding_dimension', '${dimension}');
INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '1');
`;
}

export function initializeSchema(
  dbPath: string,
  dimension: number = 512,
  provider: string = 'voyage-3-lite',
): BetterSqlite3.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);

  db.transaction(() => {
    db.exec(buildSchemaSQL(dimension, provider));

    const row = db.prepare("SELECT value FROM metadata WHERE key = 'embedding_dimension'").get() as { value: string } | undefined;
    const existingDim = row ? parseInt(row.value, 10) : dimension;

    if (existingDim !== dimension) {
      console.warn(`Embedding dimension changed from ${existingDim} to ${dimension}, rebuilding vector table`);
      db.exec('DROP TABLE IF EXISTS node_embeddings');
      db.exec(`CREATE VIRTUAL TABLE node_embeddings USING vec0(
        node_id TEXT PRIMARY KEY,
        embedding FLOAT[${dimension}] distance_metric=cosine
      )`);
      db.prepare("UPDATE metadata SET value = ? WHERE key = 'embedding_dimension'").run(String(dimension));
      db.prepare("UPDATE metadata SET value = ? WHERE key = 'embedding_provider'").run(provider);
    }
  })();

  return db;
}

export function getSchemaVersion(db: BetterSqlite3.Database): number {
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get('schema_version') as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}
