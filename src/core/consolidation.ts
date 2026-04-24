import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type {
  EngramEvent,
  TurnCompleteEvent,
  WindowSummary,
  StructuredEpisode,
  GraphChangeRequest,
  ConsolidationConfig,
  GraphNode,
} from '../types.js';
import type { DatabaseType } from '../db/migrations.js';
import { initializeSchema } from '../db/migrations.js';
import { getSessionEvents } from './event-stream.js';
import { computeStrength } from './strength.js';
import { resolveEntity } from './entity-resolution.js';
import { getEmbedding, getDimensions } from './embed.js';
import { createNode, updateNode, createEdge, createEpisode, getNode } from '../db/graph.js';
import { storeEmbedding } from '../db/embeddings.js';

export function windowEvents(
  events: EngramEvent[],
  windowSize: number,
  overlap: number,
): EngramEvent[][] {
  if (events.length === 0) return [];
  if (events.length <= windowSize) return [events];

  const step = windowSize - overlap;
  const windows: EngramEvent[][] = [];
  for (let i = 0; i < events.length; i += step) {
    windows.push(events.slice(i, i + windowSize));
  }
  return windows;
}

export async function pass1Summarize(
  windows: EngramEvent[][],
  client: { messages: { create: (params: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> } },
  model: string,
): Promise<WindowSummary[]> {
  return Promise.all(
    windows.map(async (windowEvts, idx) => {
      const response = await client.messages.create({
        model,
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: `Analyze these coding agent events and produce a JSON summary.

Events:
${JSON.stringify(windowEvts, null, 2)}

Return a JSON object with these fields:
- summary: what the agent was doing and what happened (2-3 sentences with causal links)
- filesModified: array of file paths modified in these events
- decisionsIdentified: array of decision descriptions (empty array if none)
- outcome: one of "progress", "debugging", "blocked", "completed"

Additional extraction requirements:
- List specific bugs encountered with their error messages or stack traces verbatim
- Include concrete values: config settings, thresholds, version numbers, counts
- For each file modified, describe WHAT specifically changed (not just that it was modified)
- Quote the agent's stated reasons for actions verbatim when available in evidence_snippet fields`,
          },
        ],
      });

      const rawText = response.content[0]?.text ?? '';
      try {
        const parsed = JSON.parse(rawText) as {
          summary?: string;
          filesModified?: string[];
          decisionsIdentified?: string[];
          outcome?: string;
        };
        return {
          windowIndex: idx,
          eventRange: { start: idx * (windowEvts.length), end: idx * (windowEvts.length) + windowEvts.length - 1 },
          summary: parsed.summary ?? rawText,
          filesModified: parsed.filesModified ?? [],
          decisionsIdentified: parsed.decisionsIdentified ?? [],
          outcome: (parsed.outcome as WindowSummary['outcome']) ?? 'progress',
        };
      } catch {
        return {
          windowIndex: idx,
          eventRange: { start: 0, end: windowEvts.length - 1 },
          summary: rawText,
          filesModified: [],
          decisionsIdentified: [],
          outcome: 'progress' as const,
        };
      }
    }),
  );
}

const VALID_NODE_TYPES = new Set(['concept', 'decision', 'pattern', 'file', 'entity']);

