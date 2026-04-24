import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSchema } from './db/migrations.js';
import { getDataDir, getDbPath, ensureDataDirs } from './core/project-identity.js';
import { loadSessionState, saveSessionState, type SessionState } from './core/session-state.js';
import { classifyToolCall, appendEvent, detectDerivedEvents, getSessionEvents, buildTurnCompleteEvent } from './core/event-stream.js';
import { getFileAnnotations } from './core/involuntary.js';
import { buildContext } from './core/context-builder.js';
import { spreadingActivation } from './core/retrieval.js';
import { findUnconsolidatedSessions, spawnConsolidation } from './core/consolidation.js';
import { extractEntryPoints } from './core/entry-points.js';
import { runMaintenance } from './core/maintenance.js';
import { loadConfig, getMaintenanceConfig } from './core/config.js';
import type { AdapterConfig, AdapterSession, ToolCallResult, RawToolCall, Annotation, FileReadEvent, FileWriteEvent, NodeResult } from './types.js';

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
    { high: [], medium: [] },
  );

  saveSessionState(dataDir, sessionId, state);

  const allEvents = getSessionEvents(sessionId, dataDir);
  return { context, events: allEvents };
}

export function onSessionStart(session: AdapterSession): { context: string } {
  const { sessionId, dataDir, dbPath, db } = session;

  let maintenanceSummary = '';
  try {
    const config = loadConfig();
    const maintConfig = getMaintenanceConfig(config);
    const maintResult = runMaintenance(db, dataDir, maintConfig);
    if (!maintResult.skipped) {
      maintenanceSummary = `[engram] Maintenance: pruned ${maintResult.nodesPruned} stale nodes (${maintResult.durationMs}ms)\n\n`;
    }
  } catch {
    // maintenance must never block session start
  }

  const unconsolidated = findUnconsolidatedSessions(dataDir);
  for (const oldSessionId of unconsolidated) {
    spawnConsolidation(oldSessionId, dbPath, dataDir);
  }

  try {
    writeFileSync(join(dataDir, 'events', `${sessionId}.injected.json`), '[]');
  } catch {
    // P004: injected.json reset must never throw
  }

  let context = maintenanceSummary;

  return { context };
}

export function onPrompt(session: AdapterSession, prompt: string): { context: string } {
  const { sessionId, dataDir, db } = session;

  const entryPoints = extractEntryPoints(prompt);
  if (entryPoints.length === 0) {
    return { context: '' };
  }

  let context = '';
  try {
    const tieredResults = spreadingActivation(db, entryPoints);

    let injectedIds: string[] = [];
    const injectedPath = join(dataDir, 'events', `${sessionId}.injected.json`);
    try {
      injectedIds = JSON.parse(readFileSync(injectedPath, 'utf-8'));
      if (!Array.isArray(injectedIds)) injectedIds = [];
    } catch { injectedIds = []; }
    const seen = new Set(injectedIds);
    const filtered = {
      high: tieredResults.high.filter((r: NodeResult) => !seen.has(r.node.id)),
      medium: tieredResults.medium.filter((r: NodeResult) => !seen.has(r.node.id)),
    };

    context = buildContext([], [], filtered);

    const newIds = [...filtered.high, ...filtered.medium].map((r: NodeResult) => r.node.id);
    if (newIds.length > 0) {
      try {
        writeFileSync(injectedPath, JSON.stringify([...injectedIds, ...newIds]));
      } catch { /* P004 */ }
    }
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
