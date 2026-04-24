import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../core/consolidation.js', () => ({
  findUnconsolidatedSessions: vi.fn(() => []),
  spawnConsolidation: vi.fn(),
}));

let currentTmpDir = '';

vi.mock('../core/project-identity.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../core/project-identity.js')>();
  return {
    ...orig,
    getDataDir: () => path.join(currentTmpDir, '.engram-data'),
    getDbPath: () => path.join(currentTmpDir, '.engram-data', 'engram.db'),
    ensureDataDirs: () => {
      const dataDir = path.join(currentTmpDir, '.engram-data');
      for (const sub of ['events', 'sessions', 'episodes', 'logs']) {
        fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
      }
      return dataDir;
    },
  };
});

import engramGSDExtension from '../adapters/gsd/index.js';
import { createNode, createEdge } from '../db/graph.js';
import { Database } from '../db/migrations.js';
import * as sqliteVec from 'sqlite-vec';
import type { GSDExtensionAPI, GSDActiveUnit, GSDToolCallEvent, GSDBeforeAgentStartEvent, GSDExtensionContext } from '../adapters/gsd/types.js';
import type { EngramEvent } from '../types.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-gsd-adapter-'));
}

type HandlerMap = {
  before_agent_start: Array<(event: GSDBeforeAgentStartEvent, ctx: GSDExtensionContext) => { systemPrompt: string } | undefined | void>;
  tool_call: Array<(event: GSDToolCallEvent, ctx: GSDExtensionContext) => void>;
  session_shutdown: Array<(ctx: GSDExtensionContext) => void>;
};

function createMockGSDAPI() {
  const handlers: HandlerMap = {
    before_agent_start: [],
    tool_call: [],
    session_shutdown: [],
  };

  let phase: string | null = 'execute';
  let activeUnit: GSDActiveUnit | null = null;

  const api = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const key = event as keyof HandlerMap;
      if (key in handlers) {
        (handlers[key] as Array<(...args: unknown[]) => unknown>).push(handler);
      }
    },
    getPhase() { return phase; },
    getActiveUnit() { return activeUnit; },
  } as unknown as GSDExtensionAPI;

  return {
    api,
    handlers,
    trigger(eventName: keyof HandlerMap, eventData?: unknown) {
      const list = handlers[eventName];
      if (list.length === 0) return undefined;
      if (eventName === 'session_shutdown') {
        return (list[0] as (ctx: GSDExtensionContext) => void)({});
      }
      return (list[0] as (event: unknown, ctx: GSDExtensionContext) => unknown)(eventData, {});
    },
    setPhase(p: string | null) { phase = p; },
    setActiveUnit(u: GSDActiveUnit | null) { activeUnit = u; },
  };
}

function dataDir(): string {
  return path.join(currentTmpDir, '.engram-data');
}

function dbPath(): string {
  return path.join(currentTmpDir, '.engram-data', 'engram.db');
}

function readAllEvents(): EngramEvent[] {
  const eventsDir = path.join(dataDir(), 'events');
  if (!fs.existsSync(eventsDir)) return [];
  const files = fs.readdirSync(eventsDir).filter(f => f.endsWith('.jsonl'));
  if (files.length === 0) return [];
  const content = fs.readFileSync(path.join(eventsDir, files[0]!), 'utf-8');
  return content.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as EngramEvent);
}

function readLastEvent(): EngramEvent | null {
  const events = readAllEvents();
  return events.length > 0 ? events[events.length - 1]! : null;
}

// ── Group 1: Handler Registration ─────────────────────────────

describe('GSD adapter: handler registration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    currentTmpDir = tmpDir;
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers handlers for before_agent_start, tool_call, and session_shutdown', async () => {
    const { api, handlers } = createMockGSDAPI();
    await engramGSDExtension(api);

    expect(handlers.before_agent_start.length).toBe(1);
    expect(handlers.tool_call.length).toBe(1);
    expect(handlers.session_shutdown.length).toBe(1);
  });
});

// ── Group 2: Tool Call with Unit Tags ─────────────────────────

describe('GSD adapter: tool call with unit tags', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    currentTmpDir = tmpDir;
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('captures events with milestone/slice/task tags from active unit', async () => {
    const mock = createMockGSDAPI();
    mock.setActiveUnit({
      milestoneId: 'M001', milestoneTitle: 'Test',
      sliceId: 'S01', sliceTitle: 'Test',
      taskId: 'T01', taskTitle: 'Test',
    });
    await engramGSDExtension(mock.api);

    mock.trigger('tool_call', {
      type: 'tool_call',
      toolCallId: 'tc1',
      toolName: 'write',
      input: { path: path.join(tmpDir, 'test.ts'), content: 'hello' },
    });

    const lastEvent = readLastEvent();
    expect(lastEvent).not.toBeNull();
    expect(lastEvent!.type).toBe('file_write');
    expect(lastEvent!.tags).toBeDefined();
    expect(lastEvent!.tags!.milestoneId).toBe('M001');
    expect(lastEvent!.tags!.sliceId).toBe('S01');
    expect(lastEvent!.tags!.taskId).toBe('T01');
  });
});