export async function pass2Extract(
  summaries: WindowSummary[],
  client: { messages: { create: (params: unknown) => Promise<{ content: Array<{ type: string; id?: string; name?: string; input?: unknown }> }> } },
  model: string,
): Promise<{ episode: StructuredEpisode; changes: GraphChangeRequest }> {
  const summaryText = summaries
    .map((s, i) => `Window ${i}: ${s.summary}\nFiles: ${s.filesModified.join(', ')}\nDecisions: ${s.decisionsIdentified.join(', ')}\nOutcome: ${s.outcome}`)
    .join('\n\n');

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `Analyze these session window summaries and extract a structured episode with graph changes.

Decision extraction guidance:
- Identify both EXPLICIT decisions (agent stated a choice with rationale) and IMPLICIT decisions (agent chose between alternatives without stating the choice).
- For explicit decisions: set isImplicit=false, include the stated rationale verbatim, set causallyImportant=true on the corresponding graph node.
- For implicit decisions: set isImplicit=true, infer the rationale from context. Only flag as a decision when alternatives were clearly available — routine code changes are not decisions. Set causallyImportant=false.
- Each decision node should have nodeType='decision' and a descriptive name summarizing the choice made.
- Include affected file paths in affectedFiles for every decision node.

Rationale formatting:
- For explicit decisions (isImplicit=false): include the agent's stated reason verbatim, without modification or hedging.
- For implicit decisions (isImplicit=true): prefix the inferred rationale with "[inferred]" so downstream consumers can distinguish stated from inferred reasoning.

${summaryText}`,
      },
    ],
    tools: [
      {
        name: 'extract_episode',
        description: 'Extract structured episode and graph changes from session summaries',
        input_schema: {
          type: 'object',
          properties: {
            episode: {
              type: 'object',
              properties: {
                goal: { type: 'string' },
                approach: { type: 'string' },
                outcome: { type: 'string', enum: ['success', 'partial', 'failure'] },
                discoveries: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      content: { type: 'string' },
                      evidence: { type: 'string' },
                      confidence: { type: 'number' },
                    },
                    required: ['content', 'evidence', 'confidence'],
                  },
                },
                decisions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      content: { type: 'string' },
                      rationale: { type: 'string' },
                      isImplicit: { type: 'boolean' },
                    },
                    required: ['content', 'rationale', 'isImplicit'],
                  },
                },
                errors: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      description: { type: 'string' },
                      rootCause: { type: 'string' },
                      resolution: { type: 'string' },
                    },
                    required: ['description', 'rootCause', 'resolution'],
                  },
                },
              },
              required: ['goal', 'approach', 'outcome', 'discoveries', 'decisions', 'errors'],
            },
            changes: {
              type: 'object',
              properties: {
                nodesToCreate: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      nodeType: { type: 'string', enum: ['concept', 'decision', 'pattern', 'file', 'entity'] },
                      description: { type: 'string' },
                      affectedFiles: { type: 'array', items: { type: 'string' } },
                      causallyImportant: { type: 'boolean' },
                    },
                    required: ['name', 'nodeType', 'description', 'affectedFiles', 'causallyImportant'],
                  },
                },
                nodesToUpdate: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      existingNodeId: { type: 'string' },
                      updates: { type: 'object' },
                    },
                    required: ['existingNodeId', 'updates'],
                  },
                },
                edgesToCreate: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      sourceNodeName: { type: 'string' },
                      targetNodeName: { type: 'string' },
                      relationshipType: { type: 'string' },
                      weight: { type: 'number' },
                    },
                    required: ['sourceNodeName', 'targetNodeName', 'relationshipType', 'weight'],
                  },
                },
              },
              required: ['nodesToCreate', 'nodesToUpdate', 'edgesToCreate'],
            },
          },
          required: ['episode', 'changes'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'extract_episode' },
  });

  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (!toolBlock) {
    throw new Error('Pass 2: no tool_use block in response');
  }

  const result = toolBlock.input as { episode: StructuredEpisode; changes: GraphChangeRequest };

  result.changes.nodesToCreate = result.changes.nodesToCreate.filter(
    (n) => VALID_NODE_TYPES.has(n.nodeType),
  );

  return result;
}

