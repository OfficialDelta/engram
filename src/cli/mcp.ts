import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type BetterSqlite3 from 'better-sqlite3';
import { extractEntryPoints } from '../core/entry-points.js';
import { spreadingActivation } from '../core/retrieval.js';
import { buildContext } from '../core/context-builder.js';
import { initializeSchema } from '../db/migrations.js';
import { getDbPath, ensureDataDirs } from '../core/project-identity.js';

type Database = BetterSqlite3.Database;

export function handleQueryKnowledge(
  db: Database,
  question: string,
): { content: Array<{ type: 'text'; text: string }> } {
  const entryPoints = extractEntryPoints(question);
  if (entryPoints.length === 0) {
    return { content: [{ type: 'text', text: 'No knowledge stored yet.' }] };
  }

  let context = '';
  try {
    const tieredResults = spreadingActivation(db, entryPoints);
    context = buildContext([], [], tieredResults);
  } catch {
    // retrieval failures are non-fatal
  }

  if (!context) {
    return { content: [{ type: 'text', text: 'No knowledge stored yet.' }] };
  }

  return { content: [{ type: 'text', text: context }] };
}

export async function runMcp(cwd: string): Promise<void> {
  ensureDataDirs(cwd);
  const dbPath = getDbPath(cwd);
  const db = initializeSchema(dbPath);

  const server = new McpServer(
    { name: 'engram', version: '1.0.0' },
    { capabilities: {} },
  );

  server.tool(
    'query_knowledge',
    'Query the engram knowledge graph with a natural language question',
    { question: z.string().describe('Natural language question or context to retrieve knowledge for') },
    (args) => handleQueryKnowledge(db, args.question),
  );

  const shutdown = async () => {
    await server.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
