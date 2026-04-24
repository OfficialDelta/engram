#!/usr/bin/env node
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeSchema } from '../../db/migrations.js';
import { getDataDir, getDbPath, ensureDataDirs } from '../../core/project-identity.js';
import { buildContext } from '../../core/context-builder.js';
import { spreadingActivation } from '../../core/retrieval.js';
import { extractEntryPoints, resolveEntryPoints } from '../../core/entry-points.js';
import { loadConfig } from '../../core/config.js';
import { loadSessionState, saveSessionState } from '../../core/session-state.js';

export { extractEntryPoints } from '../../core/entry-points.js';

function logError(dataDir: string, message: string): void {
  try {
    const logDir = join(dataDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'user-prompt-submit.log'), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // logging itself must never throw
  }
}

async function main(): Promise<void> {
  try {
    const stdin = readFileSync(0, 'utf-8');
    const input = JSON.parse(stdin) as Record<string, unknown>;

    const cwd = (input.cwd as string) ?? process.cwd();
    const prompt = (input.prompt as string) ?? '';
    const sessionId = input.session_id as string;

    if (prompt && sessionId) {
      const dataDir = ensureDataDirs(cwd);
      const state = loadSessionState(dataDir, sessionId);
      state.lastUserPrompt = prompt;
      saveSessionState(dataDir, sessionId, state);
    }

    const dbPath = getDbPath(cwd);
    const db = initializeSchema(dbPath);

    const cfg = loadConfig();
    const embeddingConfig = cfg.embedding?.provider
      ? { provider: cfg.embedding.provider, ...(cfg.embedding.apiKey != null ? { apiKey: cfg.embedding.apiKey } : {}) }
      : undefined;
    const entryPoints = await resolveEntryPoints(prompt, db, embeddingConfig);

    if (entryPoints.length === 0) {
      db.close();
      process.stdout.write('{}');
      process.exit(0);
    }

    let additionalContext = '';
    try {
      const tieredResults = spreadingActivation(db, entryPoints);

      let injectedIds: string[] = [];
      const dataDir = getDataDir(cwd);
      const injectedPath = join(dataDir, 'events', `${sessionId}.injected.json`);
      try {
        injectedIds = JSON.parse(readFileSync(injectedPath, 'utf-8'));
        if (!Array.isArray(injectedIds)) injectedIds = [];
      } catch { injectedIds = []; }
      const seen = new Set(injectedIds);
      const filtered = {
        high: tieredResults.high.filter(r => !seen.has(r.node.id)),
        medium: tieredResults.medium.filter(r => !seen.has(r.node.id)),
      };

      additionalContext = buildContext([], [], filtered);

      const newIds = [...filtered.high, ...filtered.medium].map(r => r.node.id);
      if (newIds.length > 0) {
        try {
          writeFileSync(injectedPath, JSON.stringify([...injectedIds, ...newIds]));
        } catch { /* P004 */ }
      }
    } catch (err) {
      const dataDir = getDataDir(cwd);
      logError(dataDir, `Spreading activation failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    db.close();

    if (additionalContext) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
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
      logError(dataDir, `UserPromptSubmit handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    } catch {
      // final fallback
    }
    process.stdout.write('{}');
    process.exit(0);
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stdout.write('{}'); process.exit(0); });
}
