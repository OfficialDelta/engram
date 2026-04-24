import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-rel-'));
  fs.mkdirSync(path.join(tmpDir, 'events'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- processStop API key validation ---

vi.mock('../core/consolidation.js', () => ({
  findUnconsolidatedSessions: vi.fn(() => []),
  spawnConsolidation: vi.fn(),
  findFailedConsolidations: vi.fn(() => []),
}));

vi.mock('../core/config.js', () => ({
  loadConfig: vi.fn(() => ({
    llm: {},
    embedding: {},
    consolidation: { turnThreshold: 1, eventThreshold: 1 },
  })),
  getConfigPath: vi.fn(() => '/tmp/fake-config.json'),
}));

vi.mock('../core/event-stream.js', () => ({
  buildTurnCompleteEvent: vi.fn(() => ({
    type: 'turn_complete',
    sessionId: 'sess-1',
    timestamp: new Date().toISOString(),
    turnCount: 1,
    toolCallCount: 0,
  })),
  appendEvent: vi.fn(),
  getSessionEvents: vi.fn(() => Array.from({ length: 100 }, () => ({}))),
  classifyToolCall: vi.fn(() => ({ type: 'file_read', sessionId: 'test', timestamp: new Date().toISOString(), filePath: '/test' })),
}));

vi.mock('../core/session-state.js', () => ({
  loadSessionState: vi.fn(() => ({ turnCount: 5, toolCallCount: 3, startedAt: new Date().toISOString() })),
  saveSessionState: vi.fn(),
}));

vi.mock('../db/migrations.js', () => ({
  initializeSchema: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock('../core/context-builder.js', () => ({
  buildContext: vi.fn(() => ''),
}));

vi.mock('../core/retrieval.js', () => ({
  spreadingActivation: vi.fn(() => ({ high: [], medium: [] })),
}));

describe('processPostCompact API key validation', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('skips consolidation when no API key configured', async () => {
    const { loadConfig } = await import('../core/config.js');
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      llm: {},
      embedding: {},
      consolidation: { turnThreshold: 1, eventThreshold: 1 },
    });

    const { spawnConsolidation } = await import('../core/consolidation.js');
    const { processPostCompact } = await import('../adapters/claude-code/post-compact.js');

    processPostCompact('sess-1', tmpDir, path.join(tmpDir, 'engram.db'));

    expect(spawnConsolidation).not.toHaveBeenCalled();
  });

  it('spawns consolidation when config has API key', async () => {
    const { loadConfig } = await import('../core/config.js');
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      llm: { apiKey: 'sk-test-key' },
      embedding: {},
      consolidation: { turnThreshold: 1, eventThreshold: 1 },
    });

    const { spawnConsolidation } = await import('../core/consolidation.js');
    const { processPostCompact } = await import('../adapters/claude-code/post-compact.js');

    processPostCompact('sess-1', tmpDir, path.join(tmpDir, 'engram.db'));

    expect(spawnConsolidation).toHaveBeenCalled();
  });

  it('spawns consolidation when ANTHROPIC_API_KEY env var is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env-key';

    const { loadConfig } = await import('../core/config.js');
    (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      llm: {},
      embedding: {},
      consolidation: { turnThreshold: 1, eventThreshold: 1 },
    });

    const { spawnConsolidation } = await import('../core/consolidation.js');
    const { processPostCompact } = await import('../adapters/claude-code/post-compact.js');

    processPostCompact('sess-1', tmpDir, path.join(tmpDir, 'engram.db'));

    expect(spawnConsolidation).toHaveBeenCalled();
  });
});

// --- findUnconsolidatedSessions and findFailedConsolidations ---
// These test the real (unmocked) functions, so we import from the source directly.

