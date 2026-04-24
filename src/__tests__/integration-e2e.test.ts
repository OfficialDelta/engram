import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { StructuredEpisode, GraphChangeRequest } from '../types.js';

vi.mock('../core/embed.js', () => ({
  getEmbedding: vi.fn(async (texts: string[]) => {
    return texts.map((text: string) => {
      let h = 0;
      for (const ch of text) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
      return Array.from({ length: 512 }, (_, i) => Math.sin(h * 0.001 + i * 0.1));
    });
  }),
  getDimensions: vi.fn().mockReturnValue(512),
}));

vi.mock('../core/consolidation.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../core/consolidation.js')>();
  return { ...mod, spawnConsolidation: vi.fn() };
});

function createTmpDataDir(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-e2e-'));
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

describe('Full Circuit: Events → Consolidation → Graph → Retrieval → Context', () => {
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

  it('events → consolidation → graph nodes → spreading activation → buildContext', async () => {
    const { appendEvent } = await import('../core/event-stream.js');
    const { consolidateSession } = await import('../core/consolidation.js');
    const { spreadingActivation } = await import('../core/retrieval.js');
    const { buildContext } = await import('../core/context-builder.js');

    // Only file_write to src/auth.ts so auth-middleware is the sole entry point;
    // bcrypt-hashing is reached via edge traversal (L009).
    appendEvent('sess-e2e-1', { type: 'file_read', sessionId: 'sess-e2e-1', timestamp: new Date().toISOString(), filePath: 'src/auth.ts' }, tmpDir);
    appendEvent('sess-e2e-1', { type: 'file_write', sessionId: 'sess-e2e-1', timestamp: new Date().toISOString(), filePath: 'src/auth.ts', linesChanged: 10, evidenceSnippet: 'jwt middleware' }, tmpDir);
    appendEvent('sess-e2e-1', { type: 'file_read', sessionId: 'sess-e2e-1', timestamp: new Date().toISOString(), filePath: 'src/utils/crypto.ts' }, tmpDir);
    appendEvent('sess-e2e-1', { type: 'test_run', sessionId: 'sess-e2e-1', timestamp: new Date().toISOString(), command: 'npm test', exitCode: 0, passed: true }, tmpDir);

    const mockClient = createMockClient(pass1JSON, pass2Input);
    await consolidateSession('sess-e2e-1', dbPath, tmpDir, { client: mockClient });

    // Verify graph nodes were created
    const { initializeSchema } = await import('../db/migrations.js');
    const db = initializeSchema(dbPath);
    const rows = db.prepare('SELECT * FROM nodes').all() as Array<{ name: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const nodeNames = rows.map(r => r.name);
    expect(nodeNames).toContain('auth-middleware');
    expect(nodeNames).toContain('bcrypt-hashing');

    // Spreading activation from auth file — entry point is auth-middleware,
    // bcrypt-hashing should appear via edge traversal (excluded as entry point per L009)
    const tieredResults = spreadingActivation(db, [{ type: 'file', value: 'src/auth.ts' }]);
    const allResults = [...tieredResults.high, ...tieredResults.medium];
    expect(allResults.length).toBeGreaterThanOrEqual(1);
    const resultNames = allResults.map(r => r.node.name);
    expect(resultNames).toContain('bcrypt-hashing');

    // Build context string from tiered results
    const contextString = buildContext([], [], tieredResults);
    expect(contextString).toContain('bcrypt');
    expect(contextString.length).toBeGreaterThan(0);

    db.close();
  });
});

describe('Decision Node → Contradiction Detection', () => {
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

  it('decision node with strength > 0.3 triggers contradiction detection', async () => {
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
              explanation: 'Switching to session tokens directly contradicts the JWT decision',
              recommendation: 'Review auth approach before proceeding',
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
    expect(result!.severity).toBe('high');
    expect(result!.explanation).toBeTruthy();

    db.close();
  });
});

describe('Full Pipeline End-to-End', () => {
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

  it('full circuit: events → consolidation → graph → retrieval → context → contradiction', async () => {
    const { appendEvent } = await import('../core/event-stream.js');
    const { consolidateSession } = await import('../core/consolidation.js');
    const { spreadingActivation } = await import('../core/retrieval.js');
    const { buildContext } = await import('../core/context-builder.js');
    const { createNode } = await import('../db/graph.js');
    const { ContradictionChecker } = await import('../core/contradiction.js');
    const { initializeSchema } = await import('../db/migrations.js');

    // Step 1: Append events — only file_write to auth so it's the sole entry point
    appendEvent('sess-full', { type: 'file_read', sessionId: 'sess-full', timestamp: new Date().toISOString(), filePath: 'src/auth.ts' }, tmpDir);
    appendEvent('sess-full', { type: 'file_write', sessionId: 'sess-full', timestamp: new Date().toISOString(), filePath: 'src/auth.ts', linesChanged: 10, evidenceSnippet: 'jwt middleware' }, tmpDir);
    appendEvent('sess-full', { type: 'file_read', sessionId: 'sess-full', timestamp: new Date().toISOString(), filePath: 'src/utils/crypto.ts' }, tmpDir);
    appendEvent('sess-full', { type: 'test_run', sessionId: 'sess-full', timestamp: new Date().toISOString(), command: 'npm test', exitCode: 0, passed: true }, tmpDir);

    // Step 2: Consolidate session — creates graph nodes and edges via mock LLM
    const mockClient = createMockClient(pass1JSON, pass2Input);
    await consolidateSession('sess-full', dbPath, tmpDir, { client: mockClient });

    // Step 3: Verify graph nodes exist
    const db = initializeSchema(dbPath);
    const rows = db.prepare('SELECT * FROM nodes').all() as Array<{ name: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.map(r => r.name)).toContain('auth-middleware');
    expect(rows.map(r => r.name)).toContain('bcrypt-hashing');

    // Step 4: Spreading activation from auth file
    const tieredResults = spreadingActivation(db, [{ type: 'file', value: 'src/auth.ts' }]);
    const allResults = [...tieredResults.high, ...tieredResults.medium];
    expect(allResults.length).toBeGreaterThanOrEqual(1);
    expect(allResults.map(r => r.node.name)).toContain('bcrypt-hashing');

    // Step 5: Build context string — should contain node descriptions
    const contextString = buildContext([], [], tieredResults);
    expect(contextString).toContain('bcrypt');
    expect(contextString).toContain('password hashing');

    // Step 6: Create a decision node for contradiction detection
    createNode(db, {
      name: 'jwt-auth-decision',
      nodeType: 'decision',
      description: 'Use JWT tokens for authentication',
      affectedFiles: ['src/auth.ts'],
      strength: 0.8,
      metadata: {},
    });

    // Step 7: Check contradiction against the decision
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
              explanation: 'Switching to session tokens contradicts JWT decision',
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

    // Step 8: Verify contradiction can be included in context output
    const contextWithContradiction = buildContext([result!], [], tieredResults);
    expect(contextWithContradiction).toContain('⚠️ CONTRADICTION');
    expect(contextWithContradiction).toContain('bcrypt');

    db.close();
  });
});
