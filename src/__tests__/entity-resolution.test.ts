import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initializeSchema } from '../db/migrations.js';
import { createNode } from '../db/graph.js';
import { storeEmbedding } from '../db/embeddings.js';
import { resolveEntity, shouldUpdateDescription } from '../core/entity-resolution.js';
import type BetterSqlite3 from 'better-sqlite3';

vi.mock('../core/embed.js', () => ({
  getEmbedding: vi.fn(),
}));

import { getEmbedding } from '../core/embed.js';
const mockGetEmbedding = vi.mocked(getEmbedding);

const DIM = 512;

function makeBaseVector(): number[] {
  const v = new Array(DIM).fill(0);
  v[0] = 1.0;
  return v;
}

function makeVectorWithSimilarity(similarity: number): number[] {
  const v = new Array(DIM).fill(0);
  v[0] = similarity;
  v[1] = Math.sqrt(1 - similarity * similarity);
  return v;
}

function seedNode(db: BetterSqlite3.Database, name: string, embedding: number[]): string {
  const node = createNode(db, {
    name,
    nodeType: 'concept',
    description: `Description of ${name}`,
    affectedFiles: [],
    strength: 1.0,
    metadata: {},
  });
  storeEmbedding(db, node.id, embedding);
  return node.id;
}

describe('resolveEntity', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = initializeSchema(':memory:');
    vi.clearAllMocks();
  });

  it('returns merge when similarity > 0.95', async () => {
    const nodeId = seedNode(db, 'existing-concept', makeBaseVector());
    mockGetEmbedding.mockResolvedValueOnce([makeVectorWithSimilarity(0.98)]);

    const result = await resolveEntity(db, 'similar concept', 'description');

    expect(result.action).toBe('merge');
    expect(result.existingNodeId).toBe(nodeId);
    expect(result.similarity).toBeGreaterThan(0.95);
  });

  it('returns create_child when similarity is 0.80-0.95', async () => {
    const nodeId = seedNode(db, 'existing-concept', makeBaseVector());
    mockGetEmbedding.mockResolvedValueOnce([makeVectorWithSimilarity(0.90)]);

    const result = await resolveEntity(db, 'related concept', 'description');

    expect(result.action).toBe('create_child');
    expect(result.existingNodeId).toBe(nodeId);
    expect(result.similarity).toBeGreaterThanOrEqual(0.80);
    expect(result.similarity).toBeLessThanOrEqual(0.95);
  });

  it('returns create_new when similarity < 0.80', async () => {
    seedNode(db, 'existing-concept', makeBaseVector());
    mockGetEmbedding.mockResolvedValueOnce([makeVectorWithSimilarity(0.50)]);

    const result = await resolveEntity(db, 'unrelated concept', 'description');

    expect(result.action).toBe('create_new');
    expect(result.existingNodeId).toBeUndefined();
    expect(result.similarity).toBeUndefined();
  });

  it('returns create_new when graph is empty', async () => {
    mockGetEmbedding.mockResolvedValueOnce([makeBaseVector()]);

    const result = await resolveEntity(db, 'new concept', 'description');

    expect(result.action).toBe('create_new');
    expect(result.existingNodeId).toBeUndefined();
  });

  it('picks the most similar node among multiple candidates', async () => {
    const nodeA = seedNode(db, 'concept-a', makeBaseVector());

    const secondVec = new Array(DIM).fill(0);
    secondVec[0] = 0.85;
    secondVec[1] = Math.sqrt(1 - 0.85 * 0.85);
    seedNode(db, 'concept-b', secondVec);

    mockGetEmbedding.mockResolvedValueOnce([makeVectorWithSimilarity(0.98)]);

    const result = await resolveEntity(db, 'very similar', 'description');

    expect(result.action).toBe('merge');
    expect(result.existingNodeId).toBe(nodeA);
    expect(result.similarity).toBeGreaterThan(0.95);
  });
});

describe('shouldUpdateDescription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false for identical strings without embedding call', async () => {
    const result = await shouldUpdateDescription('same text', 'same text');
    expect(result).toBe(false);
    expect(mockGetEmbedding).not.toHaveBeenCalled();
  });

  it('returns false when cosine similarity > 0.9', async () => {
    const v1 = makeBaseVector();
    const v2 = makeVectorWithSimilarity(0.95);
    mockGetEmbedding.mockResolvedValueOnce([v1, v2]);

    const result = await shouldUpdateDescription('description A', 'description B');
    expect(result).toBe(false);
  });

  it('returns true when cosine similarity < 0.9', async () => {
    const v1 = makeBaseVector();
    const v2 = makeVectorWithSimilarity(0.5);
    mockGetEmbedding.mockResolvedValueOnce([v1, v2]);

    const result = await shouldUpdateDescription('entry module', 'error handling');
    expect(result).toBe(true);
  });
});
