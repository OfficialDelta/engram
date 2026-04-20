import { describe, it, expect, vi, afterEach } from 'vitest';
import { initializeSchema } from '../db/migrations.js';
import { storeEmbedding, findSimilar } from '../db/embeddings.js';
import { getEmbedding } from '../core/embed.js';

function freshDb() {
  return initializeSchema(':memory:');
}

function unitVector(dim: number, index: number): number[] {
  const v = new Array(dim).fill(0);
  v[index] = 1;
  return v;
}

function angledVector(dim: number, cosTheta: number): number[] {
  const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
  const v = new Array(dim).fill(0);
  v[0] = cosTheta;
  v[1] = sinTheta;
  return v;
}

describe('embedding storage and vector search', () => {
  it('round-trips storeEmbedding + findSimilar with same vector', () => {
    const db = freshDb();
    const vec = unitVector(512, 0);

    storeEmbedding(db, 'n1', vec);
    const results = findSimilar(db, vec, 0.5, 10);

    expect(results).toHaveLength(1);
    expect(results[0]!.nodeId).toBe('n1');
    expect(results[0]!.distance).toBeCloseTo(0, 4);
    expect(results[0]!.similarity).toBeCloseTo(1, 4);

    db.close();
  });

  it('computes correct cosine distance for known angle', () => {
    const db = freshDb();
    const v1 = unitVector(512, 0);
    const v2 = angledVector(512, 0.8);

    storeEmbedding(db, 'n1', v1);
    storeEmbedding(db, 'n2', v2);

    const results = findSimilar(db, v1, 0.5, 10);

    expect(results).toHaveLength(2);
    const n1Result = results.find(r => r.nodeId === 'n1')!;
    const n2Result = results.find(r => r.nodeId === 'n2')!;

    expect(n1Result.distance).toBeCloseTo(0, 4);
    expect(n2Result.distance).toBeCloseTo(1 - 0.8, 2);
    expect(n2Result.similarity).toBeCloseTo(0.8, 2);

    db.close();
  });

  it('filters results by similarity threshold', () => {
    const db = freshDb();
    const query = unitVector(512, 0);
    const high = angledVector(512, 0.95);
    const mid = angledVector(512, 0.75);
    const low = angledVector(512, 0.50);

    storeEmbedding(db, 'high', high);
    storeEmbedding(db, 'mid', mid);
    storeEmbedding(db, 'low', low);

    const strict = findSimilar(db, query, 0.8, 10);
    expect(strict).toHaveLength(1);
    expect(strict[0]!.nodeId).toBe('high');

    const relaxed = findSimilar(db, query, 0.6, 10);
    expect(relaxed).toHaveLength(2);
    const ids = relaxed.map(r => r.nodeId).sort();
    expect(ids).toEqual(['high', 'mid']);

    db.close();
  });

  it('replaces embedding on INSERT OR REPLACE', () => {
    const db = freshDb();
    const v1 = unitVector(512, 0);
    const v2 = unitVector(512, 1);

    storeEmbedding(db, 'n1', v1);
    storeEmbedding(db, 'n1', v2);

    const fromV1 = findSimilar(db, v1, 0.5, 10);
    const fromV2 = findSimilar(db, v2, 0.5, 10);

    expect(fromV1).toHaveLength(0);
    expect(fromV2).toHaveLength(1);
    expect(fromV2[0]!.nodeId).toBe('n1');

    db.close();
  });

  it('returns empty array when no results meet threshold', () => {
    const db = freshDb();
    const v1 = unitVector(512, 0);
    const v2 = unitVector(512, 1);

    storeEmbedding(db, 'n1', v2);

    const results = findSimilar(db, v1, 0.99, 10);
    expect(results).toEqual([]);

    db.close();
  });
});

describe('getEmbedding API wrapper', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('calls Voyage API with correct URL and headers', async () => {
    const mockEmbedding = [0.1, 0.2, 0.3];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ embedding: mockEmbedding }] }),
    });

    const result = await getEmbedding(['hello'], { provider: 'voyage-3-lite', apiKey: 'test-key' });

    expect(result).toEqual([mockEmbedding]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.voyageai.com/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      }),
    );

    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const body = JSON.parse(callArgs[1]!.body as string);
    expect(body.model).toBe('voyage-3-lite');
    expect(body.input).toEqual(['hello']);
  });

  it('calls OpenAI API with correct URL for text-embedding provider', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ embedding: [0.4, 0.5] }] }),
    });

    await getEmbedding(['test'], { provider: 'text-embedding-3-small', apiKey: 'oai-key' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/embeddings',
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer oai-key' },
      }),
    );
  });

  it('throws on API error without leaking API key', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized: invalid key'),
    });

    const secret = 'sk-secret-key-12345';
    const error = await getEmbedding(['x'], { provider: 'voyage-3-lite', apiKey: secret })
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/401/);
    expect((error as Error).message).not.toContain(secret);
  });

  it('throws when no API key is available', async () => {
    delete process.env.VOYAGE_API_KEY;

    await expect(getEmbedding(['x'], { provider: 'voyage-3-lite' }))
      .rejects.toThrow(/No API key/);
  });
});
