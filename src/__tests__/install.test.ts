import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../core/project-identity.js', () => ({
  ensureDataDirs: vi.fn((cwd: string) => {
    const dataDir = path.join(cwd, '.engram-data');
    fs.mkdirSync(dataDir, { recursive: true });
    return dataDir;
  }),
  getDbPath: vi.fn((cwd: string) => path.join(cwd, '.engram-data', 'engram.db')),
}));

vi.mock('../db/migrations.js', () => ({
  initializeSchema: vi.fn(() => ({ close: vi.fn() })),
}));

import { runInstall } from '../cli/install.js';
import { ensureDataDirs } from '../core/project-identity.js';
import { getConfigPath } from '../core/config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-install-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('install CLI', () => {
  function hookDir(): string {
    const d = path.join(tmpDir, 'hooks');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  it('creates settings.json from scratch when file does not exist', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    runInstall({ claudeConfigDir: claudeDir, cwd: tmpDir, hookDir: hookDir() });

    const settingsPath = path.join(claudeDir, 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks).toBeDefined();
  });

  it('merges hooks into existing settings.json without destroying other entries', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ theme: 'dark', custom: { nested: true } }),
    );

    runInstall({ claudeConfigDir: claudeDir, cwd: tmpDir, hookDir: hookDir() });

    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8'));
    expect(settings.theme).toBe('dark');
    expect(settings.custom).toEqual({ nested: true });
    expect(settings.hooks).toBeDefined();
  });

  it('all 4 hook events present in resulting settings.json as matcher arrays', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    runInstall({ claudeConfigDir: claudeDir, cwd: tmpDir, hookDir: hookDir() });

    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8'));
    for (const event of ['PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop']) {
      expect(Array.isArray(settings.hooks[event])).toBe(true);
      expect(settings.hooks[event].length).toBeGreaterThan(0);
      expect(settings.hooks[event][0]).toHaveProperty('matcher');
      expect(settings.hooks[event][0]).toHaveProperty('hooks');
      expect(settings.hooks[event][0].hooks.length).toBeGreaterThan(0);
    }
  });

  it('hook commands contain absolute paths', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    const hd = hookDir();
    runInstall({ claudeConfigDir: claudeDir, cwd: tmpDir, hookDir: hd });

    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8'));
    for (const event of ['PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop']) {
      const allEntries = settings.hooks[event].flatMap(
        (m: { hooks: { command: string }[] }) => m.hooks,
      );
      const entry = allEntries.find(
        (h: { command: string }) => h.command.includes('engram'),
      );
      expect(entry).toBeDefined();
      expect(entry.command).toContain(hd);
      expect(entry.command.startsWith('node ')).toBe(true);
    }
  });

  it('data directories created at expected paths', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    runInstall({ claudeConfigDir: claudeDir, cwd: tmpDir, hookDir: hookDir() });

    expect(ensureDataDirs).toHaveBeenCalledWith(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, '.engram-data'))).toBe(true);
  });

  it('idempotent: running install twice does not duplicate hook entries', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    const hd = hookDir();

    runInstall({ claudeConfigDir: claudeDir, cwd: tmpDir, hookDir: hd });
    runInstall({ claudeConfigDir: claudeDir, cwd: tmpDir, hookDir: hd });

    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8'));
    for (const event of ['PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop']) {
      const allEntries = settings.hooks[event].flatMap(
        (m: { hooks: { command: string }[] }) => m.hooks,
      );
      const engramHooks = allEntries.filter(
        (h: { command: string }) => h.command.includes('engram'),
      );
      expect(engramHooks).toHaveLength(1);
    }
  });

  it('install succeeds and config module is wired (getConfigPath accessible from install context)', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    const hd = hookDir();

    const result = runInstall({ claudeConfigDir: claudeDir, cwd: tmpDir, hookDir: hd });
    expect(result.settingsPath).toBeTruthy();
    expect(result.dataDir).toBeTruthy();
    expect(result.dbPath).toBeTruthy();

    expect(getConfigPath()).toBe(path.join(os.homedir(), '.engram', 'config.json'));
  });
});
