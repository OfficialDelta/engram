#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { ensureDataDirs, getDbPath } from '../adapters/claude-code/project-identity.js';
import { initializeSchema } from '../db/migrations.js';

const HOOK_EVENTS = {
  PostToolUse: { handler: 'post-tool-use', timeout: 10 },
  SessionStart: { handler: 'session-start', timeout: 30 },
  UserPromptSubmit: { handler: 'user-prompt-submit', timeout: 30 },
  Stop: { handler: 'stop', timeout: 10 },
} as const;

function resolveHookDir(): string {
  const distCli = dirname(fileURLToPath(import.meta.url));
  const distDir = dirname(distCli);
  return join(distDir, 'adapters', 'claude-code');
}

function printUsage(): void {
  console.log(`Usage: engram install

Registers engram hooks in ~/.claude/settings.json,
creates data directories, and initializes the database.

Options:
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
    console.error(`Error: ${settingsPath} contains malformed JSON. Fix it manually and re-run.`);
    process.exit(1);
  }
}

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
}

interface HooksMap {
  [event: string]: { hooks?: HookEntry[] } | undefined;
}

function mergeHooks(settings: Record<string, unknown>, hookDir: string): void {
  const hooks = (settings['hooks'] ?? {}) as HooksMap;
  settings['hooks'] = hooks;

  for (const [event, config] of Object.entries(HOOK_EVENTS)) {
    const eventBlock = hooks[event] ?? { hooks: [] };
    hooks[event] = eventBlock;
    const hookList = eventBlock.hooks ?? [];
    eventBlock.hooks = hookList;

    const alreadyInstalled = hookList.some(
      (h) => typeof h.command === 'string' && h.command.includes('engram'),
    );
    if (alreadyInstalled) continue;

    hookList.push({
      type: 'command',
      command: `node ${join(hookDir, `${config.handler}.js`)}`,
      timeout: config.timeout,
    });
  }
}

function validateInstall(settingsPath: string): string[] {
  const settings = readSettings(settingsPath);
  const hooks = settings['hooks'] as HooksMap | undefined;
  const missing: string[] = [];
  for (const event of Object.keys(HOOK_EVENTS)) {
    const eventBlock = hooks?.[event];
    const hookList = eventBlock?.hooks ?? [];
    const found = hookList.some(
      (h) => typeof h.command === 'string' && h.command.includes('engram'),
    );
    if (!found) missing.push(event);
  }
  return missing;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  const hookDir = resolveHookDir();
  const warnings: string[] = [];

  const missingHandlers = Object.values(HOOK_EVENTS).filter(
    (config) => !existsSync(join(hookDir, `${config.handler}.js`)),
  );
  if (missingHandlers.length > 0) {
    warnings.push(
      'Hook handler files not found at expected paths. ' +
      'If running via npx from a temp cache, install globally instead: npm install -g engram',
    );
  }

  const claudeDir = join(homedir(), '.claude');
  mkdirSync(claudeDir, { recursive: true });

  const settingsPath = join(claudeDir, 'settings.json');
  const settings = readSettings(settingsPath);
  mergeHooks(settings, hookDir);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  const cwd = process.cwd();
  const dataDir = ensureDataDirs(cwd);
  const dbPath = getDbPath(cwd);
  const db = initializeSchema(dbPath);
  db.close();

  const missing = validateInstall(settingsPath);
  if (missing.length > 0) {
    console.error(`Error: Validation failed — missing hook entries for: ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log('engram installed successfully:\n');
  console.log(`  ✓ Hooks registered in ${settingsPath}`);
  console.log(`  ✓ Data directory created at ${dataDir}`);
  console.log(`  ✓ Database initialized at ${dbPath}`);
  if (warnings.length > 0) {
    console.log('');
    for (const w of warnings) {
      console.log(`  ⚠ ${w}`);
    }
  }
}

main();
