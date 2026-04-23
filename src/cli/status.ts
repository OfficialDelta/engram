#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { getDataDir, getDbPath } from '../core/project-identity.js';
import { Database } from '../db/migrations.js';
import { loadConfig, maskApiKey } from '../core/config.js';
import { findUnconsolidatedSessions, findFailedConsolidations } from '../core/consolidation.js';

const HOOK_EVENT_NAMES = ['PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop'] as const;

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
}

interface MatcherBlock {
  matcher: string;
  hooks: HookEntry[];
}

interface HooksMap {
  [event: string]: MatcherBlock[] | undefined;
}

export interface StatusOptions {
  claudeConfigDir: string;
  cwd: string;
}

export interface StatusResult {
  dataDir: string;
  dataDirExists: boolean;
  dbPath: string;
  dbExists: boolean;
  nodes: number | null;
  edges: number | null;
  episodes: number | null;
  lastConsolidation: string | null;
  hooksRegistered: string[];
  hooksMissing: string[];
  dbError?: string;
  configValid: boolean;
  embeddingProvider: string | null;
  pendingConsolidations: number;
  failedConsolidations: Array<{ sessionId: string; error: string; timestamp: string }>;
}

interface DbStats {
  nodes: number;
  edges: number;
  episodes: number;
  lastConsolidation: string | null;
}

function getDbStats(dbPath: string): DbStats | { error: string } {
  if (!existsSync(dbPath)) return { error: 'DB file does not exist' };
  try {
    const db = new Database(dbPath, { readonly: true });
    const nodes = (db.prepare('SELECT COUNT(*) AS count FROM nodes').get() as { count: number }).count;
    const edges = (db.prepare('SELECT COUNT(*) AS count FROM edges').get() as { count: number }).count;
    const episodes = (db.prepare('SELECT COUNT(*) AS count FROM episodes').get() as { count: number }).count;
    const lastRow = db.prepare('SELECT MAX(timestamp) AS last FROM episodes').get() as { last: string | null };
    db.close();
    return { nodes, edges, episodes, lastConsolidation: lastRow.last };
  } catch (err) {
    return { error: String(err) };
  }
}

function checkHooksRegistered(settingsPath: string): { registered: string[]; missing: string[] } {
  if (!existsSync(settingsPath)) {
    return { registered: [], missing: [...HOOK_EVENT_NAMES] };
  }
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return { registered: [], missing: [...HOOK_EVENT_NAMES] };
  }
  const hooks = settings['hooks'] as HooksMap | undefined;
  const registered: string[] = [];
  const missing: string[] = [];
  for (const event of HOOK_EVENT_NAMES) {
    const raw = hooks?.[event];
    const matchers: MatcherBlock[] = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && 'hooks' in raw) ? [{ matcher: '', hooks: (raw as { hooks: HookEntry[] }).hooks }] : [];
    const allHookEntries = matchers.flatMap((m) => m.hooks ?? []);
    const found = allHookEntries.some(
      (h) => typeof h.command === 'string' && h.command.includes('engram'),
    );
    if (found) {
      registered.push(event);
    } else {
      missing.push(event);
    }
  }
  return { registered, missing };
}

