import type BetterSqlite3 from 'better-sqlite3';
import { getNodesByFile } from '../db/graph.js';
import type { Annotation } from '../types.js';

type Database = BetterSqlite3.Database;

export function getFileAnnotations(db: Database, filePath: string, seenFiles: Set<string>): Annotation[] {
  if (seenFiles.has(filePath)) return [];

  const nodes = getNodesByFile(db, filePath);

  return nodes
    .filter(n => n.strength > 0.5)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 3)
    .map(n => ({ nodeId: n.id, name: n.name, description: n.description, strength: n.strength }));
}
