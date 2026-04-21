import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { initializeSchema } from '../db/migrations.js';
import { createNode, getNode, createEdge, getEdge } from '../db/graph.js';
import { decaySweep, runMaintenance } from '../core/maintenance.js';
import type { CreateNodeInput, CreateEdgeInput } from '../types.js';

function freshDb() {
  return initializeSchema(':memory:');
}

function makeNodeInput(overrides?: Partial<CreateNodeInput>): CreateNodeInput {
  return {
    name: 'test-node',
    nodeType: 'concept',
    description: 'a test node',
    affectedFiles: ['src/main.ts'],
    strength: 0.8,
    metadata: {},
    ...overrides,
  };
}

const DEFAULT_CONFIG = { decayThreshold: 0.05, decayFactor: 0.9 };

describe('decaySweep', () => {
  it('decays nodes above threshold and returns correct counts', () => {
    const db = freshDb();
    const node = createNode(db, makeNodeInput({ strength: 0.5 }));

    const result = decaySweep(db, DEFAULT_CONFIG);

    expect(result).toEqual({ nodesPruned: 0, nodesDecayed: 1 });
    const updated = getNode(db, node.id);
    expect(updated).toBeDefined();
    expect(updated!.strength).toBeCloseTo(0.45);
  });

  it('prunes nodes whose decayed strength falls below threshold', () => {
    const db = freshDb();
    const node = createNode(db, makeNodeInput({ strength: 0.04 }));

    const result = decaySweep(db, DEFAULT_CONFIG);

    expect(result).toEqual({ nodesPruned: 1, nodesDecayed: 0 });
    expect(getNode(db, node.id)).toBeUndefined();
  });

  it('cascade-deletes edges and embeddings when pruning a node', () => {
    const db = freshDb();
    const weak = createNode(db, makeNodeInput({ name: 'weak', strength: 0.04 }));
    const strong = createNode(db, makeNodeInput({ name: 'strong', strength: 0.8 }));
    const edge = createEdge(db, {
      sourceNodeId: weak.id,
      targetNodeId: strong.id,
      relationshipType: 'related',
      weight: 1.0,
      metadata: {},
    });

    const result = decaySweep(db, DEFAULT_CONFIG);

    expect(result.nodesPruned).toBe(1);
    expect(getNode(db, weak.id)).toBeUndefined();
    expect(getEdge(db, edge.id)).toBeUndefined();
    expect(getNode(db, strong.id)).toBeDefined();
  });

  it('returns zero counts on empty graph', () => {
    const db = freshDb();

    const result = decaySweep(db, DEFAULT_CONFIG);

    expect(result).toEqual({ nodesPruned: 0, nodesDecayed: 0 });
  });

  it('handles mixed nodes: some pruned, some decayed', () => {
    const db = freshDb();
    createNode(db, makeNodeInput({ name: 'strong', strength: 0.8 }));
    createNode(db, makeNodeInput({ name: 'weak', strength: 0.03 }));
    createNode(db, makeNodeInput({ name: 'medium', strength: 0.5 }));

    const result = decaySweep(db, DEFAULT_CONFIG);

    expect(result.nodesPruned).toBe(1);
    expect(result.nodesDecayed).toBe(2);
  });
});

describe('runMaintenance', () => {
  function makeTmpDir() {
    return mkdtempSync(join(tmpdir(), 'engram-test-'));
  }

  function cleanTmpDir(dir: string) {
    rmSync(dir, { recursive: true, force: true });
  }

  it('runs decay sweep and records result in metadata', () => {
    const db = freshDb();
    const dataDir = makeTmpDir();
    try {
      createNode(db, makeNodeInput({ name: 'weak', strength: 0.04 }));
      createNode(db, makeNodeInput({ name: 'strong', strength: 0.8 }));

      const result = runMaintenance(db, dataDir, DEFAULT_CONFIG);

      expect(result.skipped).toBe(false);
      expect(result.nodesPruned).toBe(1);
      expect(result.patternsCreated).toBe(0);
      expect(result.filesSuperseded).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      const row = db.prepare("SELECT value FROM metadata WHERE key = 'last_maintenance_run'").get() as { value: string };
      const record = JSON.parse(row.value);
      expect(record.timestamp).toBeDefined();
      expect(record.nodesPruned).toBe(1);
    } finally {
      cleanTmpDir(dataDir);
    }
  });

  it('skips when last run was less than 24h ago', () => {
    const db = freshDb();
    const dataDir = makeTmpDir();
    try {
      const recent = JSON.stringify({ timestamp: new Date().toISOString(), nodesPruned: 0 });
      db.prepare("INSERT INTO metadata (key, value) VALUES ('last_maintenance_run', ?)").run(recent);

      const node = createNode(db, makeNodeInput({ name: 'node', strength: 0.04 }));

      const result = runMaintenance(db, dataDir, DEFAULT_CONFIG);

      expect(result.skipped).toBe(true);
      expect(result.nodesPruned).toBe(0);
      expect(getNode(db, node.id)).toBeDefined();
    } finally {
      cleanTmpDir(dataDir);
    }
  });

  it('runs when last run was more than 24h ago', () => {
    const db = freshDb();
    const dataDir = makeTmpDir();
    try {
      const old = JSON.stringify({ timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
      db.prepare("INSERT INTO metadata (key, value) VALUES ('last_maintenance_run', ?)").run(old);

      createNode(db, makeNodeInput({ name: 'weak', strength: 0.04 }));

      const result = runMaintenance(db, dataDir, DEFAULT_CONFIG);

      expect(result.skipped).toBe(false);
      expect(result.nodesPruned).toBe(1);
    } finally {
      cleanTmpDir(dataDir);
    }
  });

  it('catches errors inside transaction and logs to maintenance.log', () => {
    const db = freshDb();
    const dataDir = makeTmpDir();
    try {
      // Drop nodes table so decaySweep's SELECT fails inside the transaction
      db.exec('DROP TABLE edges');
      db.exec('DROP TABLE nodes');

      const result = runMaintenance(db, dataDir, DEFAULT_CONFIG);

      expect(result.nodesPruned).toBe(0);
      expect(result.skipped).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      const logPath = join(dataDir, 'logs', 'maintenance.log');
      expect(existsSync(logPath)).toBe(true);
      const logContent = readFileSync(logPath, 'utf-8');
      expect(logContent).toContain('maintenance error:');
    } finally {
      cleanTmpDir(dataDir);
    }
  });

  it('never throws even on unexpected errors', () => {
    const db = freshDb();
    const dataDir = makeTmpDir();
    try {
      // Drop metadata table so the initial SELECT throws
      db.exec('DROP TABLE metadata');

      const result = runMaintenance(db, dataDir, DEFAULT_CONFIG);

      expect(result.nodesPruned).toBe(0);
      expect(result.skipped).toBe(false);
    } finally {
      cleanTmpDir(dataDir);
    }
  });
});