export async function applyGraphChanges(
  db: DatabaseType,
  changes: GraphChangeRequest,
  sessionId: string,
  episodeId: string,
  embeddingConfig?: { provider?: string; apiKey?: string },
): Promise<Map<string, string>> {
  const nodeIdMap = new Map<string, string>();

  type PreparedOp =
    | { kind: 'merge'; name: string; existingNodeId: string; node: GraphChangeRequest['nodesToCreate'][number] }
    | { kind: 'create_child'; name: string; existingNodeId: string; node: GraphChangeRequest['nodesToCreate'][number]; embedding: number[] }
    | { kind: 'create_new'; name: string; node: GraphChangeRequest['nodesToCreate'][number]; embedding: number[] };

  const ops: PreparedOp[] = [];

  for (const node of changes.nodesToCreate) {
    const resolution = await resolveEntity(db, node.name, node.description, embeddingConfig);

    if (resolution.action === 'merge' && resolution.existingNodeId) {
      ops.push({ kind: 'merge', name: node.name, existingNodeId: resolution.existingNodeId, node });
    } else if (resolution.action === 'create_child' && resolution.existingNodeId) {
      const embeddings = await getEmbedding([node.name + ' ' + node.description], embeddingConfig);
      ops.push({ kind: 'create_child', name: node.name, existingNodeId: resolution.existingNodeId, node, embedding: embeddings[0]! });
    } else {
      const embeddings = await getEmbedding([node.name + ' ' + node.description], embeddingConfig);
      ops.push({ kind: 'create_new', name: node.name, node, embedding: embeddings[0]! });
    }
  }

  db.transaction(() => {
    for (const op of ops) {
      if (op.kind === 'merge') {
        const existing = getNode(db, op.existingNodeId);
        if (existing) {
          const meta = existing.metadata as Record<string, unknown>;
          const sourceEpisodes = (meta.sourceEpisodes as string[] | undefined) ?? [];
          sourceEpisodes.push(episodeId);
          const newMeta = { ...meta, sourceEpisodes };
          updateNode(db, op.existingNodeId, {
            description: existing.description + '; ' + op.node.description,
            metadata: newMeta,
          });
          const newStrength = computeStrength({
            sourceEpisodeCount: sourceEpisodes.length,
            sessionsWithoutReinforcement: 0,
            successfulEpisodes: sourceEpisodes.length,
            totalEpisodes: sourceEpisodes.length,
            causallyImportant: op.node.causallyImportant,
          });
          updateNode(db, op.existingNodeId, { strength: newStrength });
        }
        nodeIdMap.set(op.name, op.existingNodeId);
      } else if (op.kind === 'create_child') {
        const newNode = createNode(db, {
          name: op.node.name,
          nodeType: op.node.nodeType as GraphNode['nodeType'],
          description: op.node.description,
          affectedFiles: op.node.affectedFiles,
          strength: computeStrength({
            sourceEpisodeCount: 1,
            sessionsWithoutReinforcement: 0,
            successfulEpisodes: 1,
            totalEpisodes: 1,
            causallyImportant: op.node.causallyImportant,
          }),
          metadata: { sourceEpisodes: [episodeId] },
        });
        storeEmbedding(db, newNode.id, op.embedding);
        createEdge(db, {
          sourceNodeId: newNode.id,
          targetNodeId: op.existingNodeId,
          relationshipType: 'version_of',
          weight: 0.8,
          metadata: {},
        });
        nodeIdMap.set(op.name, newNode.id);
      } else {
        const newNode = createNode(db, {
          name: op.node.name,
          nodeType: op.node.nodeType as GraphNode['nodeType'],
          description: op.node.description,
          affectedFiles: op.node.affectedFiles,
          strength: computeStrength({
            sourceEpisodeCount: 1,
            sessionsWithoutReinforcement: 0,
            successfulEpisodes: 1,
            totalEpisodes: 1,
            causallyImportant: op.node.causallyImportant,
          }),
          metadata: { sourceEpisodes: [episodeId] },
        });
        storeEmbedding(db, newNode.id, op.embedding);
        nodeIdMap.set(op.name, newNode.id);
      }
    }

    for (const edge of changes.edgesToCreate) {
      const sourceId = nodeIdMap.get(edge.sourceNodeName);
      const targetId = nodeIdMap.get(edge.targetNodeName);
      if (sourceId && targetId) {
        createEdge(db, {
          sourceNodeId: sourceId,
          targetNodeId: targetId,
          relationshipType: edge.relationshipType,
          weight: edge.weight,
          metadata: {},
        });
      }
    }
  })();

  return nodeIdMap;
}

