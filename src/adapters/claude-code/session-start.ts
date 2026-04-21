#!/usr/bin/env node
import { readFileSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSchema } from '../../db/migrations.js';
import { getDataDir, getDbPath, ensureDataDirs } from './project-identity.js';
import { saveSessionState, type SessionState } from './session-state.js';
import { buildContext } from './context-builder.js';
import { spreadingActivation } from '../../core/retrieval.js';
import { findUnconsolidatedSessions, spawnConsolidation } from '../../core/consolidation.js';
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

function getRecentFileEntryPoints(dataDir: string): EntryPoint[] {
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

try {
  const stdin = readFileSync('/dev/stdin', 'utf-8');
  const input = JSON.parse(stdin) as Record<string, unknown>;

  const cwd = (input.cwd as string) ?? process.cwd();
  const sessionId = input.session_id as string;

  const dataDir = ensureDataDirs(cwd);
  const dbPath = getDbPath(cwd);

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
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    }));
  } else {
    process.stdout.write('{}');
  }
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
