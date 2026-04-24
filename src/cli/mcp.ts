import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type BetterSqlite3 from 'better-sqlite3';
import { resolveEntryPoints } from '../core/entry-points.js';
import { spreadingActivation } from '../core/retrieval.js';
import { buildContext } from '../core/context-builder.js';
import { initializeSchema } from '../db/migrations.js';
import { getDbPath, ensureDataDirs } from '../core/project-identity.js';
import { createNode, createEdge, getNode, updateNode } from '../db/graph.js';
import { storeEmbedding } from '../db/embeddings.js';
import { resolveEntity } from '../core/entity-resolution.js';
import { getEmbedding } from '../core/embed.js';
import { computeStrength } from '../core/strength.js';
import { loadConfig } from '../core/config.js';

type Database = BetterSqlite3.Database;

type McpResponse = { content: Array<{ type: 'text'; text: string }> } | { content: Array<{ type: 'text'; text: string }>; isError: true };

export async function handleQueryKnowledge(
  db: Database,
  question: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const cfg = loadConfig();
  const embeddingConfig = cfg.embedding?.provider
    ? { provider: cfg.embedding.provider, ...(cfg.embedding.apiKey != null ? { apiKey: cfg.embedding.apiKey } : {}) }
    : undefined;
  const entryPoints = await resolveEntryPoints(question, db, embeddingConfig);
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

export async function handleSaveDecision(
  db: Database,
  args: {
    decision: string;
    rationale: string;
    affected_files: string[];
    alternatives_considered: string[];
  },
): Promise<McpResponse> {
  try {
    const cfg = loadConfig();
    const embeddingConfig: { provider?: string; apiKey?: string } = {};
    if (cfg.embedding?.provider) embeddingConfig.provider = cfg.embedding.provider;
    if (cfg.embedding?.apiKey) embeddingConfig.apiKey = cfg.embedding.apiKey;

    const resolution = await resolveEntity(db, args.decision, args.rationale, embeddingConfig);

    if (resolution.action === 'merge' && resolution.existingNodeId) {
      const existing = getNode(db, resolution.existingNodeId);
      if (existing) {
        const updatedDescription = existing.description + '\n' + args.rationale;
        const existingMeta = existing.metadata as Record<string, unknown>;
        const existingAlts = Array.isArray(existingMeta.alternatives) ? existingMeta.alternatives as string[] : [];
        const mergedAlts = [...new Set([...existingAlts, ...args.alternatives_considered])];
        updateNode(db, resolution.existingNodeId, {
          description: updatedDescription,
          metadata: { ...existingMeta, alternatives: mergedAlts },
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ action: 'merged', nodeId: resolution.existingNodeId }) }],
        };
      }
    }

    const strength = computeStrength({
      sourceEpisodeCount: 1,
      sessionsWithoutReinforcement: 0,
      successfulEpisodes: 1,
      totalEpisodes: 1,
      causallyImportant: true,
    });

    const newNode = createNode(db, {
      name: args.decision,
      nodeType: 'decision',
      description: args.rationale,
      affectedFiles: args.affected_files,
      strength,
      metadata: {
        rationale: args.rationale,
        alternatives: args.alternatives_considered,
        source: 'explicit',
      },
    });

    const embeddings = await getEmbedding([args.decision + ' ' + args.rationale], embeddingConfig);
    storeEmbedding(db, newNode.id, embeddings[0]!);

    if (resolution.action === 'create_child' && resolution.existingNodeId) {
      createEdge(db, {
        sourceNodeId: newNode.id,
        targetNodeId: resolution.existingNodeId,
        relationshipType: 'version_of',
        weight: 0.8,
        metadata: {},
      });
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ action: 'created', nodeId: newNode.id }) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error saving decision: ${message}` }],
      isError: true,
    };
  }
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
    async (args) => handleQueryKnowledge(db, args.question),
  );

  server.tool(
    'save_decision',
    'Save a decision to the engram knowledge graph for future retrieval',
    {
      decision: z.string().describe('The decision that was made'),
      rationale: z.string().describe('Why this decision was made'),
      affected_files: z.array(z.string()).optional().describe('File paths affected by this decision'),
      alternatives_considered: z.array(z.string()).optional().describe('Alternative approaches that were considered'),
    },
    async (args) => handleSaveDecision(db, {
      decision: args.decision,
      rationale: args.rationale,
      affected_files: args.affected_files ?? [],
      alternatives_considered: args.alternatives_considered ?? [],
    }),
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