describe('findUnconsolidatedSessions (real implementation)', () => {
  // Import the real source to test. vi.mock is hoisted so we use dynamic import with
  // vi.importActual to get the real module.

  it('excludes sessions with .failed.json markers', async () => {
    const mod = await vi.importActual<typeof import('../core/consolidation.js')>('../core/consolidation.js');

    // Create event files for 3 sessions
    fs.writeFileSync(path.join(tmpDir, 'events', 'sess-a.jsonl'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'events', 'sess-b.jsonl'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'events', 'sess-c.jsonl'), '{}');

    // sess-a is consolidated, sess-b is failed, sess-c is pending
    fs.mkdirSync(path.join(tmpDir, 'episodes'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'episodes', 'sess-a.episode.json'), '{}');
    fs.writeFileSync(
      path.join(tmpDir, 'episodes', 'sess-b.failed.json'),
      JSON.stringify({ sessionId: 'sess-b', error: 'API error', timestamp: '2026-01-01T00:00:00Z' }),
    );

    const result = mod.findUnconsolidatedSessions(tmpDir);
    expect(result).toEqual(['sess-c']);
  });

  it('returns all sessions when no episodes dir exists', async () => {
    const mod = await vi.importActual<typeof import('../core/consolidation.js')>('../core/consolidation.js');
    fs.writeFileSync(path.join(tmpDir, 'events', 'sess-x.jsonl'), '{}');

    const result = mod.findUnconsolidatedSessions(tmpDir);
    expect(result).toEqual(['sess-x']);
  });
});

describe('findFailedConsolidations', () => {
  it('returns parsed failure markers', async () => {
    const mod = await vi.importActual<typeof import('../core/consolidation.js')>('../core/consolidation.js');

    fs.mkdirSync(path.join(tmpDir, 'episodes'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'episodes', 'sess-1.failed.json'),
      JSON.stringify({ sessionId: 'sess-1', error: 'Connection timeout', timestamp: '2026-01-01T00:00:00Z' }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'episodes', 'sess-2.failed.json'),
      JSON.stringify({ sessionId: 'sess-2', error: 'Rate limited', timestamp: '2026-01-02T00:00:00Z' }),
    );

    const results = mod.findFailedConsolidations(tmpDir);
    expect(results).toHaveLength(2);
    expect(results).toEqual(
      expect.arrayContaining([
        { sessionId: 'sess-1', error: 'Connection timeout', timestamp: '2026-01-01T00:00:00Z' },
        { sessionId: 'sess-2', error: 'Rate limited', timestamp: '2026-01-02T00:00:00Z' },
      ]),
    );
  });

  it('returns empty array when no episodes directory exists', async () => {
    const mod = await vi.importActual<typeof import('../core/consolidation.js')>('../core/consolidation.js');
    const result = mod.findFailedConsolidations(tmpDir);
    expect(result).toEqual([]);
  });

  it('skips malformed .failed.json files', async () => {
    const mod = await vi.importActual<typeof import('../core/consolidation.js')>('../core/consolidation.js');

    fs.mkdirSync(path.join(tmpDir, 'episodes'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'episodes', 'sess-bad.failed.json'), 'not valid json {{{');
    fs.writeFileSync(
      path.join(tmpDir, 'episodes', 'sess-good.failed.json'),
      JSON.stringify({ sessionId: 'sess-good', error: 'Error', timestamp: '2026-01-01T00:00:00Z' }),
    );

    const results = mod.findFailedConsolidations(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.sessionId).toBe('sess-good');
  });
});

// --- processSessionStart failure surfacing ---

describe('processSessionStart failure surfacing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes warning when failed consolidations exist', async () => {
    const { findFailedConsolidations } = await import('../core/consolidation.js');
    (findFailedConsolidations as ReturnType<typeof vi.fn>).mockReturnValue([
      { sessionId: 'sess-a', error: 'Connection timeout', timestamp: '2026-01-01T00:00:00Z' },
      { sessionId: 'sess-b', error: 'Rate limited', timestamp: '2026-01-02T00:00:00Z' },
    ]);

    const { processSessionStart } = await import('../adapters/claude-code/session-start.js');
    const result = processSessionStart('new-sess', tmpDir, path.join(tmpDir, 'engram.db'));

    const ctx = (result as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('2 previous consolidation(s) failed');
    expect(ctx).toContain('Rate limited');
    expect(ctx).toContain('engram status');
    expect(ctx).toContain('.failed.json');
  });

  it('works normally when no failures exist', async () => {
    const { findFailedConsolidations } = await import('../core/consolidation.js');
    (findFailedConsolidations as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const { processSessionStart } = await import('../adapters/claude-code/session-start.js');
    const result = processSessionStart('new-sess', tmpDir, path.join(tmpDir, 'engram.db'));

    const ctx = (result as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).not.toContain('consolidation(s) failed');
  });
});
