import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeSchema } from '../db/migrations.js';
import { createNode, getNode, createEdge } from '../db/graph.js';
import { runMaintenance } from '../core/maintenance.js';
import type { CreateNodeInput, CreateEdgeInput } from '../types.js';

function freshDb() {
  return initializeSchema(':memory:');
}

function makeNode(overrides?: Partial<CreateNodeInput>): CreateNodeInput {
  return {
    name: 'node',
    nodeType: 'concept',
    description: 'test',
    affectedFiles: [],
    strength: 0.8,
    metadata: {},
    ...overrides,
  };
}

function makeEdge(sourceId: string, targetId: string, relType: string): CreateEdgeInput {
  return {
    sourceNodeId: sourceId,
    targetNodeId: targetId,
    relationshipType: relType,
    weight: 1.0,
    metadata: {},
  };
}

const CONFIG = { decayThreshold: 0.05, decayFactor: 0.9 };

describe('maintenance integration', () => {
  function makeTmpDir() {
    return mkdtempSync(join(tmpdir(), 'engram-integ-'));
  }

  it('full maintenance pass: decay + pattern scan + supersession in single transaction', () => {
    const db = freshDb();
    const dataDir = makeTmpDir();
    try {
      // --- Decay targets ---
      // A weak node that will be pruned (0.04 * 0.9 = 0.036 < 0.05)
      const weakNode = createNode(db, makeNode({ name: 'weak', strength: 0.04 }));
      // A strong node that will just decay
      const strongNode = createNode(db, makeNode({ name: 'strong', strength: 0.9 }));

      // --- Pattern scan targets ---
      // 6 concept nodes forming 3 same-type edges for the 'related' relationship
      const concepts = Array.from({ length: 6 }, (_, i) =>
        createNode(db, makeNode({ name: `concept-${i}`, nodeType: 'concept', strength: 1.0 })),
      );
      createEdge(db, makeEdge(concepts[0].id, concepts[1].id, 'related'));
      createEdge(db, makeEdge(concepts[2].id, concepts[3].id, 'related'));
      createEdge(db, makeEdge(concepts[4].id, concepts[5].id, 'related'));

      // --- Supersession targets ---
      // A node whose affected_files all reference nonexistent paths
      const staleNode = createNode(db, makeNode({
        name: 'stale-refs',
        affectedFiles: ['/nonexistent/a.ts', '/nonexistent/b.ts'],
        strength: 0.7,
      }));

      // A node with one existing file — should NOT be superseded
      const tmpFile = join(dataDir, 'real-file.ts');
      writeFileSync(tmpFile, 'export const x = 1;');
      const partialNode = createNode(db, makeNode({
        name: 'partial-refs',
        affectedFiles: [tmpFile, '/nonexistent/c.ts'],
        strength: 0.6,
      }));

      // --- Run full maintenance ---
      const result = runMaintenance(db, dataDir, CONFIG);

      // Overall result shape
      expect(result.skipped).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Decay: weakNode pruned, others decayed
      expect(result.nodesPruned).toBe(1);
      expect(getNode(db, weakNode.id)).toBeUndefined();
      expect(getNode(db, strongNode.id)).toBeDefined();

      // Pattern scan: 3 concept→concept 'related' edges → 1 pattern created
      expect(result.patternsCreated).toBe(1);
      const patternNode = db.prepare(
        "SELECT name FROM nodes WHERE node_type = 'pattern'",
      ).get() as { name: string } | undefined;
      expect(patternNode).toBeDefined();
      expect(patternNode!.name).toBe('pattern:related:concept');

      // Supersession: staleNode → strength=0, partialNode unchanged
      expect(result.filesSuperseded).toBe(1);
      const staleAfter = getNode(db, staleNode.id);
      expect(staleAfter).toBeDefined();
      expect(staleAfter!.strength).toBe(0);

      const partialAfter = getNode(db, partialNode.id);
      expect(partialAfter).toBeDefined();
      expect(partialAfter!.strength).toBeCloseTo(0.6 * 0.9);

      // Metadata recorded
      const meta = db.prepare(
        "SELECT value FROM metadata WHERE key = 'last_maintenance_run'",
      ).get() as { value: string };
      const record = JSON.parse(meta.value);
      expect(record.nodesPruned).toBe(1);
      expect(record.patternsCreated).toBe(1);
      expect(record.filesSuperseded).toBe(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('all three phases run inside the same transaction (rollback on error)', () => {
    const db = freshDb();
    const dataDir = makeTmpDir();
    try {
      // Seed nodes so decay and pattern scan would have work
      createNode(db, makeNode({ name: 'n1', strength: 0.5 }));

      // Run once to populate metadata
      runMaintenance(db, dataDir, CONFIG);

      // Force next run by backdating
      const old = JSON.stringify({ timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
      db.prepare("UPDATE metadata SET value = ? WHERE key = 'last_maintenance_run'").run(old);

      // Break the nodes table mid-transaction by renaming it
      // This ensures the transaction wraps all three phases — if any fails, none commit
      db.exec('ALTER TABLE nodes RENAME TO nodes_backup');

      const result = runMaintenance(db, dataDir, CONFIG);

      // Error caught, zeroed result returned
      expect(result.nodesPruned).toBe(0);
      expect(result.patternsCreated).toBe(0);
      expect(result.filesSuperseded).toBe(0);

      // Metadata should NOT have been updated (transaction rolled back)
      const meta = db.prepare(
        "SELECT value FROM metadata WHERE key = 'last_maintenance_run'",
      ).get() as { value: string };
      const record = JSON.parse(meta.value);
      // Should still have the old backdated timestamp
      expect(new Date(record.timestamp).getTime()).toBeLessThan(Date.now() - 24 * 60 * 60 * 1000);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
