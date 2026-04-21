#!/usr/bin/env node
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTurnCompleteEvent, appendEvent, getSessionEvents } from '../../core/event-stream.js';
import { getDataDir, getDbPath, ensureDataDirs } from '../../core/project-identity.js';
import { loadSessionState, saveSessionState } from '../../core/session-state.js';
import { spawnConsolidation } from '../../core/consolidation.js';

const CONSOLIDATION_TURN_THRESHOLD = 5;
const CONSOLIDATION_EVENT_THRESHOLD = 50;

function logError(dataDir: string, message: string): void {
  try {
    const logDir = join(dataDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'stop.log'), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // logging itself must never throw
  }
}

export function processStop(
  sessionId: string,
  dataDir: string,
  dbPath: string,
): Record<string, unknown> {
  const state = loadSessionState(dataDir, sessionId);
  state.turnCount++;

  const turnEvent = buildTurnCompleteEvent(sessionId, state.toolCallCount, state.turnCount);
  appendEvent(sessionId, turnEvent, dataDir);

  state.toolCallCount = 0;
  saveSessionState(dataDir, sessionId, state);

  const shouldConsolidate =
    state.turnCount >= CONSOLIDATION_TURN_THRESHOLD ||
    getSessionEvents(sessionId, dataDir).length >= CONSOLIDATION_EVENT_THRESHOLD;

  if (shouldConsolidate) {
    spawnConsolidation(sessionId, dbPath, dataDir);
  }

  return {};
}

function main(): void {
  try {
    const stdin = readFileSync('/dev/stdin', 'utf-8');
    const input = JSON.parse(stdin) as Record<string, unknown>;

    const cwd = (input.cwd as string) ?? process.cwd();
    const sessionId = input.session_id as string;

    const dataDir = ensureDataDirs(cwd);
    const dbPath = getDbPath(cwd);

    processStop(sessionId, dataDir, dbPath);
    process.stdout.write('{}');
    process.exit(0);
  } catch (err) {
    try {
      const cwd = process.cwd();
      const dataDir = getDataDir(cwd);
      logError(dataDir, `Stop handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
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
