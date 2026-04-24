import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  progressVelocity,
  searchToActRatio,
  errorRepetition,
  computeMetrics,
  appendMetrics,
} from '../core/metacognitive.js';
import type { EngramEvent } from '../types.js';

function makeEvent(type: string, overrides?: Record<string, unknown>): EngramEvent {
  return { type, sessionId: 'test-session', timestamp: new Date().toISOString(), ...overrides } as EngramEvent;
}

describe('progressVelocity', () => {
  it('returns zero for empty events', () => {
    const result = progressVelocity([]);
    expect(result).toEqual({ currentVelocity: 0, trend: 'stable', uniqueFilesWritten: 0, windowSize: 0 });
  });

  it('detects declining velocity when writes concentrated in first half', () => {
    const events: EngramEvent[] = [];
    for (let i = 0; i < 10; i++) {
      if (i < 5) {
        events.push(makeEvent('file_write', { filePath: `/src/file${i}.ts`, linesChanged: 10, evidenceSnippet: '' }));
      } else {
        events.push(makeEvent('file_read', { filePath: `/src/file${i}.ts` }));
      }
    }
    for (let i = 0; i < 10; i++) {
      if (i === 0) {
        events.push(makeEvent('file_write', { filePath: '/src/late.ts', linesChanged: 5, evidenceSnippet: '' }));
      } else {
        events.push(makeEvent('file_read', { filePath: `/src/read${i}.ts` }));
      }
    }
    const result = progressVelocity(events);
    expect(result.trend).toBe('declining');
    expect(result.windowSize).toBe(20);
    expect(result.uniqueFilesWritten).toBe(6);
  });

  it('detects stable velocity', () => {
    const events: EngramEvent[] = [];
    // 2 writes in first half (indices 0-9), 2 writes in second half (indices 10-19)
    const writeIndices = new Set([2, 7, 12, 17]);
    for (let i = 0; i < 20; i++) {
      if (writeIndices.has(i)) {
        events.push(makeEvent('file_write', { filePath: `/src/file${i}.ts`, linesChanged: 1, evidenceSnippet: '' }));
      } else {
        events.push(makeEvent('file_read', { filePath: `/src/read${i}.ts` }));
      }
    }
    const result = progressVelocity(events);
    expect(result.trend).toBe('stable');
  });
});

describe('searchToActRatio', () => {
  it('flags concerning when all three gate conditions met', () => {
    const events: EngramEvent[] = [];
    events.push(makeEvent('file_write', { filePath: '/src/a.ts', linesChanged: 1, evidenceSnippet: '' }));
    for (let i = 0; i < 19; i++) {
      const dir = `/src/dir${i % 5}`;
      events.push(makeEvent('file_read', { filePath: `${dir}/file${i}.ts` }));
    }
    const result = searchToActRatio(events);
    expect(result.ratio).toBe(19);
    expect(result.progressFraction).toBe(1.0);
    expect(result.directorySpread).toBeGreaterThan(3);
    expect(result.isConcerning).toBe(true);
  });

  it('not concerning when ratio high but too early in session', () => {
    const events: EngramEvent[] = [];
    for (let i = 0; i < 8; i++) {
      events.push(makeEvent('file_read', { filePath: `/src/dir${i}/file.ts` }));
    }
    const result = searchToActRatio(events);
    expect(result.ratio).toBe(8);
    expect(result.progressFraction).toBeLessThanOrEqual(0.5);
    expect(result.isConcerning).toBe(false);
  });

  it('not concerning when ratio high but low directory spread', () => {
    const events: EngramEvent[] = [];
    events.push(makeEvent('file_write', { filePath: '/src/a.ts', linesChanged: 1, evidenceSnippet: '' }));
    for (let i = 0; i < 19; i++) {
      events.push(makeEvent('file_read', { filePath: `/src/samedir/file${i}.ts` }));
    }
    const result = searchToActRatio(events);
    expect(result.ratio).toBe(19);
    expect(result.progressFraction).toBe(1.0);
    expect(result.directorySpread).toBeLessThanOrEqual(3);
    expect(result.isConcerning).toBe(false);
  });
});