export function runStatus(options: StatusOptions): StatusResult {
  const dataDir = getDataDir(options.cwd);
  const dbPath = getDbPath(options.cwd);
  const dataDirExists = existsSync(dataDir);
  const dbExists = existsSync(dbPath);

  let nodes: number | null = null;
  let edges: number | null = null;
  let episodes: number | null = null;
  let lastConsolidation: string | null = null;
  let dbError: string | undefined;

  if (dbExists) {
    const stats = getDbStats(dbPath);
    if ('error' in stats) {
      dbError = stats.error;
    } else {
      nodes = stats.nodes;
      edges = stats.edges;
      episodes = stats.episodes;
      lastConsolidation = stats.lastConsolidation;
    }
  }

  const settingsPath = join(options.claudeConfigDir, 'settings.json');
  const { registered, missing } = checkHooksRegistered(settingsPath);

  let configValid = false;
  let embeddingProvider: string | null = null;
  try {
    const config = loadConfig();
    configValid = !!config.llm.apiKey;
    embeddingProvider = config.embedding.provider ?? null;
  } catch {
    configValid = false;
  }

  let pendingConsolidations = 0;
  let failedConsolidations: Array<{ sessionId: string; error: string; timestamp: string }> = [];
  try {
    pendingConsolidations = findUnconsolidatedSessions(dataDir).length;
  } catch { /* graceful degradation per P009 */ }
  try {
    failedConsolidations = findFailedConsolidations(dataDir);
  } catch { /* graceful degradation per P009 */ }

  const base = {
    dataDir,
    dataDirExists,
    dbPath,
    dbExists,
    nodes,
    edges,
    episodes,
    lastConsolidation,
    hooksRegistered: registered,
    hooksMissing: missing,
    configValid,
    embeddingProvider,
    pendingConsolidations,
    failedConsolidations,
  };
  if (dbError !== undefined) {
    return { ...base, dbError };
  }
  return base;
}

export function formatStatus(result: StatusResult): string {
  const lines: string[] = ['engram status', ''];

  const dirTag = result.dataDirExists ? 'exists' : 'not found';
  lines.push(`  Data directory:  ${result.dataDir}  [${dirTag}]`);

  let dbTag: string;
  if (result.dbError) {
    dbTag = `error: ${result.dbError}`;
  } else if (result.dbExists) {
    dbTag = 'initialized';
  } else {
    dbTag = 'not initialized — run engram install';
  }
  lines.push(`  Database:        ${result.dbPath}  [${dbTag}]`);

  lines.push('');
  lines.push('  Config:');
  if (result.configValid) {
    lines.push('    API key:            configured');
  } else {
    lines.push('    API key:            not configured — run engram config');
  }
  lines.push(`    Embedding provider: ${result.embeddingProvider ?? 'none'}`);

  lines.push('');
  lines.push('  Graph:');
  if (result.dbExists && !result.dbError) {
    lines.push(`    Nodes:              ${result.nodes}`);
    lines.push(`    Edges:              ${result.edges}`);
    lines.push(`    Episodes:           ${result.episodes}`);
    lines.push(`    Last consolidation: ${result.lastConsolidation ?? 'none'}`);
  } else {
    lines.push('    (no data)');
  }

  lines.push('');
  lines.push('  Consolidation:');
  lines.push(`    Pending: ${result.pendingConsolidations}`);
  lines.push(`    Failed:  ${result.failedConsolidations.length}`);
  if (result.failedConsolidations.length > 0) {
    const sorted = [...result.failedConsolidations].sort(
      (a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0),
    );
    const last = sorted[0]!;
    lines.push(`    Recent error: [${last.sessionId}] ${last.error}`);
  }

  const total = HOOK_EVENT_NAMES.length;
  const regCount = result.hooksRegistered.length;
  lines.push('');
  lines.push(`  Hooks (${regCount}/${total} registered):`);
  for (const event of HOOK_EVENT_NAMES) {
    if (result.hooksRegistered.includes(event)) {
      lines.push(`    ✓ ${event}`);
    } else {
      lines.push(`    ✗ ${event}`);
    }
  }

  return lines.join('\n');
}

function printUsage(): void {
  console.log(`Usage: engram status

Shows engram graph stats, hook registration, and data directory info.

Options:
  --help  Show this help message`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  const result = runStatus({
    claudeConfigDir: join(homedir(), '.claude'),
    cwd: process.cwd(),
  });
  console.log(formatStatus(result));
}

const argv1Real = (() => { try { return realpathSync(resolve(process.argv[1] ?? '')); } catch { return resolve(process.argv[1] ?? ''); } })();
if (argv1Real === fileURLToPath(import.meta.url)) {
  main();
}
