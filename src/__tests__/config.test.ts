import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadConfig,
  saveConfig,
  validateConfig,
  maskApiKey,
  getConfigPath,
  type EngramConfig,
} from '../core/config.js';

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-config-test-'));
  configPath = path.join(tmpDir, 'config.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ENGRAM_EMBEDDING_PROVIDER;
});

describe('getConfigPath', () => {
  it('returns expected path under ~/.engram/', () => {
    const p = getConfigPath();
    expect(p).toBe(path.join(os.homedir(), '.engram', 'config.json'));
  });
});

describe('loadConfig', () => {
  it('returns defaults when no file exists', () => {
    const config = loadConfig(path.join(tmpDir, 'nonexistent.json'));
    expect(config).toEqual({ llm: {}, embedding: {}, consolidation: {} });
  });

  it('reads and parses a valid config file', () => {
    const fileConfig = {
      llm: { pass1Model: 'claude-sonnet-4-20250514' },
      embedding: { provider: 'voyage-3-lite' },
      consolidation: { windowSize: 15 },
    };
    fs.writeFileSync(configPath, JSON.stringify(fileConfig));
    const config = loadConfig(configPath);
    expect(config.llm.pass1Model).toBe('claude-sonnet-4-20250514');
    expect(config.embedding.provider).toBe('voyage-3-lite');
    expect(config.consolidation.windowSize).toBe(15);
  });

  it('env vars override file values', () => {
    const fileConfig: EngramConfig = {
      llm: { apiKey: 'file-key' },
      embedding: { provider: 'voyage-3-lite', apiKey: 'file-voyage-key' },
      consolidation: {},
    };
    fs.writeFileSync(configPath, JSON.stringify(fileConfig));

    process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';
    process.env.VOYAGE_API_KEY = 'env-voyage-key';

    const config = loadConfig(configPath);
    expect(config.llm.apiKey).toBe('env-anthropic-key');
    expect(config.embedding.apiKey).toBe('env-voyage-key');
  });

  it('OPENAI_API_KEY overrides when provider is openai', () => {
    const fileConfig: EngramConfig = {
      llm: {},
      embedding: { provider: 'openai' },
      consolidation: {},
    };
    fs.writeFileSync(configPath, JSON.stringify(fileConfig));
    process.env.OPENAI_API_KEY = 'env-openai-key';

    const config = loadConfig(configPath);
    expect(config.embedding.apiKey).toBe('env-openai-key');
  });

  it('ENGRAM_EMBEDDING_PROVIDER overrides file provider', () => {
    const fileConfig: EngramConfig = {
      llm: {},
      embedding: { provider: 'voyage-3-lite' },
      consolidation: {},
    };
    fs.writeFileSync(configPath, JSON.stringify(fileConfig));
    process.env.ENGRAM_EMBEDDING_PROVIDER = 'openai';

    const config = loadConfig(configPath);
    expect(config.embedding.provider).toBe('openai');
  });

  it('handles malformed JSON gracefully (returns defaults)', () => {
    fs.writeFileSync(configPath, 'not valid json{{{');
    const stderrSpy: string[] = [];
    const orig = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrSpy.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    const config = loadConfig(configPath);

    process.stderr.write = orig;
    expect(config).toEqual({ llm: {}, embedding: {}, consolidation: {} });
    expect(stderrSpy.some(s => s.includes('using defaults'))).toBe(true);
  });

  it('handles empty file gracefully', () => {
    fs.writeFileSync(configPath, '');
    const config = loadConfig(configPath);
    expect(config).toEqual({ llm: {}, embedding: {}, consolidation: {} });
  });

  it('handles non-object root (array) gracefully', () => {
    fs.writeFileSync(configPath, '[]');
    const config = loadConfig(configPath);
    expect(config).toEqual({ llm: {}, embedding: {}, consolidation: {} });
  });

  it('partial config merges correctly with defaults', () => {
    fs.writeFileSync(configPath, JSON.stringify({ llm: { pass1Model: 'fast' } }));
    const config = loadConfig(configPath);
    expect(config.llm.pass1Model).toBe('fast');
    expect(config.embedding).toEqual({});
    expect(config.consolidation).toEqual({});
  });

  it('empty object returns defaults', () => {
    fs.writeFileSync(configPath, '{}');
    const config = loadConfig(configPath);
    expect(config).toEqual({ llm: {}, embedding: {}, consolidation: {} });
  });
});

