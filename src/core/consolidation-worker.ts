#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { consolidateSession } from './consolidation.js';
import { loadConfig } from './config.js';

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

try {
  const consolidationConfig = {
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
  };
  await consolidateSession(sessionId, dbPath, dataDir, consolidationConfig);
  fs.writeFileSync(logPath, `[${new Date().toISOString()}] Consolidation completed for session ${sessionId}\n`);
  process.exit(0);
} catch (err) {
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
}
