#!/usr/bin/env node
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyToolCall, appendEvent, detectDerivedEvents, getSessionEvents } from '../../core/event-stream.js';
import { getFileAnnotations } from '../../core/involuntary.js';
import { initializeSchema } from '../../db/migrations.js';
import { getDataDir, getDbPath, ensureDataDirs } from '../../core/project-identity.js';
import { loadSessionState, saveSessionState } from '../../core/session-state.js';
import { buildContext } from '../../core/context-builder.js';
import type { RawToolCall, Annotation, FileReadEvent, FileWriteEvent } from '../../types.js';

function logError(dataDir: string, message: string): void {
  try {
    const logDir = join(dataDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, 'post-tool-use.log');
    appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // logging itself must never throw
  }
}

export function spawnContradictionCheck(
  sessionId: string,
  dbPath: string,
  dataDir: string,
  filePath: string,
  evidenceSnippet: string,
): void {
  try {
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'contradiction-worker.js');
    const child = spawn(process.execPath, [workerPath, sessionId, dbPath, dataDir, filePath, evidenceSnippet], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    logError(dataDir, `Failed to spawn contradiction worker: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type PostToolUseDeps = {
  spawnCheck?: typeof spawnContradictionCheck;
};

export function processPostToolUse(
  rawToolCall: RawToolCall,
  dataDir: string,
  dbPath: string,
  deps?: PostToolUseDeps,
): Record<string, unknown> {
  const doSpawnCheck = deps?.spawnCheck ?? spawnContradictionCheck;

  const event = classifyToolCall(rawToolCall);
  if (!event) return {};

  appendEvent(rawToolCall.session_id, event, dataDir);

  const priorEvents = getSessionEvents(rawToolCall.session_id, dataDir);
  const derivedEvents = detectDerivedEvents(event, priorEvents);
  for (const derived of derivedEvents) {
    appendEvent(rawToolCall.session_id, derived, dataDir);
  }

  const state = loadSessionState(dataDir, rawToolCall.session_id);
  state.toolCallCount++;

  let annotations: Annotation[] = [];

  if (event.type === 'file_read') {
    const readEvent = event as FileReadEvent;
    if (!state.seenFiles.includes(readEvent.filePath)) {
      try {
        const db = initializeSchema(dbPath);
        annotations = getFileAnnotations(db, readEvent.filePath, new Set(state.seenFiles));
        db.close();
      } catch (err) {
        logError(dataDir, `getFileAnnotations failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      state.seenFiles.push(readEvent.filePath);
    }
  }

  if (event.type === 'file_write') {
    const writeEvent = event as FileWriteEvent;
    doSpawnCheck(
      rawToolCall.session_id,
      dbPath,
      dataDir,
      writeEvent.filePath,
      writeEvent.evidenceSnippet,
    );
  }

  const pendingContradictions = state.pendingContradictions;
  state.pendingContradictions = [];

  const additionalContext = buildContext(
    pendingContradictions,
    annotations,
    { high: [], medium: [], low: [] },
  );

  saveSessionState(dataDir, rawToolCall.session_id, state);

  if (additionalContext) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext,
      },
    };
  }
  return {};
}

function main(): void {
  try {
    const cwd = process.cwd();
    const dataDir = ensureDataDirs(cwd);
    const dbPath = getDbPath(cwd);

    const stdin = readFileSync(0, 'utf-8');
    const input = JSON.parse(stdin) as Record<string, unknown>;

    const rawToolCall: RawToolCall = {
      tool_name: input.tool_name as string,
      tool_input: (input.tool_input as Record<string, unknown>) ?? {},
      session_id: input.session_id as string,
    };

    const result = processPostToolUse(rawToolCall, dataDir, dbPath);
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  } catch (err) {
    try {
      const cwd = process.cwd();
      const dataDir = getDataDir(cwd);
      logError(dataDir, `PostToolUse handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    } catch {
      // final fallback — can't even log
    }
    process.stdout.write('{}');
    process.exit(0);
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
