#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDbPath } from '../core/project-identity.js';
import { Database } from '../db/migrations.js';

export interface InspectOptions {
  cwd: string;
  top?: number;
  type?: string;
  superseded?: boolean;
  json?: boolean;
}

export interface InspectResult {
  dbPath: string;
  totalNodes: number;
  totalEdges: number;
  totalEpisodes: number;
  nodesByType: Array<{ type: string; count: number }>;
  edgesByType: Array<{ type: string; count: number }>;
  recentEpisodes: Array<{ id: string; sessionId: string; summary: string; timestamp: string }>;
  highStrengthNodes: Array<{ id: string; name: string; type: string; strength: number; description: string }>;
  supersededNodes: Array<{ id: string; name: string; type: string; description: string }>;
}

export function runInspect(options: InspectOptions): InspectResult {
  const dbPath = getDbPath(options.cwd);

  if (!existsSync(dbPath)) {
    throw new Error('No engram database found. Run engram install first.');
  }

  const db = new Database(dbPath, { readonly: true });

  const totalNodes = (db.prepare('SELECT COUNT(*) AS count FROM nodes').get() as { count: number }).count;
  const totalEdges = (db.prepare('SELECT COUNT(*) AS count FROM edges').get() as { count: number }).count;
  const totalEpisodes = (db.prepare('SELECT COUNT(*) AS count FROM episodes').get() as { count: number }).count;

  const nodesByType = db.prepare('SELECT node_type, COUNT(*) AS count FROM nodes GROUP BY node_type').all() as Array<{ node_type: string; count: number }>;
  const edgesByType = db.prepare('SELECT relationship_type, COUNT(*) AS count FROM edges GROUP BY relationship_type').all() as Array<{ relationship_type: string; count: number }>;
  const recentEpisodesRaw = db.prepare('SELECT id, session_id, summary, timestamp FROM episodes ORDER BY timestamp DESC LIMIT 5').all() as Array<{ id: string; session_id: string; summary: string; timestamp: string }>;

  const limit = options.top ?? 10;
  let highStrengthRaw: Array<{ id: string; name: string; node_type: string; strength: number; description: string }>;
  let supersededRaw: Array<{ id: string; name: string; node_type: string; description: string }>;

  if (options.type) {
    highStrengthRaw = db.prepare('SELECT id, name, node_type, strength, description FROM nodes WHERE strength > 0.7 AND node_type = ? ORDER BY strength DESC LIMIT ?').all(options.type, limit) as typeof highStrengthRaw;
    supersededRaw = db.prepare('SELECT id, name, node_type, description FROM nodes WHERE strength = 0 AND node_type = ?').all(options.type) as typeof supersededRaw;
  } else {
    highStrengthRaw = db.prepare('SELECT id, name, node_type, strength, description FROM nodes WHERE strength > 0.7 ORDER BY strength DESC LIMIT ?').all(limit) as typeof highStrengthRaw;
    supersededRaw = db.prepare('SELECT id, name, node_type, description FROM nodes WHERE strength = 0').all() as typeof supersededRaw;
  }

  db.close();

  return {
    dbPath,
    totalNodes,
    totalEdges,
    totalEpisodes,
    nodesByType: nodesByType.map((r) => ({ type: r.node_type, count: r.count })),
    edgesByType: edgesByType.map((r) => ({ type: r.relationship_type, count: r.count })),
    recentEpisodes: recentEpisodesRaw.map((r) => ({ id: r.id, sessionId: r.session_id, summary: r.summary, timestamp: r.timestamp })),
    highStrengthNodes: highStrengthRaw.map((r) => ({ id: r.id, name: r.name, type: r.node_type, strength: r.strength, description: r.description })),
    supersededNodes: supersededRaw.map((r) => ({ id: r.id, name: r.name, type: r.node_type, description: r.description })),
  };
}

export function formatInspect(result: InspectResult): string {
  const lines: string[] = ['engram inspect', ''];

  lines.push(`  Database: ${result.dbPath}`);

  lines.push('');
  lines.push('  Summary:');
  lines.push(`    Nodes:    ${result.totalNodes}`);
  lines.push(`    Edges:    ${result.totalEdges}`);
  lines.push(`    Episodes: ${result.totalEpisodes}`);

  lines.push('');
  lines.push('  Nodes by type:');
  if (result.nodesByType.length === 0) {
    lines.push('    (none)');
  } else {
    for (const entry of result.nodesByType) {
      lines.push(`    ${entry.type}: ${entry.count}`);
    }
  }

  lines.push('');
  lines.push('  Edges by type:');
  if (result.edgesByType.length === 0) {
    lines.push('    (none)');
  } else {
    for (const entry of result.edgesByType) {
      lines.push(`    ${entry.type}: ${entry.count}`);
    }
  }

  lines.push('');
  lines.push('  Recent episodes:');
  if (result.recentEpisodes.length === 0) {
    lines.push('    (none)');
  } else {
    for (const ep of result.recentEpisodes) {
      lines.push(`    ${ep.timestamp} [${ep.sessionId}] ${ep.summary}`);
    }
  }

  lines.push('');
  lines.push(`  High-strength nodes (top ${result.highStrengthNodes.length}):`);
  if (result.highStrengthNodes.length === 0) {
    lines.push('    (none)');
  } else {
    for (const node of result.highStrengthNodes) {
      lines.push(`    ${node.strength} ${node.name} (${node.type}) — ${node.description}`);
    }
  }

  lines.push('');
  lines.push('  Superseded nodes:');
  if (result.supersededNodes.length === 0) {
    lines.push('    (none)');
  } else {
    for (const node of result.supersededNodes) {
      lines.push(`    ${node.name} (${node.type}) — ${node.description}`);
    }
  }

  return lines.join('\n');
}

export function printUsage(): void {
  console.log(`Usage: engram inspect [options]

Inspect the engram knowledge graph — shows summary statistics, high-strength nodes, and superseded nodes.

Options:
  --top N        Number of high-strength nodes to display (default: 10)
  --type TYPE    Filter nodes by type (e.g. concept, decision)
  --superseded   Show only the superseded nodes section
  --json         Output raw JSON instead of formatted text
  --help         Show this help message`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  const json = args.includes('--json');
  const superseded = args.includes('--superseded');

  let top: number | undefined;
  const topIdx = args.indexOf('--top');
  if (topIdx !== -1 && args[topIdx + 1]) {
    top = parseInt(args[topIdx + 1]!, 10);
    if (isNaN(top)) {
      console.error('Error: --top requires a numeric argument');
      process.exit(1);
    }
  }

  let type: string | undefined;
  const typeIdx = args.indexOf('--type');
  if (typeIdx !== -1 && args[typeIdx + 1]) {
    type = args[typeIdx + 1];
  }

  const result = runInspect({ cwd: process.cwd(), ...(top != null ? { top } : {}), ...(type != null ? { type } : {}), superseded, json });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatInspect(result));
  }
}

const argv1Real = (() => { try { return realpathSync(resolve(process.argv[1] ?? '')); } catch { return resolve(process.argv[1] ?? ''); } })();
if (argv1Real === fileURLToPath(import.meta.url)) {
  main();
}
