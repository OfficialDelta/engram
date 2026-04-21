#!/usr/bin/env node
import { readFileSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeSchema } from '../../db/migrations.js';
import { getDataDir, getDbPath, ensureDataDirs } from '../../core/project-identity.js';
import { saveSessionState, type SessionState } from '../../core/session-state.js';
import { buildContext } from '../../core/context-builder.js';
import { spreadingActivation } from '../../core/retrieval.js';
import { findUnconsolidatedSessions, spawnConsolidation, findFailedConsolidations } from '../../core/consolidation.js';
import type { EntryPoint } from '../../types.js';

function logError(dataDir: string, message: string): void {
  try {
    const logDir = join(dataDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'session-start.log'), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // logging itself must never throw
  }
}

export function getRecentFileEntryPoints(dataDir: string): EntryPoint[] {
  try {
    const eventsDir = join(dataDir, 'events');
    const files = readdirSync(eventsDir).filter(f => f.endsWith('.jsonl'));
    if (files.length === 0) return [];

    const sorted = files
      .map(f => ({ name: f, path: join(eventsDir, f) }))
      .sort((a, b) => {
        try {
          const aStat = readFileSync(a.path, 'utf-8');
          const bStat = readFileSync(b.path, 'utf-8');
          const aLines = aStat.trim().split('\n');
          const bLines = bStat.trim().split('\n');
          const aLast = JSON.parse(aLines[aLines.length - 1]!) as { timestamp?: string };
          const bLast = JSON.parse(bLines[bLines.length - 1]!) as { timestamp?: string };
          return (bLast.timestamp ?? '').localeCompare(aLast.timestamp ?? '');
        } catch {
          return 0;
        }
      });

    const mostRecent = sorted[0];
    if (!mostRecent) return [];

    const content = readFileSync(mostRecent.path, 'utf-8');
    const filePaths = new Set<string>();

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { type?: string; filePath?: string };
        if (event.type === 'file_write' && event.filePath) {
          filePaths.add(event.filePath);
        }
      } catch {
        // skip malformed lines
      }
    }

    return [...filePaths].map(value => ({ type: 'file' as const, value }));
  } catch {
    return [];
  }
}

export function processSessionStart(
  sessionId: string,
  dataDir: string,
  dbPath: string,
): Record<string, unknown> {
  const db = initializeSchema(dbPath);

  const unconsolidated = findUnconsolidatedSessions(dataDir);
  for (const oldSessionId of unconsolidated) {
    spawnConsolidation(oldSessionId, dbPath, dataDir);
  }

  const defaultState: SessionState = {
    seenFiles: [],
    contradictionFailures: 0,
    contradictionDisabled: false,
    pendingContradictions: [],
    turnCount: 0,
    toolCallCount: 0,
  };
  saveSessionState(dataDir, sessionId, defaultState);

  let additionalContext = '';
  try {
    const failures = findFailedConsolidations(dataDir);
    if (failures.length > 0) {
      const lastError = failures.reduce((a, b) => (a.timestamp > b.timestamp ? a : b));
      additionalContext += `[engram] Warning: ${failures.length} previous consolidation(s) failed. Recent error: ${lastError.error}\nRun "engram status" for details or delete .engram/episodes/*.failed.json to retry.\n\n`;
    }
  } catch {
    // P004: failure marker reading must never throw
  }
  try {
    const entryPoints = getRecentFileEntryPoints(dataDir);
    if (entryPoints.length > 0) {
      const tieredResults = spreadingActivation(db, entryPoints);
      additionalContext = buildContext([], [], tieredResults);
    }
  } catch (err) {
    logError(dataDir, `Spreading activation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  db.close();

  if (additionalContext) {
    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    };
  }
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

    const result = processSessionStart(sessionId, dataDir, dbPath);
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  } catch (err) {
    try {
      const cwd = process.cwd();
      const dataDir = getDataDir(cwd);
      logError(dataDir, `SessionStart handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
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
