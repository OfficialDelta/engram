import { randomUUID } from 'node:crypto';
import { initializeSchema } from './db/migrations.js';
import { getDataDir, getDbPath, ensureDataDirs } from './core/project-identity.js';
import { loadSessionState, saveSessionState, type SessionState } from './core/session-state.js';
import { classifyToolCall, appendEvent, detectDerivedEvents, getSessionEvents, buildTurnCompleteEvent } from './core/event-stream.js';
import { getFileAnnotations } from './core/involuntary.js';
import { buildContext } from './core/context-builder.js';
import { spreadingActivation } from './core/retrieval.js';
import { findUnconsolidatedSessions, spawnConsolidation } from './core/consolidation.js';
import { getRecentFileEntryPoints } from './adapters/claude-code/session-start.js';
import { extractEntryPoints } from './core/entry-points.js';
import type { AdapterConfig, AdapterSession, ToolCallResult, RawToolCall, Annotation, FileReadEvent, FileWriteEvent } from './types.js';

const CONSOLIDATION_TURN_THRESHOLD = 5;
const CONSOLIDATION_EVENT_THRESHOLD = 50;

export function createSession(config?: AdapterConfig): AdapterSession {
  const cwd = config?.cwd ?? process.cwd();
  const dataDir = config?.dataDir ?? ensureDataDirs(cwd);
  const dbPath = config?.dbPath ?? getDbPath(cwd);
  const sessionId = config?.sessionId ?? randomUUID();

  const db = initializeSchema(dbPath);

  const defaultState: SessionState = {
    seenFiles: [],
    contradictionFailures: 0,
    contradictionDisabled: false,
    pendingContradictions: [],
    turnCount: 0,
    toolCallCount: 0,
  };
  saveSessionState(dataDir, sessionId, defaultState);

  return {
    sessionId,
    dataDir,
    dbPath,
    db,
    close() {
      db.close();
    },
  };
}

export function onToolCall(session: AdapterSession, toolCall: RawToolCall): ToolCallResult {
  const { sessionId, dataDir, dbPath, db } = session;

  const event = classifyToolCall(toolCall);
  if (!event) {
    return { context: '', events: [] };
  }
  if (toolCall.tags) {
    event.tags = toolCall.tags;
  }

  appendEvent(sessionId, event, dataDir);

  const priorEvents = getSessionEvents(sessionId, dataDir);
  const derivedEvents = detectDerivedEvents(event, priorEvents);
  for (const derived of derivedEvents) {
    appendEvent(sessionId, derived, dataDir);
  }

  const state = loadSessionState(dataDir, sessionId);
  state.toolCallCount++;

  let annotations: Annotation[] = [];

  if (event.type === 'file_read') {
    const readEvent = event as FileReadEvent;
    if (!state.seenFiles.includes(readEvent.filePath)) {
      try {
        annotations = getFileAnnotations(db, readEvent.filePath, new Set(state.seenFiles));
      } catch {
        // annotation lookup failures are non-fatal
      }
      state.seenFiles.push(readEvent.filePath);
    }
  }

  const pendingContradictions = state.pendingContradictions;
  state.pendingContradictions = [];

  const context = buildContext(
    pendingContradictions,
    annotations,
    { high: [], medium: [], low: [] },
  );

  saveSessionState(dataDir, sessionId, state);

  const allEvents = getSessionEvents(sessionId, dataDir);
  return { context, events: allEvents };
}

export function onSessionStart(session: AdapterSession): { context: string } {
  const { sessionId, dataDir, dbPath, db } = session;

  const unconsolidated = findUnconsolidatedSessions(dataDir);
  for (const oldSessionId of unconsolidated) {
    spawnConsolidation(oldSessionId, dbPath, dataDir);
  }

  let context = '';
  try {
    const entryPoints = getRecentFileEntryPoints(dataDir);
    if (entryPoints.length > 0) {
      const tieredResults = spreadingActivation(db, entryPoints);
      context = buildContext([], [], tieredResults);
    }
  } catch {
    // retrieval failures are non-fatal
  }

  return { context };
}

export function onPrompt(session: AdapterSession, prompt: string): { context: string } {
  const { db } = session;

  const entryPoints = extractEntryPoints(prompt);
  if (entryPoints.length === 0) {
    return { context: '' };
  }

  let context = '';
  try {
    const tieredResults = spreadingActivation(db, entryPoints);
    context = buildContext([], [], tieredResults);
  } catch {
    // retrieval failures are non-fatal
  }

  return { context };
}

export function onStop(session: AdapterSession): void {
  const { sessionId, dataDir, dbPath } = session;

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
}
