import type BetterSqlite3 from 'better-sqlite3';
import { deleteNode, updateNode } from '../db/graph.js';

type Database = BetterSqlite3.Database;

export interface DecaySweepResult {
  nodesPruned: number;
  nodesDecayed: number;
}

export function decaySweep(
  db: Database,
  config: { decayThreshold: number; decayFactor: number },
): DecaySweepResult {
  const rows = db.prepare('SELECT id, strength FROM nodes').all() as Array<{
    id: string;
    strength: number;
  }>;

  let nodesPruned = 0;
  let nodesDecayed = 0;

  for (const row of rows) {
    const newStrength = row.strength * config.decayFactor;

    if (newStrength < config.decayThreshold) {
      deleteNode(db, row.id);
      nodesPruned++;
    } else {
      updateNode(db, row.id, { strength: newStrength });
      nodesDecayed++;
    }
  }

  return { nodesPruned, nodesDecayed };
}
