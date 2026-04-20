import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type BetterSqlite3 from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

export type { Database as DatabaseType } from 'better-sqlite3';
export { Database };

export function initializeSchema(dbPath: string): BetterSqlite3.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);

  const schemaSql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf-8');
  db.transaction(() => {
    db.exec(schemaSql);
  })();

  return db;
}

export function getSchemaVersion(db: BetterSqlite3.Database): number {
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get('schema_version') as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}
