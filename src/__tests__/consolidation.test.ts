import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { EngramEvent, WindowSummary, GraphChangeRequest, StructuredEpisode } from '../types.js';

function mockEmbedding(): number[] {
  return Array.from({ length: 512 }, (_, i) => (i + 1) / 512);
}

vi.mock('../core/embed.ts', () => ({
  getEmbedding: vi.fn().mockResolvedValue([Array.from({ length: 512 }, (_, i) => (i + 1) / 512)]),
}));

vi.mock('../core/entity-resolution.ts', () => ({
  resolveEntity: vi.fn().mockResolvedValue({ action: 'create_new' }),
}));

function createMockClient(pass1Response: string, pass2ToolInput: { episode: StructuredEpisode; changes: GraphChangeRequest }) {
  return {
    messages: {
      create: vi.fn().mockImplementation(async (params: Record<string, unknown>) => {
        if (params.tools) {
          return {
            content: [
              { type: 'tool_use', id: 'call_1', name: 'extract_episode', input: pass2ToolInput },
            ],
          };
        }
        return { content: [{ type: 'text', text: pass1Response }] };
      }),
    },
  };
}

function makeSampleEvents(count: number, sessionId = 'sess-1'): EngramEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'file_read' as const,
    sessionId,
    timestamp: new Date(Date.now() + i * 1000).toISOString(),
    filePath: `/src/file-${i}.ts`,
  }));
}

const defaultPass1JSON = JSON.stringify({
  summary: 'Agent read files and made changes',
  filesModified: ['/src/foo.ts'],
  decisionsIdentified: ['Used pattern X'],
  outcome: 'progress',
});

const defaultPass2Input: { episode: StructuredEpisode; changes: GraphChangeRequest } = {
  episode: {
    goal: 'Implement feature X',
    approach: 'Read files then wrote code',
    outcome: 'success',
    discoveries: [{ content: 'Found pattern', evidence: 'file.ts:10', confidence: 0.9 }],
    decisions: [{ content: 'Used approach A', rationale: 'Simpler', isImplicit: false }],
    errors: [],
  },
  changes: {
    nodesToCreate: [
      {
        name: 'Feature X',
        nodeType: 'concept',
        description: 'A new feature',
        affectedFiles: ['/src/foo.ts'],
        causallyImportant: true,
      },
    ],
    nodesToUpdate: [],
    edgesToCreate: [],
  },
};

describe('windowEvents', () => {
  let windowEvents: typeof import('../core/consolidation.js').windowEvents;

  beforeEach(async () => {
    const mod = await import('../core/consolidation.js');
    windowEvents = mod.windowEvents;
  });

  it('returns empty array for empty input', () => {
    expect(windowEvents([], 10, 3)).toEqual([]);
  });

  it('returns single window when events fit within windowSize', () => {
    const events = makeSampleEvents(5);
    const result = windowEvents(events, 10, 3);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(events);
  });

  it('returns single window when events.length === windowSize', () => {
    const events = makeSampleEvents(10);
    const result = windowEvents(events, 10, 3);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(events);
  });

  it('creates correct overlapping windows for larger arrays', () => {
    const events = makeSampleEvents(15);
    const result = windowEvents(events, 10, 3);
    expect(result.length).toBeGreaterThan(1);
    expect(result[0]).toHaveLength(10);
    expect(result[0]![0]).toBe(events[0]);
    expect(result[1]![0]).toBe(events[7]);
  });

  it('windowSize+1 events produce two windows', () => {
    const events = makeSampleEvents(11);
    const result = windowEvents(events, 10, 3);
    expect(result).toHaveLength(2);
  });
});

describe('pass1Summarize', () => {
  let pass1Summarize: typeof import('../core/consolidation.js').pass1Summarize;

  beforeEach(async () => {
    const mod = await import('../core/consolidation.js');
    pass1Summarize = mod.pass1Summarize;
  });

  it('parses valid JSON response into WindowSummary', async () => {
    const client = createMockClient(defaultPass1JSON, defaultPass2Input);
    const windows = [makeSampleEvents(5)];
    const result = await pass1Summarize(windows, client, 'claude-sonnet-4-6');

    expect(result).toHaveLength(1);
    expect(result[0]!.summary).toBe('Agent read files and made changes');
    expect(result[0]!.filesModified).toEqual(['/src/foo.ts']);
    expect(result[0]!.decisionsIdentified).toEqual(['Used pattern X']);
    expect(result[0]!.outcome).toBe('progress');
    expect(result[0]!.windowIndex).toBe(0);
  });

  it('creates fallback summary for non-JSON response', async () => {
    const client = createMockClient('This is not valid JSON at all', defaultPass2Input);
    const windows = [makeSampleEvents(3)];
    const result = await pass1Summarize(windows, client, 'claude-sonnet-4-6');

    expect(result).toHaveLength(1);
    expect(result[0]!.summary).toBe('This is not valid JSON at all');
    expect(result[0]!.filesModified).toEqual([]);
    expect(result[0]!.decisionsIdentified).toEqual([]);
    expect(result[0]!.outcome).toBe('progress');
  });
});

