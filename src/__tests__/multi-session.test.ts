import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { GraphChangeRequest, TieredResults, ContradictionResult, Annotation } from '../types.js';
import { buildContext } from '../core/context-builder.js';
import { applyGraphChanges } from '../core/consolidation.js';
import { decaySweep, supersessionCheck } from '../core/maintenance.js';
import { initializeSchema } from '../db/migrations.js';
import { getNodesByName } from '../db/graph.js';
import type BetterSqlite3 from 'better-sqlite3';

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

type Database = BetterSqlite3.Database;

async function simulateSession(
  db: Database,
  sessionId: string,
  changes: GraphChangeRequest,
  outcome: 'success' | 'partial' | 'failure' = 'success',
): Promise<Map<string, string>> {
  const episodeId = `ep-${sessionId}`;
  return applyGraphChanges(db, changes, sessionId, episodeId, outcome);
}

function runDecaySweep(db: Database, config?: { decayThreshold: number; decayFactor: number }) {
  return decaySweep(db, config ?? { decayThreshold: 0.05, decayFactor: 0.9 });
}

function getAllNodes(db: Database) {
  const rows = db.prepare('SELECT * FROM nodes').all() as Array<Record<string, unknown>>;
  return rows.map(r => ({
    ...r,
    affectedFiles: JSON.parse(r.affected_files as string) as string[],
    metadata: JSON.parse(r.metadata as string) as Record<string, unknown>,
    nodeType: r.node_type as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}

describe('Multi-session test harness', () => {
  let db: Database;

  beforeEach(() => {
    db = initializeSchema(':memory:', 512, 'voyage-3-lite');
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  describe('1. Knowledge Accumulation', () => {
    it('accumulates nodes across multiple sessions', async () => {
      await simulateSession(db, 'sess-1', {
        nodesToCreate: [
          { name: 'auth-service', nodeType: 'pattern', description: 'Authentication service module', affectedFiles: ['src/auth.ts'], causallyImportant: false },
          { name: 'db-layer', nodeType: 'concept', description: 'Database access layer', affectedFiles: ['src/db.ts'], causallyImportant: false },
        ],
        nodesToUpdate: [],
        edgesToCreate: [],
      });

      await simulateSession(db, 'sess-2', {
        nodesToCreate: [
          { name: 'cache-module', nodeType: 'pattern', description: 'Caching layer for API responses', affectedFiles: ['src/cache.ts'], causallyImportant: false },
          { name: 'api-router', nodeType: 'concept', description: 'API routing configuration', affectedFiles: ['src/router.ts'], causallyImportant: false },
        ],
        nodesToUpdate: [],
        edgesToCreate: [],
      });

      const allNodes = getAllNodes(db);
      expect(allNodes.length).toBe(4);

      expect(getNodesByName(db, 'auth-service').length).toBe(1);
      expect(getNodesByName(db, 'db-layer').length).toBe(1);
      expect(getNodesByName(db, 'cache-module').length).toBe(1);
      expect(getNodesByName(db, 'api-router').length).toBe(1);
    });
  });

  describe('2. Strength Decay', () => {
    it('decays strength after 3 sweeps and further after 5 sweeps', async () => {
      await simulateSession(db, 'sess-decay', {
        nodesToCreate: [
          { name: 'decay-target', nodeType: 'concept', description: 'Node to test strength decay', affectedFiles: ['src/decay.ts'], causallyImportant: false },
        ],
        nodesToUpdate: [],
        edgesToCreate: [],
      });

      const initialNodes = getNodesByName(db, 'decay-target');
      expect(initialNodes.length).toBe(1);
      const initialStrength = initialNodes[0]!.strength;
      expect(initialStrength).toBeGreaterThan(0);

      for (let i = 0; i < 3; i++) runDecaySweep(db);

      const after3 = getNodesByName(db, 'decay-target');
      expect(after3.length).toBe(1);
      const strength3 = after3[0]!.strength;
      expect(strength3).toBeLessThan(initialStrength);

      for (let i = 0; i < 2; i++) runDecaySweep(db);

      const after5 = getNodesByName(db, 'decay-target');
      expect(after5.length).toBe(1);
      const strength5 = after5[0]!.strength;
      expect(strength5).toBeLessThan(strength3);
      expect(strength5).toBeGreaterThan(0.05);
    });
  });

  describe('3. Entity Resolution Merge', () => {
    it('merges nodes with identical name and description across sessions', async () => {
      const nodeSpec = {
        name: 'auth-middleware',
        nodeType: 'pattern' as const,
        description: 'JWT-based authentication middleware',
        affectedFiles: ['src/auth.ts'],
        causallyImportant: false,
      };

      await simulateSession(db, 'sess-merge-1', {
        nodesToCreate: [nodeSpec],
        nodesToUpdate: [],
        edgesToCreate: [],
      });

      await simulateSession(db, 'sess-merge-2', {
        nodesToCreate: [nodeSpec],
        nodesToUpdate: [],
        edgesToCreate: [],
      });

      const nodes = getNodesByName(db, 'auth-middleware');
      expect(nodes.length).toBe(1);

      const meta = nodes[0]!.metadata as { sourceEpisodes?: string[] };
      expect(meta.sourceEpisodes).toBeDefined();
      expect(meta.sourceEpisodes!.length).toBe(2);
      expect(meta.sourceEpisodes).toContain('ep-sess-merge-1');
      expect(meta.sourceEpisodes).toContain('ep-sess-merge-2');
    });
  });

  describe('4. Supersession', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-supersession-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('zeroes strength when all affected files are deleted', async () => {
      const file1 = path.join(tmpDir, 'file1.ts');
      const file2 = path.join(tmpDir, 'file2.ts');
      fs.writeFileSync(file1, '');
      fs.writeFileSync(file2, '');

      await simulateSession(db, 'sess-supersede', {
        nodesToCreate: [
          { name: 'superseded-node', nodeType: 'concept', description: 'Node with temp files', affectedFiles: [file1, file2], causallyImportant: false },
        ],
        nodesToUpdate: [],
        edgesToCreate: [],
      });

      const beforeDelete = getNodesByName(db, 'superseded-node');
      expect(beforeDelete.length).toBe(1);
      expect(beforeDelete[0]!.strength).toBeGreaterThan(0);

      fs.unlinkSync(file1);
      fs.unlinkSync(file2);

      const result = supersessionCheck(db);
      expect(result.filesSuperseded).toBe(1);

      const afterSupersession = getNodesByName(db, 'superseded-node');
      expect(afterSupersession.length).toBe(1);
      expect(afterSupersession[0]!.strength).toBe(0);
    });
  });

  describe('5. Duplicate Prevention', () => {
    it('does not create duplicate nodes when the same data is applied in separate sessions', async () => {
      const changes: GraphChangeRequest = {
        nodesToCreate: [
          { name: 'dup-test', nodeType: 'pattern', description: 'Test duplicate prevention', affectedFiles: [], causallyImportant: false },
        ],
        nodesToUpdate: [],
        edgesToCreate: [],
      };

      await simulateSession(db, 'sess-dup-1', changes);
      await simulateSession(db, 'sess-dup-2', changes);

      const nodes = getNodesByName(db, 'dup-test');
      expect(nodes.length).toBe(1);

      const meta = nodes[0]!.metadata as { sourceEpisodes?: string[] };
      expect(meta.sourceEpisodes).toBeDefined();
      expect(meta.sourceEpisodes!.length).toBe(2);
    });
  });

  describe('6. Description Stability', () => {
    it('does not concatenate descriptions when merging nodes with identical text', async () => {
      const nodeSpec = {
        name: 'stable-desc',
        nodeType: 'pattern' as const,
        description: 'Handles user authentication via JWT tokens',
        affectedFiles: ['src/auth.ts'],
        causallyImportant: false,
      };

      await simulateSession(db, 'sess-stable-1', {
        nodesToCreate: [nodeSpec],
        nodesToUpdate: [],
        edgesToCreate: [],
      });

      await simulateSession(db, 'sess-stable-2', {
        nodesToCreate: [nodeSpec],
        nodesToUpdate: [],
        edgesToCreate: [],
      });

      const nodes = getNodesByName(db, 'stable-desc');
      expect(nodes.length).toBe(1);
      expect(nodes[0]!.description).toBe('Handles user authentication via JWT tokens');
      expect(nodes[0]!.description).not.toContain('; ');
    });
  });

  describe('7. Cross-cutting Decision Dedup', () => {
    it('renders cross-cutting decisions in Project-wide decisions section, not in regular Decisions', async () => {
      await simulateSession(db, 'sess-cross-1', {
        nodesToCreate: [
          { name: 'cross-cutting-arch', nodeType: 'decision', description: 'Use microservices architecture for all services', affectedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'], causallyImportant: false },
          { name: 'local-auth-decision', nodeType: 'decision', description: 'Use bcrypt for password hashing', affectedFiles: ['src/auth.ts'], causallyImportant: false },
          { name: 'some-pattern', nodeType: 'pattern', description: 'Singleton pattern for DB connection', affectedFiles: ['src/db.ts', 'src/app.ts', 'src/server.ts'], causallyImportant: false },
        ],
        nodesToUpdate: [],
        edgesToCreate: [],
      });

      const crossCuttingNodes = getNodesByName(db, 'cross-cutting-arch');
      const localNodes = getNodesByName(db, 'local-auth-decision');
      const patternNodes = getNodesByName(db, 'some-pattern');

      const tieredResults: TieredResults = {
        high: [
          { node: crossCuttingNodes[0]!, activation: 1.0 },
          { node: localNodes[0]!, activation: 0.8 },
          { node: patternNodes[0]!, activation: 0.7 },
        ],
        medium: [],
      };

      const output = buildContext([] as ContradictionResult[], [] as Annotation[], tieredResults);

      expect(output).toContain('## Project-wide decisions');
      expect(output).toContain('microservices');

      const sections = output.split('## ');
      const projectWideSection = sections.find(s => s.startsWith('Project-wide decisions'));
      expect(projectWideSection).toBeDefined();
      expect(projectWideSection).toContain('microservices');

      const decisionsSection = sections.find(s => s.startsWith('Decisions'));
      if (decisionsSection) {
        expect(decisionsSection).toContain('bcrypt');
        expect(decisionsSection).not.toContain('microservices');
      }

      expect(projectWideSection).not.toContain('Singleton pattern');
    });
  });
});
