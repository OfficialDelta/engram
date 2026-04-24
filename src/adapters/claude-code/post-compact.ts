#!/usr/bin/env node
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDataDir, getDbPath, ensureDataDirs } from '../../core/project-identity.js';
import { spawnConsolidation } from '../../core/consolidation.js';
import { loadConfig } from '../../core/config.js';

function logError(dataDir: string, message: string): void {
  try {
    const logDir = join(dataDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'post-compact.log'), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // logging itself must never throw
  }
}

export function processPostCompact(
  sessionId: string,
  dataDir: string,
  dbPath: string,
): Record<string, unknown> {
  const cfg = loadConfig();

  if (!cfg.llm.apiKey && !process.env.ANTHROPIC_API_KEY) {
    logError(dataDir, 'Consolidation skipped: no API key configured. Run "engram config" to set up.');
    return {};
  }

  spawnConsolidation(sessionId, dbPath, dataDir);
  return {};
}

function main(): void {
  try {
    const stdin = readFileSync(0, 'utf-8');
    const input = JSON.parse(stdin) as Record<string, unknown>;

    const cwd = (input.cwd as string) ?? process.cwd();
    const sessionId = input.session_id as string;

    const dataDir = ensureDataDirs(cwd);
    const dbPath = getDbPath(cwd);

    processPostCompact(sessionId, dataDir, dbPath);
    process.stdout.write('{}');
    process.exit(0);
  } catch (err) {
    try {
      const cwd = process.cwd();
      const dataDir = getDataDir(cwd);
      logError(dataDir, `PostCompact handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    } catch {
      // final fallback
    }
    process.stdout.write('{}');
    process.exit(0);
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
