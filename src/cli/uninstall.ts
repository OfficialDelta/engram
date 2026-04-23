#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { getDataDir } from '../core/project-identity.js';

const HOOK_EVENTS = {
  PostToolUse: {},
  SessionStart: {},
  UserPromptSubmit: {},
  Stop: {},
} as const;

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

export function removeHooks(settings: Record<string, unknown>): { removed: number } {
  const hooks = settings['hooks'] as HooksMap | undefined;
  if (!hooks) return { removed: 0 };

  let removed = 0;

  for (const event of Object.keys(HOOK_EVENTS)) {
    const raw = hooks[event];
    if (!raw) continue;
    const matchers = normalizeEvent(raw);
    hooks[event] = matchers;

    for (const matcher of matchers) {
      const before = matcher.hooks.length;
      matcher.hooks = matcher.hooks.filter(
        (h) => !(typeof h.command === 'string' && h.command.includes('engram')),
      );
      removed += before - matcher.hooks.length;
    }

    hooks[event] = matchers.filter((m) => m.hooks.length > 0);
    if (hooks[event]!.length === 0) {
      delete hooks[event];
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete settings['hooks'];
  }

  return { removed };
}

export interface UninstallOptions {
  claudeConfigDir: string;
  cwd: string;
  purge?: boolean;
}

export function runUninstall(options: UninstallOptions): {
  hooksRemoved: number;
  settingsPath: string;
  dataDirRemoved: boolean;
  dataDir: string;
} {
  const settingsPath = join(options.claudeConfigDir, 'settings.json');
  const settings = readSettings(settingsPath);
  const { removed } = removeHooks(settings);

  if (removed > 0) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  const dataDir = getDataDir(options.cwd);
  let dataDirRemoved = false;

  if (options.purge && existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDirRemoved = true;
  }

  return { hooksRemoved: removed, settingsPath, dataDirRemoved, dataDir };
}

function printUsage(): void {
  console.log(`Usage: engram uninstall [options]

Removes engram hooks from ~/.claude/settings.json.

Options:
  --purge  Also remove the engram data directory
  --help   Show this help message`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  try {
    const purge = args.includes('--purge');
    const result = runUninstall({
      claudeConfigDir: join(homedir(), '.claude'),
      cwd: process.cwd(),
      purge,
    });

    if (result.hooksRemoved > 0) {
      console.log(`  ✓ Removed ${result.hooksRemoved} hook(s) from ${result.settingsPath}`);
    } else {
      console.log('  No engram hooks found in settings.');
    }
    if (result.dataDirRemoved) {
      console.log(`  ✓ Removed data directory ${result.dataDir}`);
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
