import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StatusResult } from '../cli/status.js';

vi.mock('../core/config.js', () => ({
  loadConfig: vi.fn(() => ({
    llm: { apiKey: 'sk-test-key-1234' },
    embedding: { provider: 'voyage-3-lite' },
    consolidation: {},
  })),
  maskApiKey: vi.fn((k: string) => '****' + k.slice(-4)),
}));

vi.mock('../core/consolidation.js', () => ({
  findUnconsolidatedSessions: vi.fn(() => ['sess-1', 'sess-2']),
  findFailedConsolidations: vi.fn(() => [
    { sessionId: 'sess-fail-1', error: 'API rate limit', timestamp: '2026-04-20T10:00:00Z' },
  ]),
  spawnConsolidation: vi.fn(),
}));

vi.mock('../core/project-identity.js', () => ({
  getDataDir: vi.fn((cwd: string) => cwd + '/.engram'),
  getDbPath: vi.fn((cwd: string) => cwd + '/.engram/memory.db'),
}));

vi.mock('../db/migrations.js', () => ({
  Database: vi.fn(() => ({
    prepare: vi.fn(() => ({ get: vi.fn(() => ({ count: 0, last: null })) })),
    close: vi.fn(),
  })),
}));

const { loadConfig } = await import('../core/config.js');
const { findUnconsolidatedSessions, findFailedConsolidations } = await import('../core/consolidation.js');

describe('runStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes config validity when API key present', async () => {
    vi.mocked(loadConfig).mockReturnValue({
      llm: { apiKey: 'sk-real-key-5678' },
      embedding: { provider: 'voyage-3-lite' },
      consolidation: {},
    });
    vi.mocked(findUnconsolidatedSessions).mockReturnValue([]);
    vi.mocked(findFailedConsolidations).mockReturnValue([]);

    const { runStatus } = await import('../cli/status.js');
    const result = runStatus({ claudeConfigDir: '/tmp/fake-claude', cwd: '/tmp/fake-project' });
    expect(result.configValid).toBe(true);
    expect(result.embeddingProvider).toBe('voyage-3-lite');
  });

  it('shows config invalid when no API key', async () => {
    vi.mocked(loadConfig).mockReturnValue({
      llm: {},
      embedding: {},
      consolidation: {},
    });

    const { runStatus } = await import('../cli/status.js');
    const result = runStatus({ claudeConfigDir: '/tmp/fake-claude', cwd: '/tmp/fake-project' });
    expect(result.configValid).toBe(false);
  });

  it('includes pending and failed consolidation counts', async () => {
    vi.mocked(loadConfig).mockReturnValue({
      llm: { apiKey: 'sk-key' },
      embedding: {},
      consolidation: {},
    });
    vi.mocked(findUnconsolidatedSessions).mockReturnValue(['s1', 's2', 's3']);
    vi.mocked(findFailedConsolidations).mockReturnValue([
      { sessionId: 'f1', error: 'timeout', timestamp: '2026-04-20T12:00:00Z' },
      { sessionId: 'f2', error: 'rate limit', timestamp: '2026-04-20T13:00:00Z' },
    ]);

    const { runStatus } = await import('../cli/status.js');
    const result = runStatus({ claudeConfigDir: '/tmp/fake-claude', cwd: '/tmp/fake-project' });
    expect(result.pendingConsolidations).toBe(3);
    expect(result.failedConsolidations).toHaveLength(2);
  });

  it('gracefully degrades when loadConfig throws', async () => {
    vi.mocked(loadConfig).mockImplementation(() => { throw new Error('corrupt config'); });
    vi.mocked(findUnconsolidatedSessions).mockReturnValue([]);
    vi.mocked(findFailedConsolidations).mockReturnValue([]);

    const { runStatus } = await import('../cli/status.js');
    const result = runStatus({ claudeConfigDir: '/tmp/fake-claude', cwd: '/tmp/fake-project' });
    expect(result.configValid).toBe(false);
    expect(result.embeddingProvider).toBeNull();
  });
});

describe('formatStatus', () => {
  it('renders config and consolidation sections', async () => {
    const { formatStatus } = await import('../cli/status.js');
    const result: StatusResult = {
      dataDir: '/tmp/.engram',
      dataDirExists: true,
      dbPath: '/tmp/.engram/memory.db',
      dbExists: true,
      nodes: 10,
      edges: 5,
      episodes: 3,
      lastConsolidation: '2026-04-20T10:00:00Z',
      hooksRegistered: ['PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop'],
      hooksMissing: [],
      configValid: true,
      embeddingProvider: 'voyage-3-lite',
      pendingConsolidations: 2,
      failedConsolidations: [
        { sessionId: 'sess-1', error: 'API rate limit exceeded', timestamp: '2026-04-20T09:00:00Z' },
      ],
    };

    const output = formatStatus(result);
    expect(output).toContain('Config:');
    expect(output).toContain('API key:            configured');
    expect(output).toContain('Embedding provider: voyage-3-lite');
    expect(output).toContain('Consolidation:');
    expect(output).toContain('Pending: 2');
    expect(output).toContain('Failed:  1');
    expect(output).toContain('Recent error: [sess-1] API rate limit exceeded');
  });

  it('shows not configured when configValid is false', async () => {
    const { formatStatus } = await import('../cli/status.js');
    const result: StatusResult = {
      dataDir: '/tmp/.engram',
      dataDirExists: true,
      dbPath: '/tmp/.engram/memory.db',
      dbExists: false,
      nodes: null,
      edges: null,
      episodes: null,
      lastConsolidation: null,
      hooksRegistered: [],
      hooksMissing: ['PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop'],
      configValid: false,
      embeddingProvider: null,
      pendingConsolidations: 0,
      failedConsolidations: [],
    };

    const output = formatStatus(result);
    expect(output).toContain('not configured — run engram config');
    expect(output).toContain('Embedding provider: none');
    expect(output).toContain('Pending: 0');
    expect(output).toContain('Failed:  0');
    expect(output).not.toContain('Recent error');
  });
});
