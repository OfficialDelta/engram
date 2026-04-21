import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { StructuredEpisode, GraphChangeRequest, ContradictionResult } from '../types.js';

vi.mock('../core/embed.js', () => ({
  getEmbedding: vi.fn(async (texts: string[]) => {
    return texts.map((text: string) => {
      let h = 0;
      for (const ch of text) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
      return Array.from({ length: 512 }, (_, i) => Math.sin(h * 0.001 + i * 0.1));
    });
  }),
}));

vi.mock('../core/consolidation.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../core/consolidation.js')>();
  return { ...mod, spawnConsolidation: vi.fn() };
});

function createTmpDataDir(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-lifecycle-'));
  fs.mkdirSync(path.join(tmpDir, 'events'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'episodes'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
  return tmpDir;
}

function createMockClient(
  pass1JSON: string,
  pass2ToolInput: { episode: StructuredEpisode; changes: GraphChangeRequest },
) {
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
        return { content: [{ type: 'text', text: pass1JSON }] };
      }),
    },
  };
}

const pass1JSON = JSON.stringify({
  summary: 'Agent modified auth middleware and crypto utilities',
  filesModified: ['src/auth.ts', 'src/utils/crypto.ts'],
  decisionsIdentified: ['Use JWT for authentication', 'Use bcrypt for hashing'],
  outcome: 'progress',
});

const pass2Input: { episode: StructuredEpisode; changes: GraphChangeRequest } = {
  episode: {
    goal: 'Implement authentication',
    approach: 'Added JWT middleware and bcrypt hashing',
    outcome: 'success',
    discoveries: [{ content: 'JWT works well', evidence: 'src/auth.ts:15', confidence: 0.9 }],
    decisions: [{ content: 'Use bcrypt', rationale: 'Industry standard', isImplicit: false }],
    errors: [],
  },
  changes: {
    nodesToCreate: [
      {
        name: 'auth-middleware',
        nodeType: 'pattern',
        description: 'JWT-based authentication middleware',
        affectedFiles: ['src/auth.ts'],
        causallyImportant: true,
      },
      {
        name: 'bcrypt-hashing',
        nodeType: 'decision',
        description: 'Use bcrypt for password hashing',
        affectedFiles: ['src/utils/crypto.ts'],
        causallyImportant: false,
      },
    ],
    nodesToUpdate: [],
    edgesToCreate: [
      {
        sourceNodeName: 'auth-middleware',
        targetNodeName: 'bcrypt-hashing',
        relationshipType: 'depends_on',
        weight: 0.9,
      },
    ],
  },
};

