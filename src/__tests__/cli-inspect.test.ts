import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InspectResult } from '../cli/inspect.js';

const mockAll = vi.fn();
const mockGet = vi.fn();
const mockClose = vi.fn();

vi.mock('../core/project-identity.js', () => ({
  getDataDir: vi.fn((cwd: string) => cwd + '/.engram'),
  getDbPath: vi.fn((cwd: string) => cwd + '/.engram/memory.db'),
}));

vi.mock('../db/migrations.js', () => ({
  Database: vi.fn(function () {
    return {
      prepare: vi.fn(() => ({ get: mockGet, all: mockAll })),
      close: mockClose,
    };
  }),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

const { existsSync } = await import('node:fs');
const { Database } = await import('../db/migrations.js');

describe('runInspect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);

    mockGet.mockReturnValue({ count: 0 });
    mockAll.mockReturnValue([]);
  });

  it('returns correct counts from mock DB', async () => {
    let callCount = 0;
    mockGet.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return { count: 42 };
      if (callCount === 2) return { count: 15 };
      if (callCount === 3) return { count: 7 };
      return { count: 0 };
    });
    mockAll.mockReturnValue([]);

    const { runInspect } = await import('../cli/inspect.js');
    const result = runInspect({ cwd: '/tmp/test-project' });

    expect(result.totalNodes).toBe(42);
    expect(result.totalEdges).toBe(15);
    expect(result.totalEpisodes).toBe(7);
    expect(result.dbPath).toBe('/tmp/test-project/.engram/memory.db');
    expect(mockClose).toHaveBeenCalled();
  });

  it('passes correct LIMIT for --top N', async () => {
    mockGet.mockReturnValue({ count: 0 });
    mockAll.mockReturnValue([]);

    const mockPrepare = vi.fn(() => ({ get: mockGet, all: mockAll }));
    vi.mocked(Database).mockImplementation(function () {
      return {
        prepare: mockPrepare,
        close: mockClose,
      } as any;
    });

    const { runInspect } = await import('../cli/inspect.js');
    runInspect({ cwd: '/tmp/test-project', top: 5 });

    const highStrengthCall = mockPrepare.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('strength > 0.7'),
    );
    expect(highStrengthCall).toBeDefined();

    const allCalls = mockAll.mock.calls;
    const limitCall = allCalls.find((c) => c.length > 0 && c[c.length - 1] === 5);
    expect(limitCall).toBeDefined();
  });

  it('filters queries by --type', async () => {
    mockGet.mockReturnValue({ count: 0 });
    mockAll.mockReturnValue([]);

    const mockPrepare = vi.fn(() => ({ get: mockGet, all: mockAll }));
    vi.mocked(Database).mockImplementation(function () {
      return {
        prepare: mockPrepare,
        close: mockClose,
      } as any;
    });

    const { runInspect } = await import('../cli/inspect.js');
    runInspect({ cwd: '/tmp/test-project', type: 'concept' });

    const typeFilteredCalls = mockPrepare.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('node_type = ?'),
    );
    expect(typeFilteredCalls.length).toBe(2);

    const allCallsWithConcept = mockAll.mock.calls.filter(
      (c) => c.includes('concept'),
    );
    expect(allCallsWithConcept.length).toBeGreaterThanOrEqual(2);
  });

  it('includes superseded nodes in result by default', async () => {
    mockGet.mockReturnValue({ count: 0 });
    mockAll.mockReturnValue([]);

    const mockPrepare = vi.fn(() => ({ get: mockGet, all: mockAll }));
    vi.mocked(Database).mockImplementation(function () {
      return {
        prepare: mockPrepare,
        close: mockClose,
      } as any;
    });

    const { runInspect } = await import('../cli/inspect.js');
    const result = runInspect({ cwd: '/tmp/test-project' });

    const supersededCall = mockPrepare.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('strength = 0'),
    );
    expect(supersededCall).toBeDefined();
    expect(result.supersededNodes).toEqual([]);
  });

  it('throws clear error when DB is missing', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const { runInspect } = await import('../cli/inspect.js');
    expect(() => runInspect({ cwd: '/tmp/missing' })).toThrow(
      'No engram database found. Run engram install first.',
    );
  });

  it('maps DB column names to result interface fields', async () => {
    mockGet.mockReturnValue({ count: 1 });
    let allCallCount = 0;
    mockAll.mockImplementation(() => {
      allCallCount++;
      if (allCallCount === 1) return [{ node_type: 'concept', count: 3 }];
      if (allCallCount === 2) return [{ relationship_type: 'relates_to', count: 5 }];
      if (allCallCount === 3) return [{ id: 'ep1', session_id: 'sess-1', summary: 'test episode', timestamp: '2026-04-20T10:00:00Z' }];
      if (allCallCount === 4) return [{ id: 'n1', name: 'TestNode', node_type: 'concept', strength: 0.9, description: 'A test node' }];
      if (allCallCount === 5) return [{ id: 'n2', name: 'OldNode', node_type: 'decision', description: 'Superseded decision' }];
      return [];
    });

    const { runInspect } = await import('../cli/inspect.js');
    const result = runInspect({ cwd: '/tmp/test-project' });

    expect(result.nodesByType).toEqual([{ type: 'concept', count: 3 }]);
    expect(result.edgesByType).toEqual([{ type: 'relates_to', count: 5 }]);
    expect(result.recentEpisodes[0]).toEqual({ id: 'ep1', sessionId: 'sess-1', summary: 'test episode', timestamp: '2026-04-20T10:00:00Z' });
    expect(result.highStrengthNodes[0]).toEqual({ id: 'n1', name: 'TestNode', type: 'concept', strength: 0.9, description: 'A test node' });
    expect(result.supersededNodes[0]).toEqual({ id: 'n2', name: 'OldNode', type: 'decision', description: 'Superseded decision' });
  });
});

