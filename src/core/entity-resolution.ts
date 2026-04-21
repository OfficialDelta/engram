import type { DatabaseType } from '../db/migrations.js';
import type { MergeAction } from '../types.js';
import { getEmbedding } from './embed.js';
import { findSimilar } from '../db/embeddings.js';

export async function resolveEntity(
  db: DatabaseType,
  proposedName: string,
  proposedDescription: string,
  embeddingConfig?: { provider?: string; apiKey?: string },
): Promise<MergeAction> {
  const embeddings = await getEmbedding(
    [proposedName + ' ' + proposedDescription],
    embeddingConfig,
  );
  const embedding = embeddings[0]!;

  const results = findSimilar(db, embedding, 0.80, 5);

  if (results.length === 0) {
    return { action: 'create_new' };
  }

  const top = results[0]!;
  if (top.similarity > 0.95) {
    return { action: 'merge', existingNodeId: top.nodeId, similarity: top.similarity };
  }

  return { action: 'create_child', existingNodeId: top.nodeId, similarity: top.similarity };
}
