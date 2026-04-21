import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleQueryKnowledge, runMcp } from '../cli/mcp.js';
import { initializeSchema } from '../db/migrations.js';
import { createNode, createEdge } from '../db/graph.js';
import { ensureDataDirs } from '../core/project-identity.js';
import type BetterSqlite3 from 'better-sqlite3';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mcp-'));
}

describe('handleQueryKnowledge', () => {
  let tmpDir: string;
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ensureDataDirs(tmpDir);
    const dbPath = path.join(tmpDir, 'test-mcp.db');
    db = initializeSchema(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns context when graph has relevant nodes', () => {
    const entry = createNode(db, {
      name: 'AuthService',
      nodeType: 'concept',
      description: 'Handles user authentication and token management',
      affectedFiles: ['src/auth.ts'],
      strength: 1.0,
      metadata: {},
    });
    const neighbor = createNode(db, {
      name: 'TokenStore',
      nodeType: 'concept',
      description: 'Persists refresh tokens for authenticated sessions',
      affectedFiles: ['src/tokens.ts'],
      strength: 1.0,
      metadata: {},
    });
    createEdge(db, {
      sourceNodeId: entry.id,
      targetNodeId: neighbor.id,
      relationshipType: 'uses',
      weight: 1.0,
      metadata: {},
    });

    const result = handleQueryKnowledge(db, 'What about `AuthService`?');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.content[0]!.text).toContain('TokenStore');
    expect(result.content[0]!.text.length).toBeGreaterThan(0);
  });

  it('returns empty message when graph is empty', () => {
    const result = handleQueryKnowledge(db, '`SomeModule`');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.content[0]!.text).toBe('No knowledge stored yet.');
  });

  it('returns empty message when no entry points extracted', () => {
    createNode(db, {
      name: 'AuthService',
      nodeType: 'concept',
      description: 'Handles user authentication',
      affectedFiles: ['src/auth.ts'],
      strength: 1.0,
      metadata: {},
    });

    const result = handleQueryKnowledge(db, 'tell me about stuff');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.content[0]!.text).toBe('No knowledge stored yet.');
  });

  it('returns empty message for empty string question', () => {
    const result = handleQueryKnowledge(db, '');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.content[0]!.text).toBe('No knowledge stored yet.');
  });

  it('runMcp is exported as a function', () => {
    expect(typeof runMcp).toBe('function');
  });
});
