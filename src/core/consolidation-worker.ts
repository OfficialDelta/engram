#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { consolidateSession } from './consolidation.js';

const sessionId = process.argv[2];
const dbPath = process.argv[3];
const dataDir = process.argv[4];

if (!sessionId || !dbPath || !dataDir) {
  process.exit(1);
}

const logDir = path.join(dataDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `consolidation-${sessionId}.log`);

try {
  await consolidateSession(sessionId, dbPath, dataDir);
  fs.writeFileSync(logPath, `[${new Date().toISOString()}] Consolidation completed for session ${sessionId}\n`);
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  fs.writeFileSync(logPath, `[${new Date().toISOString()}] Consolidation failed for session ${sessionId}:\n${message}\n`);
  process.exit(1);
}