describe('Capture → Consolidate → Retrieve', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = createTmpDataDir();
    dbPath = path.join(tmpDir, 'engram.db');
    const { initializeSchema } = await import('../db/migrations.js');
    const db = initializeSchema(dbPath);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('events are captured to JSONL via appendEvent', async () => {
    const { appendEvent, getSessionEvents } = await import('../core/event-stream.js');

    appendEvent('sess-1', { type: 'file_read', sessionId: 'sess-1', timestamp: new Date().toISOString(), filePath: 'src/auth.ts' }, tmpDir);
    appendEvent('sess-1', { type: 'file_write', sessionId: 'sess-1', timestamp: new Date().toISOString(), filePath: 'src/auth.ts', linesChanged: 10, evidenceSnippet: 'jwt middleware' }, tmpDir);
    appendEvent('sess-1', { type: 'file_read', sessionId: 'sess-1', timestamp: new Date().toISOString(), filePath: 'src/utils/crypto.ts' }, tmpDir);
    appendEvent('sess-1', { type: 'file_write', sessionId: 'sess-1', timestamp: new Date().toISOString(), filePath: 'src/utils/crypto.ts', linesChanged: 5, evidenceSnippet: 'bcrypt hash' }, tmpDir);
    appendEvent('sess-1', { type: 'test_run', sessionId: 'sess-1', timestamp: new Date().toISOString(), command: 'npm test', exitCode: 0, passed: true }, tmpDir);

    const events = getSessionEvents('sess-1', tmpDir);
    expect(events.length).toBeGreaterThanOrEqual(5);

    const fileWrite = events.find(e => e.type === 'file_write' && 'filePath' in e && e.filePath === 'src/auth.ts');
    expect(fileWrite).toBeDefined();
    expect((fileWrite as { filePath: string }).filePath).toBe('src/auth.ts');
  });

  it('consolidateSession populates graph with nodes, edges, and episode marker', async () => {
    const { appendEvent } = await import('../core/event-stream.js');
    const { consolidateSession } = await import('../core/consolidation.js');

    appendEvent('sess-1', { type: 'file_read', sessionId: 'sess-1', timestamp: new Date().toISOString(), filePath: 'src/auth.ts' }, tmpDir);
    appendEvent('sess-1', { type: 'file_write', sessionId: 'sess-1', timestamp: new Date().toISOString(), filePath: 'src/auth.ts', linesChanged: 10, evidenceSnippet: 'jwt middleware' }, tmpDir);
    appendEvent('sess-1', { type: 'file_read', sessionId: 'sess-1', timestamp: new Date().toISOString(), filePath: 'src/utils/crypto.ts' }, tmpDir);
    appendEvent('sess-1', { type: 'file_write', sessionId: 'sess-1', timestamp: new Date().toISOString(), filePath: 'src/utils/crypto.ts', linesChanged: 5, evidenceSnippet: 'bcrypt hash' }, tmpDir);
    appendEvent('sess-1', { type: 'test_run', sessionId: 'sess-1', timestamp: new Date().toISOString(), command: 'npm test', exitCode: 0, passed: true }, tmpDir);

    const mockClient = createMockClient(pass1JSON, pass2Input);

    await consolidateSession('sess-1', dbPath, tmpDir, { client: mockClient });

    expect(fs.existsSync(path.join(tmpDir, 'episodes', 'sess-1.episode.json'))).toBe(true);

    const { initializeSchema } = await import('../db/migrations.js');
    const db = initializeSchema(dbPath);
    const rows = db.prepare('SELECT * FROM nodes').all() as Array<{ name: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const names = rows.map(r => r.name);
    expect(names).toContain('auth-middleware');
    expect(names).toContain('bcrypt-hashing');
    db.close();
  });

  it('processSessionStart returns prior knowledge in additionalContext', async () => {
    const { appendEvent } = await import('../core/event-stream.js');
    const { consolidateSession } = await import('../core/consolidation.js');
    const { processSessionStart } = await import('../adapters/claude-code/session-start.js');

    // Only file_write to src/auth.ts so auth-middleware is the sole entry point;
    // bcrypt-hashing (linked to src/utils/crypto.ts) is reached via edge traversal.
    appendEvent('sess-1', { type: 'file_read', sessionId: 'sess-1', timestamp: new Date().toISOString(), filePath: 'src/auth.ts' }, tmpDir);
    appendEvent('sess-1', { type: 'file_write', sessionId: 'sess-1', timestamp: new Date().toISOString(), filePath: 'src/auth.ts', linesChanged: 10, evidenceSnippet: 'jwt middleware' }, tmpDir);
    appendEvent('sess-1', { type: 'file_read', sessionId: 'sess-1', timestamp: new Date().toISOString(), filePath: 'src/utils/crypto.ts' }, tmpDir);
    appendEvent('sess-1', { type: 'file_read', sessionId: 'sess-1', timestamp: new Date().toISOString(), filePath: 'src/index.ts' }, tmpDir);
    appendEvent('sess-1', { type: 'test_run', sessionId: 'sess-1', timestamp: new Date().toISOString(), command: 'npm test', exitCode: 0, passed: true }, tmpDir);

    const mockClient = createMockClient(pass1JSON, pass2Input);
    await consolidateSession('sess-1', dbPath, tmpDir, { client: mockClient });

    const result = processSessionStart('sess-2', tmpDir, dbPath);

    const ctx = result as { hookSpecificOutput?: { additionalContext?: string } };
    expect(ctx.hookSpecificOutput).toBeDefined();
    expect(ctx.hookSpecificOutput!.additionalContext).toBeDefined();
    expect(ctx.hookSpecificOutput!.additionalContext).toContain('bcrypt-hashing');
  });
});