export function shouldUseDiscussionConsolidation(events: EngramEvent[]): boolean {
  return (
    events.length > 0 &&
    events.length < 3 &&
    events.every(
      (e) => e.type === 'turn_complete' && (e as TurnCompleteEvent).toolCallCount === 0,
    )
  );
}

export async function discussionConsolidate(
  events: EngramEvent[],
  client: { messages: { create: (params: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> } },
  model: string,
): Promise<{ topics: string[]; decisions: string[]; constraints: string[] }> {
  const turnEvents = events.filter((e): e is TurnCompleteEvent => e.type === 'turn_complete');
  const eventSummary = turnEvents
    .map((e, i) => {
      const parts = [`Turn ${i + 1}`];
      if (e.userMessage) parts.push(`User: ${e.userMessage}`);
      if (e.agentSummary) parts.push(`Agent: ${e.agentSummary}`);
      return parts.join('\n');
    })
    .join('\n\n');

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: `Analyze this discussion session and extract structured information.

Discussion turns:
${eventSummary}

Return a JSON object with:
- topics: array of topics discussed
- decisions: array of decisions stated during the discussion
- constraints: array of constraints or requirements mentioned`,
        },
      ],
    });

    const rawText = response.content[0]?.text ?? '';
    try {
      const parsed = JSON.parse(rawText) as {
        topics?: string[];
        decisions?: string[];
        constraints?: string[];
      };
      return {
        topics: parsed.topics ?? [],
        decisions: parsed.decisions ?? [],
        constraints: parsed.constraints ?? [],
      };
    } catch {
      return { topics: [], decisions: [], constraints: [] };
    }
  } catch {
    return { topics: [], decisions: [], constraints: [] };
  }
}

export async function consolidateSession(
  sessionId: string,
  dbPath: string,
  dataDir: string,
  config?: ConsolidationConfig,
): Promise<void> {
  const windowSize = config?.windowSize ?? 10;
  const windowOverlap = config?.windowOverlap ?? 3;
  const pass1Model = config?.pass1Model ?? 'claude-sonnet-4-6';
  const pass2Model = config?.pass2Model ?? 'claude-opus-4-6';

  const client = (config?.client as Parameters<typeof pass1Summarize>[1]) ??
    new (await import('@anthropic-ai/sdk')).default();

  let events = getSessionEvents(sessionId, dataDir);
  if (config?.sinceTimestamp) {
    events = events.filter((e) => e.timestamp > config.sinceTimestamp!);
  }
  if (events.length === 0) return;

  if (shouldUseDiscussionConsolidation(events)) {
    const discussionModel = 'claude-haiku-4-5';
    const result = await discussionConsolidate(events, client, discussionModel);
    const embProv = config?.embeddingConfig?.provider ?? 'voyage-3-lite';
    const db = initializeSchema(dbPath, getDimensions(embProv), embProv);
    try {
      const episodeRecord = createEpisode(db, {
        sessionId,
        summary: `Discussion: ${result.topics.join(', ')}`,
        nodesInvolved: [],
        timestamp: new Date().toISOString(),
        metadata: result as unknown as Record<string, unknown>,
      });
      fs.mkdirSync(path.join(dataDir, 'episodes'), { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, 'episodes', sessionId + '.episode.json'),
        JSON.stringify({ episodeId: episodeRecord.id, completedAt: new Date().toISOString(), type: 'discussion' }),
      );
    } finally {
      db.close();
    }
    return;
  }

  const embeddingProvider = config?.embeddingConfig?.provider ?? 'voyage-3-lite';
  const db = initializeSchema(dbPath, getDimensions(embeddingProvider), embeddingProvider);

  try {
    const windows = windowEvents(events, windowSize, windowOverlap);
    const summaries = await pass1Summarize(windows, client, pass1Model);
    const { episode, changes } = await pass2Extract(summaries, client, pass2Model);

    const episodeRecord = createEpisode(db, {
      sessionId,
      summary: episode.goal + ': ' + episode.approach,
      nodesInvolved: [],
      timestamp: new Date().toISOString(),
      metadata: episode as unknown as Record<string, unknown>,
    });

    const nodeIdMap = await applyGraphChanges(db, changes, sessionId, episodeRecord.id, config?.embeddingConfig);

    db.prepare('UPDATE episodes SET nodes_involved = ? WHERE id = ?').run(
      JSON.stringify([...nodeIdMap.values()]),
      episodeRecord.id,
    );

    fs.mkdirSync(path.join(dataDir, 'episodes'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'episodes', sessionId + '.episode.json'),
      JSON.stringify({ episodeId: episodeRecord.id, completedAt: new Date().toISOString() }),
    );
  } finally {
    db.close();
  }
}

