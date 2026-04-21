import { describe, it, expect } from 'vitest';
import { initializeSchema } from '../db/migrations.js';
import { createNode } from '../db/graph.js';
import { getFileAnnotations } from '../core/involuntary.js';
import type { CreateNodeInput } from '../types.js';

function freshDb() {
  return initializeSchema(':memory:');
}

function makeNode(db: ReturnType<typeof freshDb>, overrides?: Partial<CreateNodeInput>) {
  return createNode(db, {
    name: 'node',
    nodeType: 'concept',
    description: 'test',
    affectedFiles: [],
    strength: 1.0,
    metadata: {},
    ...overrides,
  });
}

describe('getFileAnnotations', () => {
  it('returns top 3 annotations sorted by strength descending', () => {
    const db = freshDb();
    const file = 'src/app.ts';
    makeNode(db, { name: 'A', strength: 0.9, affectedFiles: [file] });
    makeNode(db, { name: 'B', strength: 0.8, affectedFiles: [file] });
    makeNode(db, { name: 'C', strength: 0.7, affectedFiles: [file] });
    makeNode(db, { name: 'D', strength: 0.6, affectedFiles: [file] });

    const results = getFileAnnotations(db, file, new Set());

    expect(results).toHaveLength(3);
    expect(results[0]!.name).toBe('A');
    expect(results[1]!.name).toBe('B');
    expect(results[2]!.name).toBe('C');
    expect(results[0]!.strength).toBe(0.9);
  });

  it('returns empty array for seen files', () => {
    const db = freshDb();
    const file = 'src/app.ts';
    makeNode(db, { name: 'A', strength: 0.9, affectedFiles: [file] });

    const results = getFileAnnotations(db, file, new Set([file]));

    expect(results).toEqual([]);
  });

  it('excludes nodes with strength <= 0.5', () => {
    const db = freshDb();
    const file = 'src/app.ts';
    makeNode(db, { name: 'Strong', strength: 0.8, affectedFiles: [file] });
    makeNode(db, { name: 'Boundary', strength: 0.5, affectedFiles: [file] });
    makeNode(db, { name: 'Weak', strength: 0.3, affectedFiles: [file] });

    const results = getFileAnnotations(db, file, new Set());

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('Strong');
  });

  it('returns empty array when file has no linked nodes', () => {
    const db = freshDb();
    makeNode(db, { name: 'Unrelated', strength: 0.9, affectedFiles: ['other.ts'] });

    const results = getFileAnnotations(db, 'src/app.ts', new Set());

    expect(results).toEqual([]);
  });
});
