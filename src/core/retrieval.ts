import type BetterSqlite3 from 'better-sqlite3';
import type { EntryPoint, RetrievalConfig, TieredResults, NodeResult, GraphNode } from '../types.js';
import { getNode, getNodesByFile, getNodesByName, getNodesByNameFuzzy, getEdgesForNode } from '../db/graph.js';

type Database = BetterSqlite3.Database;

const DEFAULT_CONFIG = {
  decayFactor: 0.6,
  activationThreshold: 0.1,
  maxDepth: 5,
  tierBoundaries: { high: 0.7, medium: 0.3 },
} as const;

function resolveEntryPoints(db: Database, entryPoints: EntryPoint[]): GraphNode[] {
  const nodes: GraphNode[] = [];
  for (const ep of entryPoints) {
    switch (ep.type) {
      case 'file':
        nodes.push(...getNodesByFile(db, ep.value));
        break;
      case 'name': {
        const exactMatches = getNodesByName(db, ep.value);
        if (exactMatches.length > 0) {
          nodes.push(...exactMatches);
        } else {
          nodes.push(...getNodesByNameFuzzy(db, ep.value));
        }
        break;
      }
      case 'node': {
        const node = getNode(db, ep.value);
        if (node) nodes.push(node);
        break;
      }
    }
  }
  return nodes;
}

export function spreadingActivation(
  db: Database,
  entryPoints: EntryPoint[],
  config?: RetrievalConfig,
): TieredResults {
  const {
    decayFactor,
    activationThreshold,
    maxDepth,
    tierBoundaries,
  } = { ...DEFAULT_CONFIG, ...config, tierBoundaries: { ...DEFAULT_CONFIG.tierBoundaries, ...config?.tierBoundaries } };

  const entryNodes = resolveEntryPoints(db, entryPoints);
  const entryNodeIds = new Set(entryNodes.map(n => n.id));

  const activationMap = new Map<string, number>();
  let frontier: Array<{ nodeId: string; activation: number }> = [];

  for (const node of entryNodes) {
    if (node.strength === 0) continue;
    activationMap.set(node.id, node.strength);
    frontier.push({ nodeId: node.id, activation: node.strength });
  }

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: Array<{ nodeId: string; activation: number }> = [];

    for (const { nodeId, activation: parentActivation } of frontier) {
      const edges = getEdgesForNode(db, nodeId);

      for (const edge of edges) {
        const neighborId = edge.sourceNodeId === nodeId ? edge.targetNodeId : edge.sourceNodeId;

        const neighborNode = getNode(db, neighborId);
        if (!neighborNode || neighborNode.strength === 0) continue;

        const childActivation = parentActivation * decayFactor * edge.weight;
        const existing = activationMap.get(neighborId) ?? 0;

        if (childActivation > existing) {
          activationMap.set(neighborId, childActivation);
          nextFrontier.push({ nodeId: neighborId, activation: childActivation });
        }
      }
    }

    frontier = nextFrontier;
  }

  const high: NodeResult[] = [];
  const medium: NodeResult[] = [];
  const low: NodeResult[] = [];

  for (const [nodeId, activation] of activationMap) {
    if (entryNodeIds.has(nodeId)) continue;
    if (activation < activationThreshold) continue;

    const node = getNode(db, nodeId);
    if (!node) continue;

    const result: NodeResult = { node, activation };

    if (activation > tierBoundaries.high) {
      high.push(result);
    } else if (activation >= tierBoundaries.medium) {
      medium.push(result);
    } else {
      low.push(result);
    }
  }

  return { high, medium, low };
}
