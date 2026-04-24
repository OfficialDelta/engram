#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDbPath } from '../core/project-identity.js';
import { loadConfig } from '../core/config.js';
import { getEmbedding, getDimensions } from '../core/embed.js';
import { initializeSchema, Database } from '../db/migrations.js';
import { storeEmbedding } from '../db/embeddings.js';
import * as sqliteVec from 'sqlite-vec';

export interface ReEmbedOptions {
  cwd: string;
  dryRun?: boolean;
}

export interface ReEmbedResult {
  nodesEmbedded: number;
  provider: string;
  dimension: number;
}

const BATCH_SIZE = 100;

export async function runReEmbed(options: ReEmbedOptions): Promise<ReEmbedResult> {
  const dbPath = getDbPath(options.cwd);

  if (!existsSync(dbPath)) {
    console.log('No engram database found. Run engram install first.');
    return { nodesEmbedded: 0, provider: '', dimension: 0 };
  }

  const config = loadConfig();
  const provider = config.embedding.provider ?? 'voyage-3-lite';
  const dimension = getDimensions(provider);

  const readDb = new Database(dbPath, { readonly: true });
  sqliteVec.load(readDb);
  let nodes: Array<{ id: string; name: string; description: string }>;
  try {
    nodes = readDb.prepare('SELECT id, name, description FROM nodes').all() as Array<{ id: string; name: string; description: string }>;
  } finally {
    readDb.close();
  }

  const nodeCount = nodes.length;
  console.log(nodeCount > 0
    ? `Re-embedding ${nodeCount} nodes (${provider}, ${dimension}d)...`
    : 'No nodes found. Rebuilding vec0 table only.');

  if (options.dryRun) {
    console.log(`Dry run: would re-embed ${nodeCount} nodes with ${provider} (${dimension}d)`);
    return { nodesEmbedded: 0, provider, dimension };
  }

  const db = initializeSchema(dbPath, dimension, provider, true);

  if (nodeCount > 0) {
    const texts = nodes.map(n => n.name + ' ' + n.description);
    const embeddingConfig = {
      provider,
      ...(config.embedding.apiKey ? { apiKey: config.embedding.apiKey } : {}),
      ...(config.embedding.ollamaUrl ? { ollamaUrl: config.embedding.ollamaUrl } : {}),
    };

    const allEmbeddings: Array<[string, number[]]> = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batchTexts = texts.slice(i, i + BATCH_SIZE);
      const batchNodes = nodes.slice(i, i + BATCH_SIZE);
      const batchEnd = Math.min(i + BATCH_SIZE, texts.length);
      console.log(`Embedding ${batchEnd}/${nodeCount} nodes...`);

      const vectors = await getEmbedding(batchTexts, embeddingConfig);
      for (let j = 0; j < batchNodes.length; j++) {
        allEmbeddings.push([batchNodes[j]!.id, vectors[j]!]);
      }
    }

    db.transaction(() => {
      for (const [nodeId, vector] of allEmbeddings) {
        storeEmbedding(db, nodeId, vector);
      }
    })();
  }

  console.log(`Re-embed complete: ${nodeCount} nodes, provider=${provider}, dimension=${dimension}`);
  db.close();

  return { nodesEmbedded: nodeCount, provider, dimension };
}

export function printUsage(): void {
  console.log(`Usage: engram re-embed [options]

Re-embed all nodes after changing embedding provider or dimension.

Drops the existing vec0 table, recreates it at the current provider's
dimension, and re-embeds all nodes in the knowledge graph.

Options:
  --dry-run  Show what would happen without making changes.
  --help     Show this help message.`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');

  runReEmbed({
    cwd: process.cwd(),
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
