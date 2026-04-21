import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getEmbedding, getDimensions, _resetLocalPipeline } from '../core/embed.js';

const originalFetch = globalThis.fetch;

describe('getDimensions', () => {
  it('returns correct dimensions for all known providers', () => {
    expect(getDimensions('voyage-3-lite')).toBe(512);
    expect(getDimensions('voyage-3')).toBe(1024);
    expect(getDimensions('openai')).toBe(1536);
    expect(getDimensions('text-embedding-3-small')).toBe(1536);
    expect(getDimensions('text-embedding-3-large')).toBe(3072);
    expect(getDimensions('local')).toBe(384);
    expect(getDimensions('ollama')).toBe(768);
  });

  it('returns 512 as default for unknown providers', () => {
    expect(getDimensions('unknown-provider')).toBe(512);
  });
});

describe('getEmbedding - HTTP providers', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('calls Voyage API for voyage-3-lite', async () => {
    const mockEmb = [[0.1, 0.2, 0.3]];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ embedding: mockEmb[0] }] }),
    });

    const result = await getEmbedding(['hello'], { provider: 'voyage-3-lite', apiKey: 'vk' });
    expect(result).toEqual(mockEmb);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      'https://api.voyageai.com/v1/embeddings',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('calls OpenAI API for text-embedding-3-small', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ embedding: [0.4, 0.5] }] }),
    });

    await getEmbedding(['test'], { provider: 'text-embedding-3-small', apiKey: 'ok' });
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      'https://api.openai.com/v1/embeddings',
      expect.anything(),
    );
  });

  it('throws when no API key for HTTP provider', async () => {
    delete process.env.VOYAGE_API_KEY;
    await expect(getEmbedding(['x'], { provider: 'voyage-3-lite' }))
      .rejects.toThrow(/No API key/);
  });

  it('throws on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    await expect(getEmbedding(['x'], { provider: 'voyage-3', apiKey: 'k' }))
      .rejects.toThrow(/500/);
  });
});

describe('getEmbedding - local provider', () => {
  beforeEach(() => {
    _resetLocalPipeline();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetLocalPipeline();
  });

  it('uses HF transformers pipeline for local provider', async () => {
    const mockOutput = { tolist: () => [[0.1, 0.2, 0.3]] };
    const mockPipeline = vi.fn().mockResolvedValue(mockOutput);
    const mockPipelineFactory = vi.fn().mockResolvedValue(mockPipeline);

    vi.doMock('@huggingface/transformers', () => ({
      pipeline: mockPipelineFactory,
    }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { getEmbedding: getEmb, _resetLocalPipeline: reset } = await import('../core/embed.js');
    reset();

    const result = await getEmb(['test text'], { provider: 'local' });

    expect(mockPipelineFactory).toHaveBeenCalledWith('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    expect(mockPipeline).toHaveBeenCalledWith(['test text'], { pooling: 'mean', normalize: true });
    expect(result).toEqual([[0.1, 0.2, 0.3]]);
    expect(consoleSpy).toHaveBeenCalledWith('Downloading local embedding model...');

    consoleSpy.mockRestore();
    reset();
    vi.doUnmock('@huggingface/transformers');
  });
});

describe('getEmbedding - Ollama provider', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls Ollama API with correct format', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embedding: [0.1, 0.2, 0.3] }),
    });

    const result = await getEmbedding(['hello'], {
      provider: 'ollama',
      ollamaUrl: 'http://localhost:11434',
    });

    expect(result).toEqual([[0.1, 0.2, 0.3]]);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      'http://localhost:11434/api/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'hello' }),
      }),
    );
  });

  it('handles multiple texts by calling Ollama per-text', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ embedding: [callCount * 0.1] }),
      });
    });

    const result = await getEmbedding(['a', 'b', 'c'], { provider: 'ollama' });

    expect(result).toHaveLength(3);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(3);
  });

  it('throws with actionable message on connection failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(getEmbedding(['x'], { provider: 'ollama' }))
      .rejects.toThrow(/Is Ollama running\? Start with: ollama serve/);
  });

  it('throws on Ollama API error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('model not found'),
    });

    await expect(getEmbedding(['x'], { provider: 'ollama' }))
      .rejects.toThrow(/Ollama API error 404/);
  });

  it('throws on malformed Ollama response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await expect(getEmbedding(['x'], { provider: 'ollama' }))
      .rejects.toThrow(/malformed response/);
  });
});

describe('getEmbedding - zero-config smoke tests', () => {
  afterEach(() => {
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('local provider works without any API key env vars', async () => {
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;

    _resetLocalPipeline();

    const mockOutput = { tolist: () => [[0.1, 0.2, 0.3]] };
    const mockPipeline = vi.fn().mockResolvedValue(mockOutput);
    const mockPipelineFactory = vi.fn().mockResolvedValue(mockPipeline);

    vi.doMock('@huggingface/transformers', () => ({
      pipeline: mockPipelineFactory,
    }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { getEmbedding: getEmb, _resetLocalPipeline: reset } = await import('../core/embed.js');
    reset();

    const result = await getEmb(['zero config test'], { provider: 'local' });
    expect(result).toEqual([[0.1, 0.2, 0.3]]);

    consoleSpy.mockRestore();
    reset();
    vi.doUnmock('@huggingface/transformers');
  });
});

describe('provider dimension consistency', () => {
  it('getDimensions matches expected values for all multi-provider types', () => {
    expect(getDimensions('local')).toBe(384);
    expect(getDimensions('ollama')).toBe(768);
    expect(getDimensions('voyage-3-lite')).toBe(512);
    expect(getDimensions('voyage-3')).toBe(1024);
    expect(getDimensions('text-embedding-3-small')).toBe(1536);
    expect(getDimensions('text-embedding-3-large')).toBe(3072);
  });

  it('unknown provider falls back to 512 (backward-compatible default)', () => {
    expect(getDimensions('some-future-provider')).toBe(512);
    expect(getDimensions('')).toBe(512);
  });
});
