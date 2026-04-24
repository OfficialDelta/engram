import { describe, it, expect } from 'vitest';
import { initializeSchema } from '../db/migrations.js';
import { createNode, createEdge } from '../db/graph.js';
import { spreadingActivation } from '../core/retrieval.js';
import type { CreateNodeInput } from '../types.js';

function freshDb() {
  return initializeSchema(':memory:');
}

function makeNode(db: ReturnType<typeof freshDb>, overrides?: Partial<CreateNodeInput>) {
  return createNode(db, {
    name: 'node',
    nodeType: 'concept',
    description: 'test',
    affectedFiles: [],
    strength: 1.0,
    metadata: {},
    ...overrides,
  });
}

function link(db: ReturnType<typeof freshDb>, sourceId: string, targetId: string, weight: number) {
  return createEdge(db, {
    sourceNodeId: sourceId,
    targetNodeId: targetId,
    relationshipType: 'related',
    weight,
    metadata: {},
  });
}

describe('spreadingActivation', () => {
  it('decays activation per hop through a chain', () => {
    const db = freshDb();
    const a = makeNode(db, { name: 'A', strength: 1.0 });
    const b = makeNode(db, { name: 'B', strength: 1.0 });
    const c = makeNode(db, { name: 'C', strength: 1.0 });

    link(db, a.id, b.id, 0.8);
    link(db, b.id, c.id, 0.9);

    const results = spreadingActivation(db, [{ type: 'node', value: a.id }]);

    const all = [...results.high, ...results.medium];
    const bResult = all.find(r => r.node.id === b.id);

    expect(bResult).toBeDefined();
    // B: 1.0 * 0.6 * 0.8 = 0.48 → medium (0.3-0.5)
    expect(bResult!.activation).toBeCloseTo(0.48, 10);
    // C: 0.48 * 0.6 * 0.9 = 0.2592 → below 0.3 threshold, excluded
    expect(all.find(r => r.node.id === c.id)).toBeUndefined();

    db.close();
  });

  it('skips superseded nodes with strength 0', () => {
    const db = freshDb();
    const a = makeNode(db, { name: 'A', strength: 1.0 });
    const b = makeNode(db, { name: 'B', strength: 0 });
    const c = makeNode(db, { name: 'C', strength: 1.0 });

    link(db, a.id, b.id, 1.0);
    link(db, b.id, c.id, 1.0);

    const results = spreadingActivation(db, [{ type: 'node', value: a.id }]);
    const all = [...results.high, ...results.medium];

    expect(all.find(r => r.node.id === b.id)).toBeUndefined();
    expect(all.find(r => r.node.id === c.id)).toBeUndefined();

    db.close();
  });

  it('partitions results into correct tiers', () => {
    const db = freshDb();
    const seed = makeNode(db, { name: 'seed', strength: 1.0 });
    const highNode = makeNode(db, { name: 'high-node', strength: 1.0 });
    const medNode = makeNode(db, { name: 'med-node', strength: 1.0 });

    // With decayFactor=1.0: activation = seed.strength * 1.0 * weight
    link(db, seed.id, highNode.id, 0.9);  // 1.0 * 1.0 * 0.9 = 0.9 → high (>0.5)
    link(db, seed.id, medNode.id, 0.5);   // 1.0 * 1.0 * 0.5 = 0.5 → medium (0.3-0.5, not >0.5)

    const results = spreadingActivation(
      db,
      [{ type: 'node', value: seed.id }],
      { decayFactor: 1.0 },
    );

    expect(results.high.map(r => r.node.name)).toEqual(['high-node']);
    expect(results.medium.map(r => r.node.name)).toEqual(['med-node']);

    db.close();
  });

  it('excludes nodes below activation threshold', () => {
    const db = freshDb();
    const a = makeNode(db, { name: 'A', strength: 1.0 });
    const b = makeNode(db, { name: 'B', strength: 1.0 });

    link(db, a.id, b.id, 0.1);
    // B activation = 1.0 * 0.6 * 0.1 = 0.06 < 0.1 threshold

    const results = spreadingActivation(db, [{ type: 'node', value: a.id }]);
    const all = [...results.high, ...results.medium];

    expect(all).toHaveLength(0);

    db.close();
  });

  it('resolves file path entry points via getNodesByFile', () => {
    const db = freshDb();
    const fileNode = makeNode(db, { name: 'file-concept', strength: 1.0, affectedFiles: ['src/main.ts'] });
    const neighbor = makeNode(db, { name: 'neighbor', strength: 1.0 });

    link(db, fileNode.id, neighbor.id, 1.0);

    const results = spreadingActivation(db, [{ type: 'file', value: 'src/main.ts' }]);
    const all = [...results.high, ...results.medium];

    expect(all.find(r => r.node.id === neighbor.id)).toBeDefined();
    expect(all.find(r => r.node.id === fileNode.id)).toBeUndefined();

    db.close();
  });

  it('resolves name entry points via getNodesByName', () => {
    const db = freshDb();
    const named = makeNode(db, { name: 'some-concept', strength: 1.0 });
    const neighbor = makeNode(db, { name: 'neighbor', strength: 1.0 });

    link(db, named.id, neighbor.id, 1.0);

    const results = spreadingActivation(db, [{ type: 'name', value: 'some-concept' }]);
    const all = [...results.high, ...results.medium];

    expect(all.find(r => r.node.id === neighbor.id)).toBeDefined();
    expect(all.find(r => r.node.id === named.id)).toBeUndefined();

    db.close();
  });

  it('uses max activation when node is reachable from multiple entry points', () => {
    const db = freshDb();
    const s1 = makeNode(db, { name: 'seed1', strength: 1.0 });
    const s2 = makeNode(db, { name: 'seed2', strength: 0.5 });
    const target = makeNode(db, { name: 'target', strength: 1.0 });

    link(db, s1.id, target.id, 1.0); // 1.0 * 0.6 * 1.0 = 0.6
    link(db, s2.id, target.id, 1.0); // 0.5 * 0.6 * 1.0 = 0.3

    const results = spreadingActivation(db, [
      { type: 'node', value: s1.id },
      { type: 'node', value: s2.id },
    ]);

    const all = [...results.high, ...results.medium];
    const targetResult = all.find(r => r.node.id === target.id);

    expect(targetResult).toBeDefined();
    expect(targetResult!.activation).toBeCloseTo(0.6, 10);

    db.close();
  });

  it('produces higher activation for higher edge weight at same distance', () => {
    const db = freshDb();
    const seed = makeNode(db, { name: 'seed', strength: 1.0 });
    const strong = makeNode(db, { name: 'strong', strength: 1.0 });
    const weak = makeNode(db, { name: 'weak', strength: 1.0 });

    link(db, seed.id, strong.id, 0.9);
    link(db, seed.id, weak.id, 0.6);

    const results = spreadingActivation(db, [{ type: 'node', value: seed.id }]);
    const all = [...results.high, ...results.medium];

    const strongResult = all.find(r => r.node.id === strong.id);
    const weakResult = all.find(r => r.node.id === weak.id);

    expect(strongResult).toBeDefined();
    expect(weakResult).toBeDefined();
    expect(strongResult!.activation).toBeGreaterThan(weakResult!.activation);
    // strong: 1.0 * 0.6 * 0.9 = 0.54 → high (>0.5)
    // weak: 1.0 * 0.6 * 0.6 = 0.36 → medium (0.3-0.5)
    expect(strongResult!.activation).toBeCloseTo(0.54, 10);
    expect(weakResult!.activation).toBeCloseTo(0.36, 10);

    db.close();
  });

  it('resolves name entry points via fuzzy fallback when exact match fails', () => {
    const db = freshDb();
    const named = makeNode(db, { name: 'Switch from Express to Fastify', strength: 1.0 });
    const neighbor = makeNode(db, { name: 'neighbor', strength: 1.0 });

    link(db, named.id, neighbor.id, 1.0);

    const results = spreadingActivation(db, [{ type: 'name', value: 'Express' }]);
    const all = [...results.high, ...results.medium];

    expect(all.find(r => r.node.id === neighbor.id)).toBeDefined();

    db.close();
  });

  it('prefers exact name match over fuzzy when both exist', () => {
    const db = freshDb();
    const exact = makeNode(db, { name: 'Express', strength: 1.0 });
    const fuzzy = makeNode(db, { name: 'Switch from Express to Fastify', strength: 1.0 });
    const exactNeighbor = makeNode(db, { name: 'exact-neighbor', strength: 1.0 });
    const fuzzyNeighbor = makeNode(db, { name: 'fuzzy-neighbor', strength: 1.0 });

    link(db, exact.id, exactNeighbor.id, 1.0);
    link(db, fuzzy.id, fuzzyNeighbor.id, 1.0);

    const results = spreadingActivation(db, [{ type: 'name', value: 'Express' }]);
    const all = [...results.high, ...results.medium];

    expect(all.find(r => r.node.id === exactNeighbor.id)).toBeDefined();
    expect(all.find(r => r.node.id === fuzzyNeighbor.id)).toBeUndefined();

    db.close();
  });
});
