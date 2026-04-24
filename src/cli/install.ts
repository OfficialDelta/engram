#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { ensureDataDirs, getDbPath } from '../core/project-identity.js';
import { initializeSchema } from '../db/migrations.js';
import { getConfigPath } from '../core/config.js';

const HOOK_EVENTS = {
  PostToolUse: { handler: 'post-tool-use', timeout: 10 },
  SessionStart: { handler: 'session-start', timeout: 30 },
  UserPromptSubmit: { handler: 'user-prompt-submit', timeout: 30 },
  Stop: { handler: 'stop', timeout: 10 },
  PostCompact: { handler: 'post-compact', timeout: 10 },
  SessionEnd: { handler: 'session-end', timeout: 10 },
} as const;

function resolveHookDir(): string {
  const distCli = dirname(fileURLToPath(import.meta.url));
  const distDir = dirname(distCli);
  return join(distDir, 'adapters', 'claude-code');
}

function resolveGSDExtensionSource(): string {
  const distCli = dirname(fileURLToPath(import.meta.url));
  const distDir = dirname(distCli);
  return join(distDir, 'adapters', 'gsd', 'index.js');
}

function printUsage(): void {
  console.log(`Usage: engram install [options]

Registers engram hooks in ~/.claude/settings.json,
creates data directories, and initializes the database.

Options:
  --gsd   Install as a GSD ecosystem extension instead of Claude Code hooks
  --help  Show this help message`);
}

function readSettings(settingsPath: string): Record<string, unknown> {
  if (!existsSync(settingsPath)) {
    return {};
  }
  const raw = readFileSync(settingsPath, 'utf-8');
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${settingsPath} contains malformed JSON. Fix it manually and re-run.`);
  }
}

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
}

interface MatcherBlock {
  matcher: string;
  hooks: HookEntry[];
}

interface HooksMap {
  [event: string]: MatcherBlock[] | undefined;
}

function normalizeEvent(raw: unknown): MatcherBlock[] {
  if (Array.isArray(raw)) return raw as MatcherBlock[];
  if (raw && typeof raw === 'object' && 'hooks' in raw) {
    return [{ matcher: '', hooks: (raw as { hooks: HookEntry[] }).hooks }];
  }
  return [];
}

function mergeHooks(settings: Record<string, unknown>, hookDir: string): void {
  const hooks = (settings['hooks'] ?? {}) as HooksMap;
  settings['hooks'] = hooks;

  for (const [event, config] of Object.entries(HOOK_EVENTS)) {
    const matchers = normalizeEvent(hooks[event]);
    hooks[event] = matchers;

    const allHookEntries = matchers.flatMap((m) => m.hooks ?? []);
    const alreadyInstalled = allHookEntries.some(
      (h) => typeof h.command === 'string' && h.command.includes('engram'),
    );
    if (alreadyInstalled) continue;

    matchers.push({
      matcher: '',
      hooks: [{
        type: 'command',
        command: `node ${join(hookDir, `${config.handler}.js`)}`,
        timeout: config.timeout,
      }],
    });
  }
}

function validateInstall(settingsPath: string): string[] {
  const settings = readSettings(settingsPath);
  const hooks = settings['hooks'] as HooksMap | undefined;
  const missing: string[] = [];
  for (const event of Object.keys(HOOK_EVENTS)) {
    const matchers = hooks?.[event] ?? [];
    const allHookEntries = matchers.flatMap((m) => m.hooks ?? []);
    const found = allHookEntries.some(
      (h) => typeof h.command === 'string' && h.command.includes('engram'),
    );
    if (!found) missing.push(event);
  }
  return missing;
}

export interface InstallOptions {
  claudeConfigDir: string;
  cwd: string;
  hookDir?: string;
  gsd?: boolean;
}

export function runInstall(options: InstallOptions): {
  warnings: string[];
  settingsPath: string;
  dataDir: string;
  dbPath: string;
  gsdExtensionPath?: string;
} {
  const warnings: string[] = [];

  const dataDir = ensureDataDirs(options.cwd);
  const dbPath = getDbPath(options.cwd);
  const db = initializeSchema(dbPath);
  db.close();

  if (options.gsd) {
    const source = resolveGSDExtensionSource();
    if (!existsSync(source)) {
      warnings.push(
        'GSD extension file not found at expected path. ' +
        'If running via npx from a temp cache, install globally instead: npm install -g engram',
      );
    }

    const extensionsDir = join(options.cwd, '.gsd', 'extensions');
    mkdirSync(extensionsDir, { recursive: true });
    const dest = join(extensionsDir, 'engram.js');
    copyFileSync(source, dest);

    return { warnings, settingsPath: '', dataDir, dbPath, gsdExtensionPath: dest };
  }

  const hookDir = options.hookDir ?? resolveHookDir();

  const missingHandlers = Object.values(HOOK_EVENTS).filter(
    (config) => !existsSync(join(hookDir, `${config.handler}.js`)),
  );
  if (missingHandlers.length > 0) {
    warnings.push(
      'Hook handler files not found at expected paths. ' +
      'If running via npx from a temp cache, install globally instead: npm install -g engram',
    );
  }

  mkdirSync(options.claudeConfigDir, { recursive: true });

  const settingsPath = join(options.claudeConfigDir, 'settings.json');
  const settings = readSettings(settingsPath);
  mergeHooks(settings, hookDir);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  const missing = validateInstall(settingsPath);
  if (missing.length > 0) {
    throw new Error(`Validation failed — missing hook entries for: ${missing.join(', ')}`);
  }

  return { warnings, settingsPath, dataDir, dbPath };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  try {
    const result = runInstall({
      claudeConfigDir: join(homedir(), '.claude'),
      cwd: process.cwd(),
    });

    console.log('engram installed successfully:\n');
    console.log(`  ✓ Hooks registered in ${result.settingsPath}`);
    console.log(`  ✓ Data directory created at ${result.dataDir}`);
    console.log(`  ✓ Database initialized at ${result.dbPath}`);
    if (result.warnings.length > 0) {
      console.log('');
      for (const w of result.warnings) {
        console.log(`  ⚠ ${w}`);
      }
    }

    if (!existsSync(getConfigPath()) && !args.includes('--skip-config')) {
      console.log('\n  Run `engram config` to set up API keys and preferences.');
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

const argv1Real = (() => { try { return realpathSync(resolve(process.argv[1] ?? '')); } catch { return resolve(process.argv[1] ?? ''); } })();
if (argv1Real === fileURLToPath(import.meta.url)) {
  main();
}