export function readConsolidationTimestamp(dataDir: string, sessionId: string): string | null {
  const markerPath = path.join(dataDir, 'sessions', `${sessionId}.last-consolidated-at.json`);
  try {
    const raw = fs.readFileSync(markerPath, 'utf-8');
    const parsed = JSON.parse(raw) as { timestamp?: string };
    return parsed.timestamp ?? null;
  } catch {
    return null;
  }
}

export function writeConsolidationTimestamp(dataDir: string, sessionId: string, timestamp: string): void {
  const sessionsDir = path.join(dataDir, 'sessions');
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.last-consolidated-at.json`),
      JSON.stringify({ timestamp }),
    );
  } catch {
    // swallow — P004: timestamp write failure must not block consolidation
  }
}

export function findUnconsolidatedSessions(dataDir: string): string[] {
  const eventsDir = path.join(dataDir, 'events');
  if (!fs.existsSync(eventsDir)) return [];

  const files = fs.readdirSync(eventsDir).filter((f) => f.endsWith('.jsonl'));
  const sessionIds: string[] = [];

  for (const file of files) {
    const sessionId = file.replace(/\.jsonl$/, '');
    const episodePath = path.join(dataDir, 'episodes', sessionId + '.episode.json');
    const failedPath = path.join(dataDir, 'episodes', sessionId + '.failed.json');
    if (!fs.existsSync(episodePath) && !fs.existsSync(failedPath)) {
      sessionIds.push(sessionId);
    }
  }

  return sessionIds;
}

export function findFailedConsolidations(dataDir: string): Array<{ sessionId: string; error: string; timestamp: string }> {
  const episodesDir = path.join(dataDir, 'episodes');
  if (!fs.existsSync(episodesDir)) return [];

  const results: Array<{ sessionId: string; error: string; timestamp: string }> = [];

  for (const file of fs.readdirSync(episodesDir).filter((f) => f.endsWith('.failed.json'))) {
    try {
      const raw = fs.readFileSync(path.join(episodesDir, file), 'utf-8');
      const parsed = JSON.parse(raw) as { sessionId?: string; error?: string; timestamp?: string };
      results.push({
        sessionId: parsed.sessionId ?? file.replace(/\.failed\.json$/, ''),
        error: parsed.error ?? 'unknown',
        timestamp: parsed.timestamp ?? '',
      });
    } catch {
      // malformed .failed.json — skip
    }
  }

  return results;
}

export function spawnConsolidation(
  sessionId: string,
  dbPath: string,
  dataDir: string,
): ChildProcess {
  const workerPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'consolidation-worker.js',
  );

  const child = spawn('node', [workerPath, sessionId, dbPath, dataDir], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}
