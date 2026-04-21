#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { initializeSchema } from '../../db/migrations.js';
import { ContradictionChecker } from '../../core/contradiction.js';
import { loadSessionState, saveSessionState } from '../../core/session-state.js';

const sessionId = process.argv[2];
const dbPath = process.argv[3];
const dataDir = process.argv[4];
const filePath = process.argv[5];
const evidenceSnippet = process.argv[6];

if (!sessionId || !dbPath || !dataDir || !filePath || !evidenceSnippet) {
  process.exit(1);
}

const logDir = path.join(dataDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `contradiction-${sessionId}.log`);

function log(message: string): void {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
}

try {
  const db = initializeSchema(dbPath);
  const client = new (await import('@anthropic-ai/sdk')).default();
  const checker = new ContradictionChecker();
  const result = await checker.checkContradiction(db, filePath, evidenceSnippet, { client });

  if (result) {
    const state = loadSessionState(dataDir, sessionId);
    state.pendingContradictions.push(result);
    saveSessionState(dataDir, sessionId, state);
    log(`Contradiction found for ${filePath}: ${result.verdict} (${result.severity})`);
  } else {
    log(`No contradiction for ${filePath}`);
  }

  db.close();
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  log(`Contradiction check failed for ${filePath}:\n${message}`);
  process.exit(1);
}