describe('saveConfig', () => {
  it('writes valid JSON that loadConfig can read back', () => {
    const config: EngramConfig = {
      llm: { apiKey: 'sk-test', pass1Model: 'claude-sonnet-4-20250514' },
      embedding: { provider: 'voyage-3-lite', apiKey: 'va-test' },
      consolidation: { windowSize: 10, windowOverlap: 3 },
    };
    saveConfig(config, configPath);

    const loaded = loadConfig(configPath);
    expect(loaded.llm.apiKey).toBe('sk-test');
    expect(loaded.embedding.provider).toBe('voyage-3-lite');
    expect(loaded.consolidation.windowSize).toBe(10);
  });

  it('creates parent directories if needed', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'config.json');
    saveConfig({ llm: {}, embedding: {}, consolidation: {} }, nested);
    expect(fs.existsSync(nested)).toBe(true);
  });
});

describe('validateConfig', () => {
  it('accepts valid config', () => {
    const result = validateConfig({
      llm: { pass1Model: 'claude-sonnet-4-20250514' },
      embedding: { provider: 'voyage-3-lite' },
      consolidation: { windowSize: 10 },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects non-object input', () => {
    expect(validateConfig(null).valid).toBe(false);
    expect(validateConfig('string').valid).toBe(false);
    expect(validateConfig([]).valid).toBe(false);
  });

  it('rejects unknown embedding provider', () => {
    const result = validateConfig({ embedding: { provider: 'unknown-provider' } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Unknown embedding provider/);
  });

  it('rejects non-numeric consolidation threshold', () => {
    const result = validateConfig({ consolidation: { windowSize: 'big' } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/windowSize must be a positive number/);
  });

  it('rejects negative consolidation threshold', () => {
    const result = validateConfig({ consolidation: { turnThreshold: -1 } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/turnThreshold must be a positive number/);
  });

  it('rejects zero consolidation threshold', () => {
    const result = validateConfig({ consolidation: { eventThreshold: 0 } });
    expect(result.valid).toBe(false);
  });

  it('accepts empty object', () => {
    const result = validateConfig({});
    expect(result.valid).toBe(true);
  });
});

describe('maskApiKey', () => {
  it('masks all but last 4 chars', () => {
    expect(maskApiKey('sk-1234567890abcdef')).toBe('****cdef');
  });

  it('returns **** for short keys', () => {
    expect(maskApiKey('abc')).toBe('****');
    expect(maskApiKey('abcd')).toBe('****');
  });

  it('handles 5-char key', () => {
    expect(maskApiKey('12345')).toBe('****2345');
  });
});

describe('integration: full config round-trip', () => {
  it('saveConfig then loadConfig preserves all fields across all sections', () => {
    const full: EngramConfig = {
      llm: { apiKey: 'sk-roundtrip', pass1Model: 'claude-sonnet-4-20250514', pass2Model: 'claude-opus-4-20250514' },
      embedding: { provider: 'voyage-3-lite', apiKey: 'va-roundtrip', ollamaUrl: 'http://localhost:11434' },
      consolidation: { turnThreshold: 8, eventThreshold: 80, windowSize: 20, windowOverlap: 5 },
    };
    saveConfig(full, configPath);
    const loaded = loadConfig(configPath);
    expect(loaded.llm).toEqual(full.llm);
    expect(loaded.embedding).toEqual(full.embedding);
    expect(loaded.consolidation).toEqual(full.consolidation);
  });
});

describe('integration: env var precedence over config file', () => {
  it('ANTHROPIC_API_KEY env var wins over config file llm.apiKey', () => {
    const fileConfig: EngramConfig = {
      llm: { apiKey: 'file-key-should-lose' },
      embedding: {},
      consolidation: {},
    };
    saveConfig(fileConfig, configPath);
    process.env.ANTHROPIC_API_KEY = 'env-key-should-win';
    const loaded = loadConfig(configPath);
    expect(loaded.llm.apiKey).toBe('env-key-should-win');
  });
});