describe('pass2Extract', () => {
  let pass2Extract: typeof import('../core/consolidation.js').pass2Extract;

  beforeEach(async () => {
    const mod = await import('../core/consolidation.js');
    pass2Extract = mod.pass2Extract;
  });

  it('parses tool_use block into episode and changes', async () => {
    const client = createMockClient(defaultPass1JSON, defaultPass2Input);
    const summaries: WindowSummary[] = [
      {
        windowIndex: 0,
        eventRange: { start: 0, end: 4 },
        summary: 'Did stuff',
        filesModified: ['/src/foo.ts'],
        decisionsIdentified: [],
        outcome: 'progress',
      },
    ];

    const result = await pass2Extract(summaries, client, 'claude-opus-4-6');
    expect(result.episode.goal).toBe('Implement feature X');
    expect(result.episode.outcome).toBe('success');
    expect(result.changes.nodesToCreate).toHaveLength(1);
    expect(result.changes.nodesToCreate[0]!.name).toBe('Feature X');
  });

  it('throws when no tool_use block in response', async () => {
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'no tool use here' }],
        }),
      },
    };
    const summaries: WindowSummary[] = [
      {
        windowIndex: 0,
        eventRange: { start: 0, end: 0 },
        summary: 'test',
        filesModified: [],
        decisionsIdentified: [],
        outcome: 'progress',
      },
    ];

    await expect(pass2Extract(summaries, client, 'claude-opus-4-6')).rejects.toThrow(
      'Pass 2: no tool_use block in response',
    );
  });

  it('filters invalid nodeType values', async () => {
    const inputWithBadType = {
      ...defaultPass2Input,
      changes: {
        ...defaultPass2Input.changes,
        nodesToCreate: [
          ...defaultPass2Input.changes.nodesToCreate,
          {
            name: 'Bad Node',
            nodeType: 'invalid_type' as 'concept',
            description: 'Should be filtered',
            affectedFiles: [],
            causallyImportant: false,
          },
        ],
      },
    };
    const client = createMockClient(defaultPass1JSON, inputWithBadType);
    const summaries: WindowSummary[] = [
      {
        windowIndex: 0,
        eventRange: { start: 0, end: 0 },
        summary: 'test',
        filesModified: [],
        decisionsIdentified: [],
        outcome: 'progress',
      },
    ];

    const result = await pass2Extract(summaries, client, 'claude-opus-4-6');
    expect(result.changes.nodesToCreate).toHaveLength(1);
    expect(result.changes.nodesToCreate[0]!.name).toBe('Feature X');
  });
});

