import { describe, it, expect } from 'vitest';
import { initializeSchema } from '../db/migrations.js';
import { createNode, getNode, createEdge, getEdge } from '../db/graph.js';
import { decaySweep } from '../core/maintenance.js';
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
