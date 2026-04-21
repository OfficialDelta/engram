#!/usr/bin/env node
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeSchema } from '../../db/migrations.js';
import { getDataDir, getDbPath } from './project-identity.js';
import { buildContext } from './context-builder.js';
import { spreadingActivation } from '../../core/retrieval.js';
import type { EntryPoint } from '../../types.js';

function logError(dataDir: string, message: string): void {
  try {
    const logDir = join(dataDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'user-prompt-submit.log'), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // logging itself must never throw
  }
}

const FILE_PATH_PATTERN = /(?:^|\s|['"`(])(\.\/?(?:[\w.-]+\/)*[\w.-]+\.\w{1,10})(?=['"`)\s,]|$)|(?:^|\s|['"`(])((?:[\w@.-]+\/)+[\w.-]+\.\w{1,10})(?=['"`)\s,]|$)|(?:^|\s|['"`(])(\/(?:[\w.-]+\/)+[\w.-]+\.\w{1,10})(?=['"`)\s,]|$)/gm;
const CONCEPT_PATTERN = /(?:[`'"]([\w][\w ./-]{1,60}[\w])['"`])/g;

export function extractEntryPoints(prompt: string): EntryPoint[] {
  const entryPoints: EntryPoint[] = [];
  const seenValues = new Set<string>();

  for (const match of prompt.matchAll(FILE_PATH_PATTERN)) {
    const filePath = match[1] ?? match[2] ?? match[3];
    if (filePath && !seenValues.has(filePath)) {
      seenValues.add(filePath);
      entryPoints.push({ type: 'file', value: filePath });
    }
  }

  for (const match of prompt.matchAll(CONCEPT_PATTERN)) {
    const concept = match[1];
    if (concept && !seenValues.has(concept) && !concept.includes('/')) {
      seenValues.add(concept);
      entryPoints.push({ type: 'name', value: concept });
    }
  }

  return entryPoints;
}

function main(): void {
  try {
    const stdin = readFileSync('/dev/stdin', 'utf-8');
    const input = JSON.parse(stdin) as Record<string, unknown>;

    const cwd = (input.cwd as string) ?? process.cwd();
    const prompt = (input.prompt as string) ?? '';

    const entryPoints = extractEntryPoints(prompt);
    if (entryPoints.length === 0) {
      process.stdout.write('{}');
      process.exit(0);
    }

    const dbPath = getDbPath(cwd);
    const db = initializeSchema(dbPath);

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
  main();
}