describe('applyGraphChanges', () => {
  let applyGraphChanges: typeof import('../core/consolidation.js').applyGraphChanges;
  let initializeSchema: typeof import('../db/migrations.js').initializeSchema;

  beforeEach(async () => {
    const mod = await import('../core/consolidation.js');
    applyGraphChanges = mod.applyGraphChanges;
    const migrations = await import('../db/migrations.js');
    initializeSchema = migrations.initializeSchema;
  });

  it('creates nodes and edges in a transaction', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const db = initializeSchema(dbPath);

    try {
      const changes: GraphChangeRequest = {
        nodesToCreate: [
          { name: 'Node A', nodeType: 'concept', description: 'First node', affectedFiles: ['/a.ts'], causallyImportant: true },
          { name: 'Node B', nodeType: 'pattern', description: 'Second node', affectedFiles: ['/b.ts'], causallyImportant: false },
        ],
        nodesToUpdate: [],
        edgesToCreate: [
          { sourceNodeName: 'Node A', targetNodeName: 'Node B', relationshipType: 'depends_on', weight: 0.7 },
        ],
      };

      const nodeIdMap = await applyGraphChanges(db, changes, 'sess-1', 'ep-1');

      expect(nodeIdMap.size).toBe(2);
      expect(nodeIdMap.has('Node A')).toBe(true);
      expect(nodeIdMap.has('Node B')).toBe(true);

      const nodesCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number };
      expect(nodesCount.c).toBe(2);

      const edgesCount = db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number };
      expect(edgesCount.c).toBe(1);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips edges when referenced node names are not in the batch', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const db = initializeSchema(dbPath);

    try {
      const changes: GraphChangeRequest = {
        nodesToCreate: [
          { name: 'Node A', nodeType: 'concept', description: 'Only node', affectedFiles: [], causallyImportant: false },
        ],
        nodesToUpdate: [],
        edgesToCreate: [
          { sourceNodeName: 'Node A', targetNodeName: 'NonExistent', relationshipType: 'ref', weight: 0.5 },
        ],
      };

      const nodeIdMap = await applyGraphChanges(db, changes, 'sess-1', 'ep-1');
      expect(nodeIdMap.size).toBe(1);

      const edgesCount = db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number };
      expect(edgesCount.c).toBe(0);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('consolidateSession', () => {
  let consolidateSession: typeof import('../core/consolidation.js').consolidateSession;
  let appendEvent: typeof import('../core/event-stream.js').appendEvent;

  beforeEach(async () => {
    const mod = await import('../core/consolidation.js');
    consolidateSession = mod.consolidateSession;
    const es = await import('../core/event-stream.js');
    appendEvent = es.appendEvent;
  });

  it('end-to-end: creates episode marker and DB records', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-e2e-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const sessionId = 'test-session-42';

    const events = makeSampleEvents(5, sessionId);
    for (const ev of events) {
      appendEvent(sessionId, ev, tmpDir);
    }

    const client = createMockClient(defaultPass1JSON, defaultPass2Input);

    await consolidateSession(sessionId, dbPath, tmpDir, {
      client,
      windowSize: 10,
      windowOverlap: 3,
      pass1Model: 'test-sonnet',
      pass2Model: 'test-opus',
    });

    const markerPath = path.join(tmpDir, 'episodes', sessionId + '.episode.json');
    expect(fs.existsSync(markerPath)).toBe(true);

    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as { episodeId: string; completedAt: string };
    expect(marker.episodeId).toBeTruthy();
    expect(marker.completedAt).toBeTruthy();

    const { initializeSchema } = await import('../db/migrations.js');
    const db = initializeSchema(dbPath);
    try {
      const episodeCount = db.prepare('SELECT COUNT(*) as c FROM episodes').get() as { c: number };
      expect(episodeCount.c).toBe(1);

      const nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number };
      expect(nodeCount.c).toBe(1);
    } finally {
      db.close();
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns early for empty events', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-empty-'));
    const dbPath = path.join(tmpDir, 'test.db');

    const client = createMockClient(defaultPass1JSON, defaultPass2Input);

    await consolidateSession('nonexistent', dbPath, tmpDir, { client });

    const markerPath = path.join(tmpDir, 'episodes', 'nonexistent.episode.json');
    expect(fs.existsSync(markerPath)).toBe(false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('findUnconsolidatedSessions', () => {
  let findUnconsolidatedSessions: typeof import('../core/consolidation.js').findUnconsolidatedSessions;

  beforeEach(async () => {
    const mod = await import('../core/consolidation.js');
    findUnconsolidatedSessions = mod.findUnconsolidatedSessions;
  });

  it('returns session IDs without episode markers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-find-'));
    const eventsDir = path.join(tmpDir, 'events');
    const episodesDir = path.join(tmpDir, 'episodes');
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.mkdirSync(episodesDir, { recursive: true });

    fs.writeFileSync(path.join(eventsDir, 'sess-a.jsonl'), '{}');
    fs.writeFileSync(path.join(eventsDir, 'sess-b.jsonl'), '{}');
    fs.writeFileSync(path.join(episodesDir, 'sess-a.episode.json'), '{}');

    const result = findUnconsolidatedSessions(tmpDir);
    expect(result).toEqual(['sess-b']);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array for nonexistent events dir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-nope-'));
    const result = findUnconsolidatedSessions(tmpDir);
    expect(result).toEqual([]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns all sessions when no episodes dir exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-noep-'));
    const eventsDir = path.join(tmpDir, 'events');
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.writeFileSync(path.join(eventsDir, 'sess-x.jsonl'), '{}');

    const result = findUnconsolidatedSessions(tmpDir);
    expect(result).toEqual(['sess-x']);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
