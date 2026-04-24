#!/usr/bin/env node
import { existsSync, unlinkSync, realpathSync } from 'node:fs';
import path, { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDataDir, getDbPath } from '../core/project-identity.js';
import {
  findUnconsolidatedSessions,
  findFailedConsolidations,
  consolidateSession,
  readConsolidationTimestamp,
  writeConsolidationTimestamp,
} from '../core/consolidation.js';
import { loadConfig } from '../core/config.js';

export interface ConsolidateOptions {
  cwd: string;
  sessionId?: string;
  retryFailed?: boolean;
  dryRun?: boolean;
}

export interface ConsolidateResult {
  processed: number;
  failed: number;
  skipped: number;
}

export async function runConsolidate(options: ConsolidateOptions): Promise<ConsolidateResult> {
  const dataDir = getDataDir(options.cwd);
  const dbPath = getDbPath(options.cwd);

  if (!existsSync(dataDir)) {
    console.log('No engram data found. Run engram install first.');
    return { processed: 0, failed: 0, skipped: 0 };
  }

  let sessionIds = findUnconsolidatedSessions(dataDir);

  if (options.retryFailed) {
    const failed = findFailedConsolidations(dataDir);
    const failedIds = failed.map((f) => f.sessionId);
    const existing = new Set(sessionIds);
    for (const id of failedIds) {
      if (!existing.has(id)) {
        sessionIds.push(id);
      }
    }
    for (const id of failedIds) {
      const markerPath = path.join(dataDir, 'episodes', id + '.failed.json');
      if (existsSync(markerPath)) {
        unlinkSync(markerPath);
      }
    }
  }

  if (options.sessionId) {
    sessionIds = sessionIds.filter((id) => id === options.sessionId);
  }

  if (sessionIds.length === 0) {
    console.log('No sessions to consolidate.');
    return { processed: 0, failed: 0, skipped: 0 };
  }

  if (options.dryRun) {
    console.log(`Would consolidate ${sessionIds.length} session(s):`);
    for (const id of sessionIds) {
      console.log(`  ${id}`);
    }
    return { processed: 0, failed: 0, skipped: sessionIds.length };
  }

  const config = loadConfig();
  if (!config.llm.apiKey) {
    console.log('No API key configured. Run engram config to set your Anthropic API key.');
    return { processed: 0, failed: 0, skipped: 0 };
  }

  if (config.llm.apiKey && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = config.llm.apiKey;
  }

  let processed = 0;
  let failed = 0;

  for (const sessionId of sessionIds) {
    console.log(`Consolidating session ${sessionId}...`);
    try {
      const sinceTimestamp = readConsolidationTimestamp(dataDir, sessionId);
      const consolidationConfig = {
        ...(config.consolidation?.provider ? { consolidationProvider: config.consolidation.provider } : {}),
        ...(config.llm.pass1Model ? { pass1Model: config.llm.pass1Model } : {}),
        ...(config.llm.pass2Model ? { pass2Model: config.llm.pass2Model } : {}),
        ...(config.consolidation.windowSize ? { windowSize: config.consolidation.windowSize } : {}),
        ...(config.consolidation.windowOverlap ? { windowOverlap: config.consolidation.windowOverlap } : {}),
        ...(config.embedding.provider || config.embedding.apiKey
          ? {
              embeddingConfig: {
                ...(config.embedding.provider ? { provider: config.embedding.provider } : {}),
                ...(config.embedding.apiKey ? { apiKey: config.embedding.apiKey } : {}),
              },
            }
          : {}),
        ...(sinceTimestamp ? { sinceTimestamp } : {}),
      };
      await consolidateSession(sessionId, dbPath, dataDir, consolidationConfig);
      writeConsolidationTimestamp(dataDir, sessionId, new Date().toISOString());
      console.log(`  ✓ Session ${sessionId} consolidated successfully.`);
      processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ Session ${sessionId} failed: ${message}`);
      failed++;
    }
  }

  console.log(`\nDone. Processed: ${processed}, Failed: ${failed}`);
  return { processed, failed, skipped: 0 };
}

export function printUsage(): void {
  console.log(`Usage: engram consolidate [session-id] [options]

Process unconsolidated sessions through the engram consolidation pipeline.

Arguments:
  session-id       Optional. Consolidate only this specific session.

Options:
  --dry-run        List sessions that would be consolidated without processing them.
  --retry-failed   Include previously failed sessions in the consolidation run.
  --help           Show this help message.`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const retryFailed = args.includes('--retry-failed');
  const positional = args.filter((a) => !a.startsWith('--'));
  const sessionId = positional[0];

  runConsolidate({
    cwd: process.cwd(),
    ...(sessionId != null ? { sessionId } : {}),
    retryFailed,
    dryRun,
  }).catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

const argv1Real = (() => { try { return realpathSync(resolve(process.argv[1] ?? '')); } catch { return resolve(process.argv[1] ?? ''); } })();
if (argv1Real === fileURLToPath(import.meta.url)) {
  main();
}