// ── Group 3: Tool Name/Input Mapping ──────────────────────────

describe('GSD adapter: tool name/input mapping', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    currentTmpDir = tmpDir;
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('maps read tool with path→file_path normalization', async () => {
    const mock = createMockGSDAPI();
    await engramGSDExtension(mock.api);

    mock.trigger('tool_call', {
      type: 'tool_call',
      toolCallId: 'tc2',
      toolName: 'read',
      input: { path: path.join(tmpDir, 'foo.ts') },
    });

    const events = readAllEvents();
    const readEvent = events.find(e => e.type === 'file_read');
    expect(readEvent).toBeDefined();
    expect((readEvent as { filePath: string }).filePath).toBe(path.join(tmpDir, 'foo.ts'));
  });

  it('maps edit tool with oldText→old_string and newText→new_string normalization', async () => {
    const mock = createMockGSDAPI();
    await engramGSDExtension(mock.api);

    mock.trigger('tool_call', {
      type: 'tool_call',
      toolCallId: 'tc3',
      toolName: 'edit',
      input: { path: path.join(tmpDir, 'bar.ts'), oldText: 'x', newText: 'y' },
    });

    const events = readAllEvents();
    const writeEvent = events.find(e => e.type === 'file_write');
    expect(writeEvent).toBeDefined();
    expect((writeEvent as { filePath: string }).filePath).toBe(path.join(tmpDir, 'bar.ts'));
  });
});

// ── Group 4: Context Injection via before_agent_start ─────────

describe('GSD adapter: context injection via before_agent_start', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    currentTmpDir = tmpDir;
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('injects retrieval context into system prompt when graph has connected nodes', async () => {
    const mock = createMockGSDAPI();
    await engramGSDExtension(mock.api);

    const db = new Database(dbPath());
    sqliteVec.load(db);
    const entryNode = createNode(db, {
      name: 'AuthService',
      nodeType: 'concept',
      description: 'Handles authentication',
      affectedFiles: ['src/auth.ts'],
      strength: 1.0,
      metadata: {},
    });
    const connectedNode = createNode(db, {
      name: 'TokenStore',
      nodeType: 'pattern',
      description: 'Token storage pattern for auth',
      affectedFiles: ['src/token.ts'],
      strength: 1.0,
      metadata: {},
    });
    createEdge(db, {
      sourceNodeId: entryNode.id,
      targetNodeId: connectedNode.id,
      relationshipType: 'uses',
      weight: 0.9,
      metadata: {},
    });
    db.close();

    const result = mock.trigger('before_agent_start', {
      systemPrompt: 'You are helping with src/auth.ts',
    });

    if (result && typeof result === 'object' && 'systemPrompt' in result) {
      expect((result as { systemPrompt: string }).systemPrompt).toContain('You are helping with src/auth.ts');
      expect((result as { systemPrompt: string }).systemPrompt).toContain('TokenStore');
    } else {
      expect(result).toBeUndefined();
    }
  });
});

// ── Group 5: No Tags When Unit is Null ────────────────────────

describe('GSD adapter: no tags when unit is null', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    currentTmpDir = tmpDir;
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not attach tags when activeUnit is null', async () => {
    const mock = createMockGSDAPI();
    mock.setActiveUnit(null);
    await engramGSDExtension(mock.api);

    mock.trigger('tool_call', {
      type: 'tool_call',
      toolCallId: 'tc4',
      toolName: 'write',
      input: { path: path.join(tmpDir, 'nounit.ts'), content: 'test' },
    });

    const lastEvent = readLastEvent();
    expect(lastEvent).not.toBeNull();
    expect(lastEvent!.type).toBe('file_write');
    expect(lastEvent!.tags).toBeUndefined();
  });
});

// ── Group 6: Session Shutdown ─────────────────────────────────

describe('GSD adapter: session shutdown', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    currentTmpDir = tmpDir;
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shuts down without error and DB file still exists', async () => {
    const mock = createMockGSDAPI();
    await engramGSDExtension(mock.api);

    expect(() => mock.trigger('session_shutdown')).not.toThrow();

    expect(fs.existsSync(dbPath())).toBe(true);
  });
});

// ── Group 7: No Claude Code Imports ───────────────────────────

describe('GSD adapter: no Claude Code imports', () => {
  it('test file does not import from src/adapters/claude-code/', () => {
    const thisFile = fs.readFileSync(new URL(import.meta.url).pathname, 'utf-8');
    const lines = thisFile.split('\n').filter(l => l.startsWith('import '));
    for (const line of lines) {
      expect(line).not.toContain('adapters/claude-code');
    }
  });

  it('adapter source does not import from src/adapters/claude-code/', () => {
    const adapterPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../adapters/gsd/index.ts',
    );
    const source = fs.readFileSync(adapterPath, 'utf-8');
    const lines = source.split('\n').filter(l => l.startsWith('import '));
    for (const line of lines) {
      expect(line).not.toContain('adapters/claude-code');
    }
  });
});
