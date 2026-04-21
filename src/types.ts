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

// Event stream types

export type RawToolCall = {
  tool_name: string;
  tool_input: Record<string, unknown>;
  session_id: string;
};

type BaseEvent = {
  type: string;
  sessionId: string;
  timestamp: string;
};

export type FileReadEvent = BaseEvent & {
  type: 'file_read';
  filePath: string;
};

export type FileWriteEvent = BaseEvent & {
  type: 'file_write';
  filePath: string;
  linesChanged: number;
  evidenceSnippet: string;
};

export type TestRunEvent = BaseEvent & {
  type: 'test_run';
  command: string;
  exitCode: number;
  passed: boolean;
};

export type BuildEvent = BaseEvent & {
  type: 'build';
  command: string;
  exitCode: number;
};

export type ResearchEvent = BaseEvent & {
  type: 'research';
  query: string;
};

export type DecisionEvent = BaseEvent & {
  type: 'decision';
  content: string;
  rationale: string;
  affectedFiles: string[];
};

export type ExplorationEvent = BaseEvent & {
  type: 'exploration';
  filePath: string;
};

export type FixAttemptEvent = BaseEvent & {
  type: 'fix_attempt';
  filePath: string;
};

export type ProgressionEvent = BaseEvent & {
  type: 'progression';
  filePath: string;
};

export type ExpandingSearchEvent = BaseEvent & {
  type: 'expanding_search';
  filePaths: string[];
};

export type RepeatedRevisionEvent = BaseEvent & {
  type: 'repeated_revision';
  filePath: string;
  count: number;
};

export type TurnCompleteEvent = BaseEvent & {
  type: 'turn_complete';
  toolCallCount: number;
  turnNumber: number;
};

export type EngramEvent =
  | FileReadEvent
  | FileWriteEvent
  | TestRunEvent
  | BuildEvent
  | ResearchEvent
  | DecisionEvent
  | ExplorationEvent
  | FixAttemptEvent
  | ProgressionEvent
  | ExpandingSearchEvent
  | RepeatedRevisionEvent
  | TurnCompleteEvent;