describe('errorRepetition', () => {
  it('2 fix-fail cycles is not concerning', () => {
    const events: EngramEvent[] = [
      makeEvent('fix_attempt', { filePath: '/src/bug.ts' }),
      makeEvent('test_run', { command: 'vitest', exitCode: 1, passed: false }),
      makeEvent('fix_attempt', { filePath: '/src/bug.ts' }),
      makeEvent('test_run', { command: 'vitest', exitCode: 1, passed: false }),
    ];
    const result = errorRepetition(events);
    expect(result.repeatedErrors).toHaveLength(1);
    expect(result.repeatedErrors[0]!.count).toBe(2);
    expect(result.hasConcerningRepetitions).toBe(false);
  });

  it('3 fix-fail cycles is concerning', () => {
    const events: EngramEvent[] = [
      makeEvent('fix_attempt', { filePath: '/src/bug.ts' }),
      makeEvent('test_run', { command: 'vitest', exitCode: 1, passed: false }),
      makeEvent('fix_attempt', { filePath: '/src/bug.ts' }),
      makeEvent('test_run', { command: 'vitest', exitCode: 1, passed: false }),
      makeEvent('fix_attempt', { filePath: '/src/bug.ts' }),
      makeEvent('test_run', { command: 'vitest', exitCode: 1, passed: false }),
    ];
    const result = errorRepetition(events);
    expect(result.repeatedErrors).toHaveLength(1);
    expect(result.repeatedErrors[0]!.count).toBe(3);
    expect(result.hasConcerningRepetitions).toBe(true);
  });

  it('successful test resets counter', () => {
    const events: EngramEvent[] = [
      makeEvent('fix_attempt', { filePath: '/src/bug.ts' }),
      makeEvent('test_run', { command: 'vitest', exitCode: 1, passed: false }),
      makeEvent('fix_attempt', { filePath: '/src/bug.ts' }),
      makeEvent('test_run', { command: 'vitest', exitCode: 1, passed: false }),
      makeEvent('fix_attempt', { filePath: '/src/bug.ts' }),
      makeEvent('test_run', { command: 'vitest', exitCode: 0, passed: true }),
      makeEvent('fix_attempt', { filePath: '/src/bug.ts' }),
      makeEvent('test_run', { command: 'vitest', exitCode: 1, passed: false }),
    ];
    const result = errorRepetition(events);
    expect(result.repeatedErrors).toHaveLength(0);
    expect(result.hasConcerningRepetitions).toBe(false);
  });
});

describe('computeMetrics', () => {
  it('aggregates all three metrics', () => {
    const events: EngramEvent[] = [
      makeEvent('file_write', { filePath: '/src/a.ts', linesChanged: 1, evidenceSnippet: '' }),
      makeEvent('file_read', { filePath: '/src/b.ts' }),
    ];
    const result = computeMetrics(events);
    expect(result).toHaveProperty('progressVelocity');
    expect(result).toHaveProperty('searchToActRatio');
    expect(result).toHaveProperty('errorRepetition');
    expect(result.progressVelocity.uniqueFilesWritten).toBe(1);
    expect(result.searchToActRatio.reads).toBe(1);
    expect(result.searchToActRatio.writes).toBe(1);
    expect(result.errorRepetition.repeatedErrors).toHaveLength(0);
  });
});

describe('appendMetrics', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates metrics dir and writes valid JSONL', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-metrics-'));
    const events: EngramEvent[] = [
      makeEvent('file_write', { filePath: '/src/a.ts', linesChanged: 1, evidenceSnippet: '' }),
      makeEvent('file_read', { filePath: '/src/b.ts' }),
    ];
    const metrics = computeMetrics(events);
    appendMetrics('sess-1', metrics, tmpDir);

    const filePath = path.join(tmpDir, 'metrics', 'sess-1.metrics.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);

    const line = fs.readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(line);
    expect(parsed.sessionId).toBe('sess-1');
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed).toHaveProperty('progressVelocity');
    expect(parsed).toHaveProperty('searchToActRatio');
    expect(parsed).toHaveProperty('errorRepetition');
  });

  it('appends multiple lines', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-metrics-'));
    const metrics = computeMetrics([]);
    appendMetrics('sess-2', metrics, tmpDir);
    appendMetrics('sess-2', metrics, tmpDir);

    const filePath = path.join(tmpDir, 'metrics', 'sess-2.metrics.jsonl');
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).sessionId).toBe('sess-2');
    expect(JSON.parse(lines[1]!).sessionId).toBe('sess-2');
  });

  it('does not throw when appendFileSync fails', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-metrics-'));
    vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    try {
      expect(() => appendMetrics('sess-3', computeMetrics([]), tmpDir)).not.toThrow();
    } finally {
      vi.mocked(fs.appendFileSync).mockRestore();
    }
  });
});
