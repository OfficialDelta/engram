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
  tags?: Record<string, string>;
};

type BaseEvent = {
  type: string;
  sessionId: string;
  timestamp: string;
  tags?: Record<string, string>;
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
  userMessage?: string;
  agentSummary?: string;
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

export type WindowSummary = {
  windowIndex: number;
  eventRange: { start: number; end: number };
  summary: string;
  filesModified: string[];
  decisionsIdentified: string[];
  outcome: 'progress' | 'debugging' | 'blocked' | 'completed';
};

export type StructuredEpisode = {
  goal: string;
  approach: string;
  outcome: 'success' | 'partial' | 'failure';
  discoveries: Array<{ content: string; evidence: string; confidence: number }>;
  decisions: Array<{ content: string; rationale: string; isImplicit: boolean }>;
  errors: Array<{ description: string; rootCause: string; resolution: string }>;
};

export type GraphChangeRequest = {
  nodesToCreate: Array<{
    name: string;
    nodeType: GraphNode['nodeType'];
    description: string;
    affectedFiles: string[];
    causallyImportant: boolean;
  }>;
  nodesToUpdate: Array<{
    existingNodeId: string;
    updates: { description?: string; affectedFiles?: string[]; metadata?: Record<string, unknown> };
  }>;
  edgesToCreate: Array<{
    sourceNodeName: string;
    targetNodeName: string;
    relationshipType: string;
    weight: number;
  }>;
};

export type MergeAction = {
  action: 'merge' | 'create_child' | 'create_new';
  existingNodeId?: string;
  similarity?: number;
};

export type StrengthParams = {
  sourceEpisodeCount: number;
  sessionsWithoutReinforcement: number;
  successfulEpisodes: number;
  totalEpisodes: number;
  causallyImportant: boolean;
};

export type ConsolidationConfig = {
  client?: unknown;
  consolidationProvider?: 'api' | 'claude-cli';
  pass1Model?: string;
  pass2Model?: string;
  windowSize?: number;
  windowOverlap?: number;
  embeddingConfig?: { provider?: string; apiKey?: string };
  sinceTimestamp?: string;
};

export type EntryPoint = {
  type: 'file' | 'name' | 'node';
  value: string;
};

export type RetrievalConfig = {
  decayFactor?: number;
  activationThreshold?: number;
  maxDepth?: number;
  tierBoundaries?: { high: number; medium: number };
};

export type NodeResult = {
  node: GraphNode;
  activation: number;
};

export type TieredResults = {
  high: NodeResult[];
  medium: NodeResult[];
};

export type Annotation = {
  nodeId: string;
  name: string;
  description: string;
  strength: number;
};

export type ContradictionVerdict = 'NO_CONTRADICTION' | 'INDIRECT_CONTRADICTION' | 'DIRECT_CONTRADICTION';

export type ContradictionResult = {
  verdict: ContradictionVerdict;
  severity: 'low' | 'medium' | 'high';
  explanation: string;
  recommendation: string;
};

export type ContradictionConfig = {
  client?: unknown;
  model?: string;
  strengthThreshold?: number;
  maxFailures?: number;
};

export type ProgressVelocity = {
  currentVelocity: number;
  trend: 'increasing' | 'stable' | 'declining';
  uniqueFilesWritten: number;
  windowSize: number;
};

export type SearchToActRatio = {
  ratio: number;
  isConcerning: boolean;
  reads: number;
  writes: number;
  progressFraction: number;
  directorySpread: number;
};

export type ErrorRepetition = {
  repeatedErrors: Array<{ file: string; errorType: string; count: number }>;
  hasConcerningRepetitions: boolean;
};

export type MetricResults = {
  progressVelocity: ProgressVelocity;
  searchToActRatio: SearchToActRatio;
  errorRepetition: ErrorRepetition;
};

// Generic adapter API types

export type AdapterConfig = {
  cwd?: string;
  dataDir?: string;
  dbPath?: string;
  sessionId?: string;
};

export type AdapterSession = {
  sessionId: string;
  dataDir: string;
  dbPath: string;
  db: import('better-sqlite3').Database;
  close(): void;
};

export type ToolCallResult = {
  context: string;
  events: EngramEvent[];
};
