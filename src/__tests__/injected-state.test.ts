import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readModifyWriteInjected } from '../core/injected-state.js';

describe('readModifyWriteInjected', () => {
  let dir: string;
  let injectedPath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `engram-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    injectedPath = join(dir, 'test.injected.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends new IDs to existing injected file', () => {
    writeFileSync(injectedPath, JSON.stringify(['a']));
    readModifyWriteInjected(injectedPath, ['b']);
    const result = JSON.parse(readFileSync(injectedPath, 'utf-8'));
    expect(result).toEqual(['a', 'b']);
  });

  it('creates file when it does not exist', () => {
    readModifyWriteInjected(injectedPath, ['a']);
    const result = JSON.parse(readFileSync(injectedPath, 'utf-8'));
    expect(result).toEqual(['a']);
  });

  it('handles concurrent writes without data loss', async () => {
    writeFileSync(injectedPath, JSON.stringify([]));

    await Promise.all([
      new Promise<void>(resolve => { readModifyWriteInjected(injectedPath, ['x1']); resolve(); }),
      new Promise<void>(resolve => { readModifyWriteInjected(injectedPath, ['x2']); resolve(); }),
      new Promise<void>(resolve => { readModifyWriteInjected(injectedPath, ['x3']); resolve(); }),
    ]);

    const result: string[] = JSON.parse(readFileSync(injectedPath, 'utf-8'));
    expect(result).toContain('x1');
    expect(result).toContain('x2');
    expect(result).toContain('x3');
  });

  it('recovers from stale lock file', () => {
    writeFileSync(injectedPath, JSON.stringify(['existing']));
    const lockPath = `${injectedPath}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, acquiredAt: '2020-01-01T00:00:00Z' }));
    const pastTime = new Date(Date.now() - 2000);
    utimesSync(lockPath, pastTime, pastTime);

    readModifyWriteInjected(injectedPath, ['new']);

    const result = JSON.parse(readFileSync(injectedPath, 'utf-8'));
    expect(result).toEqual(['existing', 'new']);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('degrades gracefully when lock cannot be acquired', () => {
    writeFileSync(injectedPath, JSON.stringify(['existing']));
    const lockPath = `${injectedPath}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));

    readModifyWriteInjected(injectedPath, ['fallback']);

    const result = JSON.parse(readFileSync(injectedPath, 'utf-8'));
    expect(result).toEqual(['existing', 'fallback']);

    rmSync(lockPath, { force: true });
  });
});
