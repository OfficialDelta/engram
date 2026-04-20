export type GraphNode = {
  id: string;
  name: string;
  nodeType: 'concept' | 'decision' | 'pattern' | 'file' | 'entity';
  description: string;
  affectedFiles: string[];
  strength: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CreateNodeInput = Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>;

export type UpdateNodeInput = Partial<Pick<GraphNode, 'name' | 'description' | 'affectedFiles' | 'strength' | 'metadata' | 'nodeType'>>;

export type GraphEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationshipType: string;
  weight: number;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type CreateEdgeInput = Omit<GraphEdge, 'id' | 'createdAt'>;

export type UpdateEdgeInput = Partial<Pick<GraphEdge, 'weight' | 'metadata'>>;

export type Episode = {
  id: string;
  sessionId: string;
  summary: string;
  nodesInvolved: string[];
  timestamp: string;
  metadata: Record<string, unknown>;
};

export type CreateEpisodeInput = Omit<Episode, 'id'>;

export type EmbeddingSearchResult = {
  nodeId: string;
  distance: number;
  similarity: number;
};