describe('Contradiction Detection Path', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = createTmpDataDir();
    dbPath = path.join(tmpDir, 'engram.db');
    const { initializeSchema } = await import('../db/migrations.js');
    const db = initializeSchema(dbPath);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('file_write to a file with decisions spawns contradiction check', async () => {
    const { initializeSchema } = await import('../db/migrations.js');
    const { createNode } = await import('../db/graph.js');
    const { processPostToolUse } = await import('../adapters/claude-code/post-tool-use.js');

    const db = initializeSchema(dbPath);
    createNode(db, {
      name: 'auth-approach',
      nodeType: 'decision',
      description: 'Use JWT tokens for auth',
      affectedFiles: ['src/auth.ts'],
      strength: 0.8,
      metadata: {},
    });
    db.close();

    const mockSpawn = vi.fn();

    processPostToolUse(
      { tool_name: 'Write', tool_input: { file_path: 'src/auth.ts', content: 'new auth code' }, session_id: 'sess-c1' },
      tmpDir,
      dbPath,
      { spawnCheck: mockSpawn },
    );

    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(mockSpawn.mock.calls[0]![0]).toBe('sess-c1');
    expect(mockSpawn.mock.calls[0]![3]).toBe('src/auth.ts');
  });

  it('pending contradiction in session state appears in additionalContext', async () => {
    const { saveSessionState, loadSessionState } = await import('../adapters/claude-code/session-state.js');
    const { processPostToolUse } = await import('../adapters/claude-code/post-tool-use.js');

    const contradictionResult: ContradictionResult = {
      verdict: 'DIRECT_CONTRADICTION',
      severity: 'high',
      explanation: 'Conflicts with JWT decision',
      recommendation: 'Review auth approach',
    };

    saveSessionState(tmpDir, 'sess-c2', {
      seenFiles: [],
      contradictionFailures: 0,
      contradictionDisabled: false,
      pendingContradictions: [contradictionResult],
      turnCount: 0,
      toolCallCount: 0,
    });

    const result = processPostToolUse(
      { tool_name: 'Read', tool_input: { file_path: 'README.md' }, session_id: 'sess-c2' },
      tmpDir,
      dbPath,
      { spawnCheck: vi.fn() },
    );

    const ctx = result as { hookSpecificOutput?: { additionalContext?: string } };
    expect(ctx.hookSpecificOutput).toBeDefined();
    expect(ctx.hookSpecificOutput!.additionalContext).toContain('⚠️ CONTRADICTION');

    const stateAfter = loadSessionState(tmpDir, 'sess-c2');
    expect(stateAfter.pendingContradictions).toHaveLength(0);
  });

  it('ContradictionChecker detects conflict with stored decision', async () => {
    const { initializeSchema } = await import('../db/migrations.js');
    const { createNode } = await import('../db/graph.js');
    const { ContradictionChecker } = await import('../core/contradiction.js');

    const db = initializeSchema(dbPath);
    createNode(db, {
      name: 'jwt-auth-decision',
      nodeType: 'decision',
      description: 'Use JWT tokens for authentication',
      affectedFiles: ['src/auth.ts'],
      strength: 0.8,
      metadata: {},
    });

    const mockHaikuClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: 'tool_use',
            id: 't1',
            name: 'check_contradiction',
            input: {
              verdict: 'DIRECT_CONTRADICTION',
              severity: 'high',
              explanation: 'Conflicts with stored JWT decision',
              recommendation: 'Review auth approach',
            },
          }],
        }),
      },
    };

    const checker = new ContradictionChecker();
    const result = await checker.checkContradiction(
      db,
      'src/auth.ts',
      'switching to session tokens',
      { client: mockHaikuClient },
    );

    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('DIRECT_CONTRADICTION');

    db.close();
  });
});
