import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  GraphNode,
  CreateNodeInput,
  UpdateNodeInput,
  GraphEdge,
  CreateEdgeInput,
  UpdateEdgeInput,
  Episode,
  CreateEpisodeInput,
} from '../types.js';

type Database = BetterSqlite3.Database;

interface NodeRow {
  id: string;
  name: string;
  node_type: string;
  description: string;
  affected_files: string;
  strength: number;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: string;
  source_node_id: string;
  target_node_id: string;
  relationship_type: string;
  weight: number;
  metadata: string;
  created_at: string;
}

interface EpisodeRow {
  id: string;
  session_id: string;
  summary: string;
  nodes_involved: string;
  timestamp: string;
  metadata: string;
}

function rowToNode(row: NodeRow): GraphNode {
  return {
    id: row.id,
    name: row.name,
    nodeType: row.node_type as GraphNode['nodeType'],
    description: row.description,
    affectedFiles: JSON.parse(row.affected_files) as string[],
    strength: row.strength,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    relationshipType: row.relationship_type,
    weight: row.weight,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function rowToEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    sessionId: row.session_id,
    summary: row.summary,
    nodesInvolved: JSON.parse(row.nodes_involved) as string[],
    timestamp: row.timestamp,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

export function createNode(db: Database, input: CreateNodeInput): GraphNode {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO nodes (id, name, node_type, description, affected_files, strength, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    input.nodeType,
    input.description,
    JSON.stringify(input.affectedFiles),
    input.strength,
    JSON.stringify(input.metadata),
    now,
    now,
  );
  return { id, ...input, createdAt: now, updatedAt: now };
}

export function getNode(db: Database, id: string): GraphNode | undefined {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
  if (!row) return undefined;
  return rowToNode(row);
}

export function updateNode(db: Database, id: string, updates: UpdateNodeInput): GraphNode | undefined {
  const existing = getNode(db, id);
  if (!existing) return undefined;

  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.nodeType !== undefined) { sets.push('node_type = ?'); values.push(updates.nodeType); }
  if (updates.description !== undefined) { sets.push('description = ?'); values.push(updates.description); }
  if (updates.affectedFiles !== undefined) { sets.push('affected_files = ?'); values.push(JSON.stringify(updates.affectedFiles)); }
  if (updates.strength !== undefined) { sets.push('strength = ?'); values.push(updates.strength); }
  if (updates.metadata !== undefined) { sets.push('metadata = ?'); values.push(JSON.stringify(updates.metadata)); }

  if (sets.length === 0) return existing;

  const now = new Date().toISOString();
  sets.push('updated_at = ?');
  values.push(now);
  values.push(id);

  db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getNode(db, id);
}

export function createEdge(db: Database, input: CreateEdgeInput): GraphEdge {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO edges (id, source_node_id, target_node_id, relationship_type, weight, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.sourceNodeId,
    input.targetNodeId,
    input.relationshipType,
    input.weight,
    JSON.stringify(input.metadata),
    now,
  );
  return { id, ...input, createdAt: now };
}

export function getEdge(db: Database, id: string): GraphEdge | undefined {
  const row = db.prepare('SELECT * FROM edges WHERE id = ?').get(id) as EdgeRow | undefined;
  if (!row) return undefined;
  return rowToEdge(row);
}

export function updateEdge(db: Database, id: string, updates: UpdateEdgeInput): GraphEdge | undefined {
  const existing = getEdge(db, id);
  if (!existing) return undefined;

  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.weight !== undefined) { sets.push('weight = ?'); values.push(updates.weight); }
  if (updates.metadata !== undefined) { sets.push('metadata = ?'); values.push(JSON.stringify(updates.metadata)); }

  if (sets.length === 0) return existing;

  values.push(id);
  db.prepare(`UPDATE edges SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getEdge(db, id);
}

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

export function getNodesByFile(db: Database, filePath: string): GraphNode[] {
  const pattern = `%"${escapeLike(filePath)}"%`;
  const rows = db.prepare(
    `SELECT * FROM nodes WHERE affected_files LIKE ? ESCAPE '\\'`
  ).all(pattern) as NodeRow[];
  return rows.map(rowToNode);
}

export function getDecisionNodesForFile(db: Database, filePath: string): GraphNode[] {
  const pattern = `%"${escapeLike(filePath)}"%`;
  const rows = db.prepare(
    `SELECT * FROM nodes WHERE affected_files LIKE ? ESCAPE '\\' AND node_type = 'decision'`
  ).all(pattern) as NodeRow[];
  return rows.map(rowToNode);
}

export function getConnectedNodes(db: Database, nodeId: string, depth: number = 1): GraphNode[] {
  const visited = new Set<string>([nodeId]);
  let frontier = [nodeId];

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const nextFrontier: string[] = [];
    for (const currentId of frontier) {
      const edges = db.prepare(
        'SELECT source_node_id, target_node_id FROM edges WHERE source_node_id = ? OR target_node_id = ?'
      ).all(currentId, currentId) as Array<{ source_node_id: string; target_node_id: string }>;

      for (const edge of edges) {
        const neighborId = edge.source_node_id === currentId ? edge.target_node_id : edge.source_node_id;
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          nextFrontier.push(neighborId);
        }
      }
    }
    frontier = nextFrontier;
  }

  visited.delete(nodeId);
  if (visited.size === 0) return [];

  const placeholders = [...visited].map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`).all(...visited) as NodeRow[];
  return rows.map(rowToNode);
}

export function createEpisode(db: Database, input: CreateEpisodeInput): Episode {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO episodes (id, session_id, summary, nodes_involved, timestamp, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.sessionId,
    input.summary,
    JSON.stringify(input.nodesInvolved),
    input.timestamp,
    JSON.stringify(input.metadata),
  );
  return { id, ...input };
}
