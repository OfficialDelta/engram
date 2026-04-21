import type BetterSqlite3 from 'better-sqlite3';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createNode, deleteNode, updateNode } from '../db/graph.js';

type Database = BetterSqlite3.Database;

export interface DecaySweepResult {
  nodesPruned: number;
  nodesDecayed: number;
}

export interface MaintenanceResult {
  nodesPruned: number;
  patternsCreated: number;
  filesSuperseded: number;
  durationMs: number;
  skipped: boolean;
}

const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function runMaintenance(
  db: Database,
  dataDir: string,
  config: { decayThreshold: number; decayFactor: number },
): MaintenanceResult {
  const start = Date.now();
  const zeroed = (): MaintenanceResult => ({
    nodesPruned: 0, patternsCreated: 0, filesSuperseded: 0, durationMs: Date.now() - start, skipped: false,
  });

  try {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'last_maintenance_run'").get() as
      | { value: string }
      | undefined;

    if (row) {
      const parsed = JSON.parse(row.value) as { timestamp: string };
      const lastRun = new Date(parsed.timestamp).getTime();
      if (start - lastRun < MAINTENANCE_INTERVAL_MS) {
        return { nodesPruned: 0, patternsCreated: 0, filesSuperseded: 0, durationMs: Date.now() - start, skipped: true };
      }
    }

    const result = db.transaction(() => {
      const sweep = decaySweep(db, config);
      const patterns = patternScan(db);

      const maintenanceRecord = {
        timestamp: new Date().toISOString(),
        nodesPruned: sweep.nodesPruned,
        nodesDecayed: sweep.nodesDecayed,
        patternsCreated: patterns.patternsCreated,
        filesSuperseded: 0,
      };

      db.prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_maintenance_run', ?)",
      ).run(JSON.stringify(maintenanceRecord));

      return { ...sweep, patternsCreated: patterns.patternsCreated };
    })();

    return {
      nodesPruned: result.nodesPruned,
      patternsCreated: result.patternsCreated,
      filesSuperseded: 0,
      durationMs: Date.now() - start,
      skipped: false,
    };
  } catch (err: unknown) {
    const logDir = join(dataDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    const message = err instanceof Error ? err.message : String(err);
    appendFileSync(join(logDir, 'maintenance.log'), `[${new Date().toISOString()}] maintenance error: ${message}\n`);

    return zeroed();
  }
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

export interface PatternScanResult {
  patternsCreated: number;
}

export function patternScan(db: Database): PatternScanResult {
  const groups = db.prepare(`
    SELECT e.relationship_type, n.node_type, COUNT(*) AS cnt
    FROM edges e
    JOIN nodes n ON n.id = e.source_node_id
    JOIN nodes n2 ON n2.id = e.target_node_id
    WHERE n.node_type = n2.node_type
    GROUP BY e.relationship_type, n.node_type
    HAVING cnt >= 3
  `).all() as Array<{ relationship_type: string; node_type: string; cnt: number }>;

  let patternsCreated = 0;

  for (const group of groups) {
    const patternName = `pattern:${group.relationship_type}:${group.node_type}`;
    const existing = db.prepare(
      "SELECT id FROM nodes WHERE name = ? AND node_type = 'pattern'",
    ).get(patternName) as { id: string } | undefined;

    if (existing) continue;

    createNode(db, {
      name: patternName,
      nodeType: 'pattern',
      description: `Recurring ${group.relationship_type} relationship among ${group.node_type} nodes (${group.cnt} edges)`,
      affectedFiles: [],
      strength: 1.0,
      metadata: { relationshipType: group.relationship_type, nodeType: group.node_type, edgeCount: group.cnt },
    });
    patternsCreated++;
  }

  return { patternsCreated };
}
