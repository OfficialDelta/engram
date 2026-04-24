#!/usr/bin/env node
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeSchema } from '../../db/migrations.js';
import { getDataDir, getDbPath } from '../../core/project-identity.js';
import { buildContext } from '../../core/context-builder.js';
import { spreadingActivation } from '../../core/retrieval.js';
import { extractEntryPoints, resolveEntryPoints } from '../../core/entry-points.js';
import { loadConfig } from '../../core/config.js';

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

    const dbPath = getDbPath(cwd);
    const db = initializeSchema(dbPath);

    const cfg = loadConfig();
    const embeddingConfig = cfg.embedding?.provider
      ? { provider: cfg.embedding.provider, apiKey: cfg.embedding.apiKey }
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
      additionalContext = buildContext([], [], tieredResults);
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