describe('formatInspect', () => {
  it('produces readable text with all sections', async () => {
    const { formatInspect } = await import('../cli/inspect.js');
    const result: InspectResult = {
      dbPath: '/tmp/.engram/memory.db',
      totalNodes: 42,
      totalEdges: 15,
      totalEpisodes: 7,
      nodesByType: [{ type: 'concept', count: 30 }, { type: 'decision', count: 12 }],
      edgesByType: [{ type: 'relates_to', count: 10 }, { type: 'depends_on', count: 5 }],
      recentEpisodes: [
        { id: 'ep1', sessionId: 'sess-1', summary: 'Added login flow', timestamp: '2026-04-20T10:00:00Z' },
      ],
      highStrengthNodes: [
        { id: 'n1', name: 'AuthModule', type: 'concept', strength: 0.95, description: 'Authentication module' },
      ],
      supersededNodes: [
        { id: 'n2', name: 'OldAuth', type: 'decision', description: 'Legacy auth approach' },
      ],
    };

    const output = formatInspect(result);
    expect(output).toContain('engram inspect');
    expect(output).toContain('Database: /tmp/.engram/memory.db');
    expect(output).toContain('Nodes:    42');
    expect(output).toContain('Edges:    15');
    expect(output).toContain('Episodes: 7');
    expect(output).toContain('Nodes by type:');
    expect(output).toContain('concept: 30');
    expect(output).toContain('decision: 12');
    expect(output).toContain('Edges by type:');
    expect(output).toContain('relates_to: 10');
    expect(output).toContain('Recent episodes:');
    expect(output).toContain('[sess-1] Added login flow');
    expect(output).toContain('High-strength nodes');
    expect(output).toContain('0.95 AuthModule (concept) — Authentication module');
    expect(output).toContain('Superseded nodes:');
    expect(output).toContain('OldAuth (decision) — Legacy auth approach');
  });

  it('shows (none) for empty sections', async () => {
    const { formatInspect } = await import('../cli/inspect.js');
    const result: InspectResult = {
      dbPath: '/tmp/.engram/memory.db',
      totalNodes: 0,
      totalEdges: 0,
      totalEpisodes: 0,
      nodesByType: [],
      edgesByType: [],
      recentEpisodes: [],
      highStrengthNodes: [],
      supersededNodes: [],
    };

    const output = formatInspect(result);
    const noneCount = (output.match(/\(none\)/g) || []).length;
    expect(noneCount).toBe(5);
  });
});

describe('JSON output', () => {
  it('result object is valid JSON-serializable', async () => {
    mockGet.mockReturnValue({ count: 0 });
    mockAll.mockReturnValue([]);
    vi.mocked(existsSync).mockReturnValue(true);

    const { runInspect } = await import('../cli/inspect.js');
    const result = runInspect({ cwd: '/tmp/test-project' });

    const jsonString = JSON.stringify(result, null, 2);
    const parsed = JSON.parse(jsonString);
    expect(parsed.dbPath).toBe('/tmp/test-project/.engram/memory.db');
    expect(parsed.totalNodes).toBe(0);
  });
});
