#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { consolidateSession, readConsolidationTimestamp, writeConsolidationTimestamp, isEpisodeComplete, acquireConsolidationLock, releaseConsolidationLock } from './consolidation.js';
import { loadConfig } from './config.js';
import { validateEmbeddingDimension } from './embed.js';
import { loadSessionState, saveSessionState } from './session-state.js';
import { Database } from '../db/migrations.js';
import * as sqliteVec from 'sqlite-vec';

const sessionId = process.argv[2];
const dbPath = process.argv[3];
const dataDir = process.argv[4];

if (!sessionId || !dbPath || !dataDir) {
  process.exit(1);
}

const logDir = path.join(dataDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `consolidation-${sessionId}.log`);

const cfg = loadConfig();

if (cfg.llm.apiKey && !process.env.ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = cfg.llm.apiKey;
}

if (isEpisodeComplete(dataDir, sessionId)) {
  fs.writeFileSync(logPath, `[${new Date().toISOString()}] Skipped: episode already exists for session ${sessionId}\n`);
  process.exit(0);
}

if (!acquireConsolidationLock(dataDir, sessionId)) {
  fs.writeFileSync(logPath, `[${new Date().toISOString()}] Skipped: consolidation lock held for session ${sessionId}\n`);
  process.exit(0);
}

const embeddingProvider = cfg.embedding.provider || 'voyage-3-lite';
if (fs.existsSync(dbPath)) {
  let checkDb;
  try {
    checkDb = new Database(dbPath);
    sqliteVec.load(checkDb);
    const mismatch = validateEmbeddingDimension(checkDb, embeddingProvider);
    if (mismatch) {
      const errorMsg = `Embedding dimension mismatch: DB has ${mismatch.existing}D (${mismatch.existingProvider}), config expects ${mismatch.expected}D (${mismatch.currentProvider}). Run: npx engram re-embed`;
      fs.writeFileSync(logPath, `[${new Date().toISOString()}] Failed: ${errorMsg}\n`);
      const episodesDir = path.join(dataDir, 'episodes');
      fs.mkdirSync(episodesDir, { recursive: true });
      fs.writeFileSync(
        path.join(episodesDir, `${sessionId}.failed.json`),
        JSON.stringify({ error: errorMsg, sessionId, failedAt: new Date().toISOString() }),
      );
      releaseConsolidationLock(dataDir, sessionId);
      checkDb.close();
      process.exit(1);
    }
  } finally {
    checkDb?.close();
  }
}

try {
  const sinceTimestamp = readConsolidationTimestamp(dataDir, sessionId);
  const consolidationConfig = {
    ...(cfg.consolidation?.provider ? { consolidationProvider: cfg.consolidation.provider } : {}),
    ...(cfg.llm.pass1Model ? { pass1Model: cfg.llm.pass1Model } : {}),
    ...(cfg.llm.pass2Model ? { pass2Model: cfg.llm.pass2Model } : {}),
    ...(cfg.consolidation.windowSize ? { windowSize: cfg.consolidation.windowSize } : {}),
    ...(cfg.consolidation.windowOverlap ? { windowOverlap: cfg.consolidation.windowOverlap } : {}),
    ...(cfg.embedding.provider || cfg.embedding.apiKey
      ? {
          embeddingConfig: {
            ...(cfg.embedding.provider ? { provider: cfg.embedding.provider } : {}),
            ...(cfg.embedding.apiKey ? { apiKey: cfg.embedding.apiKey } : {}),
          },
        }
      : {}),
    ...(sinceTimestamp ? { sinceTimestamp } : {}),
  };
  await consolidateSession(sessionId, dbPath, dataDir, consolidationConfig);
  writeConsolidationTimestamp(dataDir, sessionId, new Date().toISOString());
  try {
    const state = loadSessionState(dataDir, sessionId);
    state.consolidationSpawned = false;
    saveSessionState(dataDir, sessionId, state);
  } catch { /* state reset is best-effort */ }
  fs.writeFileSync(logPath, `[${new Date().toISOString()}] Consolidation completed for session ${sessionId}\n`);
  process.exit(0);
} catch (err) {
  releaseConsolidationLock(dataDir, sessionId);
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  fs.writeFileSync(logPath, `[${new Date().toISOString()}] Consolidation failed for session ${sessionId}:\n${message}\n`);
  try {
    const episodesDir = path.join(dataDir, 'episodes');
    fs.mkdirSync(episodesDir, { recursive: true });
    fs.writeFileSync(
      path.join(episodesDir, sessionId + '.failed.json'),
      JSON.stringify({ sessionId, error: message, timestamp: new Date().toISOString() }),
    );
  } catch {
    // marker write failure must not mask the original error
  }
  process.exit(1);
} finally {
  releaseConsolidationLock(dataDir, sessionId);
}
