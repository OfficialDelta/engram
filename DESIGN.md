# Engram — Cognitive Memory Plugin for AI Coding Agents

## Vision

Build a plugin that gives AI coding agents persistent, biologically-inspired memory across sessions. The plugin captures what the agent does (via tool call interception), consolidates experiences into structured episodes and a knowledge graph (via LLM-powered consolidation), retrieves relevant knowledge before and during execution (via spreading activation on the graph), and detects contradictions between new code and prior decisions (via a lightweight sidecar model).

The system is harness-agnostic — it works with Claude Code, Codex, Gemini CLI, or any agent harness that exposes lifecycle hooks. It is NOT a GSD plugin — it is a standalone npm package with thin adapters per harness. GSD is one consumer.

## Project Location

~/Code/engram

## Technical Stack

- Runtime: Node.js / TypeScript (same ecosystem as Claude Code and GSD)
- Database: SQLite via better-sqlite3 (graph storage) + sqlite-vec extension (embedding storage)
- Embedding model: Anthropic's voyage-3-lite or OpenAI text-embedding-3-small via API
- Consolidation models: Claude Sonnet (Pass 1 window summaries), Claude Opus (Pass 2 episode extraction)
- Contradiction checker: Claude Haiku with extended thinking
- Test framework: node:test (same as GSD)
- Package manager: npm
- Distribution: npm package (npx engram install)

## Architecture — Five Components

### Component 1: Harness Layer (Event Stream Capture)

The harness layer sits between the coding agent and its tools. Every tool call passes through the harness. The harness classifies each tool call into a typed event and appends it to a JSONL file (one JSON object per line, flushed immediately).

Event classification is deterministic — based on tool name and parameters, NOT natural language parsing. The same tool call sequence always produces the same event types.

**Event types from direct tool classification:**

| Tool Call | Event Type | Captured Data |
|-----------|-----------|---------------|
| Read/View file | file_read | path, content hash, timestamp |
| Write/Edit file | file_write | path, diff (NOT full content), lines changed, evidence snippet (5-10 lines of the region modified) |
| Bash with test command | test_run | command, exit code, pass/fail counts, failing test names |
| Bash with build command | build | command, exit code, error summary + what was learned (agent text from following turn) |
| Web search | research | query, results count + what was learned (agent text from following turn) |
| Decision save (explicit) | decision | decision content, rationale, affected files |

**Derived event types from tool call patterns:**

| Pattern | Derived Type |
|---------|-------------|
| Read of a file not previously read in this task | exploration |
| Write to same file region after a failed test | fix_attempt |
| Write to new file after a passing test | progression |
| Multiple reads expanding outward (directory distance > 2 levels from prior reads over last 5 file reads) | expanding_search |
| Three or more writes to the same line range | repeated_revision |

**Turn-complete events:** On every Stop hook, a turn_complete event is appended capturing: user message summary, agent response summary (first ~200 tokens), tool call count for this turn, turn number. This ensures pure discussion turns (no tool calls) still produce events for consolidation.

**Evidence snippets:** Every file_write event includes a 5-10 line snippet of the region that was modified, captured at write time. This allows the consolidation engine to verify the agent's claims against actual code, and enables future retrieval to show "last time this region was modified, the relevant code was [snippet]."

**Minimum event threshold for consolidation:** On Stop hook, count events since last consolidation. If events < 3 AND all events are turn_complete with no tool calls, run lightweight Haiku consolidation (extract: topics discussed, decisions stated, constraints mentioned). If events >= 3 OR events include tool calls, run full two-pass consolidation.

**File format:** JSONL at {dataDir}/events/{sessionId}.jsonl. Each event is one JSON line, flushed with appendFileSync on every capture. Survives process crash, kill -9, power failure.

### Component 2: Consolidation Engine

Runs asynchronously on every Stop hook. Does NOT block the user. If the process dies before consolidation finishes, the next SessionStart finds un-consolidated event streams and queues them.

**Two-pass architecture:**

**Pass 1 — Sliding Window Summarization (Sonnet, parallel):**
- Divide events since last consolidation into overlapping windows of 8-12 events with 3-event overlap
- Each window summarized independently by Sonnet into ~200 tokens
- Overlap preserves causal chains spanning window boundaries
- Windows processed in parallel (Promise.all)
- Each summary captures: what the agent was trying to do (1 sentence), what happened with causal links (2-3 sentences), files modified, decisions identified, window outcome (progress/debugging/blocked/completed)

**Pass 2 — Episode Extraction (Opus, single pass):**
- Reads all window summaries (typically 600-2000 tokens total)
- Produces two outputs:
  1. Structured episode: goal, approach, outcome (success/partial/failure), discoveries (with evidence and confidence), decisions (explicit and implicit, with rationale), errors (with root cause and resolution)
  2. Graph change request: nodes to create, nodes to update, edges to create, edges to update

**Implicit decision handling:** Implicit decisions inferred by Pass 2 get strength 0.3-0.4 (vs 0.8-0.9 for explicit decisions). Retrieved with different framing: "Observed pattern: agent implemented X without discussing alternatives" vs "Decision: use X because Y." Pass 2 prompt constrains: "Only identify implicit decisions where behavior shows a clear choice between viable alternatives AND the agent's text references the unchosen alternative."

**Entity resolution (runs between Pass 2 and graph write):**
- For every proposed new node, generate embedding of name + description
- Search embedding database for similar existing nodes
- Similarity > 0.95: MERGE (same concept, update existing node, add source episode)
- Similarity 0.80-0.95: CREATE_CHILD with version_of edge to existing node
- Similarity < 0.80: CREATE_NEW

**Strength computation (mechanical, no LLM):**
- frequency = log2(1 + sourceEpisodeCount)
- recency = exp(-0.1 × sessionsWithoutReinforcement) — NOTE: activity-relative, not calendar-relative. If no sessions happen for 2 months, no decay occurs. Decay is driven by sessions where the node was NOT reinforced.
- outcomeConsistency = fraction of related episodes with outcome "success"
- causalImportance = 1.5 if knowledge prevented/caused failures, 1.0 otherwise
- strength = clamp(frequency × recency × outcomeConsistency × causalImportance, 0.0, 1.0)

**Supersession (not deletion):**
- When knowledge becomes outdated, set strength to 0.0, add supersedes edge from new node to old, record reason and episode ID
- Retrieval ignores strength-0 nodes
- Consolidation can still see them — if a future episode tries to recreate a superseded concept, entity resolution finds the match and the consolidator decides whether to un-supersede or annotate
- Enables trajectory reconstruction: "How has our auth approach evolved?"

**Consolidation state machine (derived from files, not a status field):**
- sessionId.jsonl exists, no sessionId.episode.json → NEEDS_CONSOLIDATION
- sessionId.jsonl + sessionId.episode.json both exist → CONSOLIDATED
- On SessionStart: scan for NEEDS_CONSOLIDATION files, queue them in background

### Component 3: Dual Database

**Knowledge Graph (SQLite with adjacency tables):**

Nodes table:
- id (TEXT PK), name (TEXT), type (concept|episode|decision|finding|error), description (TEXT), strength (REAL 0-1), status (active|superseded), superseded_by (FK), affected_files (JSON array), source_episodes (JSON array), created_at, updated_at

Edges table:
- id (TEXT PK), from_node (FK), to_node (FK), type (requires|interacts_with|discovered_during|caused_by|resolved_by|similar_to|contradicts|version_of|supersedes), strength (REAL 0-1), source_episodes (JSON array), created_at, updated_at

Episodes table:
- id (TEXT PK), session_id (TEXT), goal (TEXT), approach (TEXT), outcome (success|partial|failure), episode_data (JSON — full episode), created_at

Indexes: edges(from_node), edges(to_node), nodes(type), nodes(strength), nodes(affected_files)

**Embedding Database (SQLite with sqlite-vec):**

Virtual table: node_embeddings(node_id TEXT, embedding FLOAT[dimensions])
- dimensions depends on embedding model (1536 for OpenAI, 512 for voyage-3-lite)
- Used for entity resolution (deduplication) and fuzzy node lookup
- Updated whenever a node is created or its name/description changes

Database location: {dataDir}/engram.db (single file, both graph and embeddings)

### Component 4: Retrieval System

**Pre-execution retrieval (on SessionStart / UserPromptSubmit):**

Spreading activation algorithm:
1. Parse the current context for entry points (file paths, technology names, module names from the task plan or user message)
2. Find corresponding nodes in the graph (by file path match or name match)
3. Initialize activation at each entry node = node.strength
4. Spread activation through edges: spreadLevel = parentLevel × decayFactor × edge.strength
5. decayFactor = 0.6 (activation loses 40% per hop — this is an initial value to be calibrated empirically during evaluation)
6. activationThreshold = 0.1 (nodes below this are not retrieved)
7. Partition results into tiers:
   - High activation (> 0.7): full description injected into agent context
   - Medium activation (0.3-0.7): summary injected
   - Low activation (0.1-0.3): listed as "available via query_knowledge tool"

**Involuntary retrieval (on PostToolUse for file reads):**
- Track files seen in this session (Set)
- When agent reads a file not previously seen this session:
  - Query graph for nodes linked to this file with strength > 0.5
  - Format top 3 as brief annotations
  - Inject via harness's context injection mechanism (additionalContext for Claude Code)
  - Cost: single SQLite query, <10ms

**On-demand query tool:**
- Registered as a tool the agent can explicitly invoke
- Parameters: question (string), scope (current_project | all)
- Extract key terms from question, run spreading activation, format results
- This is the ONE thing optionally exposed as an MCP tool for harnesses that support it

### Component 5: Metacognitive Monitor

**Three abstract metrics (mechanical, computed from event stream):**

1. Progress velocity: unique files with meaningful writes per N tool calls. Declining velocity late in a task suggests stuck/thrashing.

2. Search-to-act ratio: reads/searches vs writes over a rolling window. Only flagged as concerning when ALL three conditions are true: ratio > threshold AND task progress > 50% AND directory distance of recent reads > expansion threshold. This avoids punishing thorough upfront research.

3. Error repetition: same error signature (file + error type) appearing after a fix attempt. 2 repetitions = normal debugging. 3+ = potentially wrong mental model.

**Write-time contradiction detection (Haiku sidecar):**

On every file_write event:
1. Query graph for decision nodes linked to the modified file with strength > 0.3
2. If no decisions found: skip (no cost)
3. If decisions found: call Haiku with extended thinking
   - Input: decision descriptions + code diff (~500 tokens)
   - Prompt: "Does this change contradict, weaken, or conflict with these decisions? Consider indirect contradictions."
   - Output: verdict (NO_CONTRADICTION | INDIRECT_CONTRADICTION | DIRECT_CONTRADICTION), severity, explanation, recommendation (~200 tokens)
4. If contradiction detected: inject warning into agent's next turn via harness context injection
5. The warning is advisory — the agent can override but must acknowledge

This runs asynchronously. The PostToolUse hook returns immediately after event capture + involuntary retrieval. The Haiku call runs in background. If contradiction detected, warning is injected on the NEXT PostToolUse hook's context injection, not the current one. One turn late is acceptable — the warning arrives before the next write.

Cost: ~700 tokens of Haiku per checked write. For a typical session with 5-8 writes where 2-3 have linked decisions, total overhead is ~2100 tokens of Haiku per session. Negligible.

**Probe failure count for contradiction checker:** If Haiku call fails (network error, timeout), increment failure count. 3 consecutive failures → disable contradiction checking for this session, log warning. Don't block execution for a monitoring failure.

## Integration Architecture — Plugin with Thin Adapters

The core is 90% of the code. Adapters are ~50 lines each.

**Core (harness-agnostic):**
- src/core/event-stream.ts — event capture and classification
- src/core/consolidation.ts — two-pass consolidation engine
- src/core/retrieval.ts — spreading activation
- src/core/involuntary.ts — file-access triggered retrieval
- src/core/contradiction.ts — Haiku write-time checking
- src/core/metacognitive.ts — three abstract metrics
- src/core/entity-resolution.ts — embedding-based deduplication
- src/core/strength.ts — mechanical strength computation
- src/core/supersession.ts — supersession logic

**Database:**
- src/db/graph.ts — SQLite graph operations (CRUD for nodes, edges, episodes)
- src/db/embeddings.ts — sqlite-vec embedding operations
- src/db/schema.sql — table definitions
- src/db/migrations.ts — schema versioning

**Adapters:**
- src/adapters/claude-code/hooks.json — hook registration
- src/adapters/claude-code/session-start.ts — pre-execution retrieval
- src/adapters/claude-code/post-tool-use.ts — event capture + involuntary + contradiction
- src/adapters/claude-code/stop.ts — consolidation trigger
- src/adapters/claude-code/user-prompt-submit.ts — retrieval between messages
- src/adapters/claude-code/session-end.ts — cleanup
- src/adapters/gsd/post-unit-hook.ts — GSD-specific context tagging (milestone/slice/task IDs)
- src/adapters/gsd/context-inject.ts — feed retrieval into GSD's prompt builder
- src/adapters/generic/api.ts — simple onToolCall / onSessionStart for other harnesses

**Optional MCP server:**
- src/mcp/query-knowledge.ts — the one tool worth exposing via MCP

**Data directory:**
- Default: ~/.engram/ (user-level, shared across projects)
- Per-project data in: ~/.engram/projects/{projectHash}/
  - engram.db (SQLite — graph + embeddings)
  - events/ (JSONL files per session)
  - episodes/ (consolidated episode JSON files)

**Installation:**
- npx engram install — writes Claude Code hooks.json entries, creates data dir, initializes DB
- npx engram install --gsd — also configures GSD post_unit_hooks
- npm install -g engram — for manual/generic setup

## Data Flow — Complete Lifecycle

Every Stop hook (agent finishes responding):
1. Append turn_complete event to JSONL (sync, <1ms)
2. Count events since last consolidation
3. If below threshold and no tool calls: Haiku discussion consolidation (async, 1-2s)
4. If above threshold or has tool calls: full two-pass consolidation (async, 10-15s)
5. Consolidation runs in background while user reads/types

Every PostToolUse hook (each tool call):
1. Classify tool call → typed event (sync, <1ms)
2. Append event to JSONL (sync, <1ms)
3. If file_read on new file: involuntary retrieval, inject annotation (sync, <10ms)
4. If file_write: queue contradiction check (async, 1-3s Haiku)
5. Return — does not block agent execution

Every UserPromptSubmit hook (user sends message):
1. Check if consolidation from last Stop has updated the graph
2. Parse user message for topic/file references
3. Run spreading activation from those references
4. Inject relevant knowledge via additionalContext
5. Return — agent sees knowledge as initial context

Every SessionStart hook:
1. Check for un-consolidated prior sessions → queue background consolidation
2. Identify project from working directory
3. Run pre-execution spreading activation from project context
4. Inject high-activation knowledge into initial context

Process crash / terminal close:
1. JSONL is on disk — every event was flushed immediately
2. Nothing is lost
3. Next SessionStart detects un-consolidated sessions, queues them
4. Graph has whatever was written before the crash — consistent because SQLite transactions

## Scaling Characteristics

| Metric | 10 Sessions | 100 Sessions | 1000 Sessions |
|--------|------------|-------------|--------------|
| Graph nodes | ~50 | ~500 | ~5,000 |
| Active nodes (strength > 0.3) | ~50 | ~200 | ~500 |
| Retrieval time | <50ms | <100ms | <200ms |
| Consolidation cost per session | ~3K tokens | ~3K tokens | ~3K tokens |
| Haiku sidecar cost per session | ~2K tokens | ~2K tokens | ~2K tokens |
| Database size | ~100KB | ~2MB | ~20MB |

Consolidation cost scales linearly with event count per session (more events = more windows in Pass 1, more window summaries for Pass 2), NOT with total graph size. Pass 1 cost ≈ 400 tokens × number of windows. Pass 2 cost ≈ 2000 + 200 × number of windows. A large session with 50+ events costs 8-10K tokens total.

Periodic maintenance (between milestones or daily): cross-episode pattern scan (nodes with 3+ same-type edges → create semantic pattern node), strength decay for unreinforced nodes, supersession check for nodes referencing deleted/renamed files. This is graph queries, not LLM calls.

## Test Strategy

Real child_process.exec with small bash test scripts — no mocks for shell execution.

Test scripts needed:
- test-exit-0.sh: exit 0 (simulates successful tool call)
- test-exit-1.sh: exit 1 (simulates failed test)
- test-slow.sh: sleep for configurable duration (tests timeout behavior)
- test-stateful.sh: fails first call, succeeds second (tests retry patterns)

**Test scenarios:**

1. Event capture: tool call → correct event type in JSONL
2. Derived events: read-after-fail → fix_attempt, read-new-file → exploration
3. Turn-complete events: pure discussion produces turn_complete events
4. Minimum threshold: <3 events with no tool calls → Haiku consolidation, not full two-pass
5. Pass 1 window overlap: causal chain spanning 2 windows preserved in both summaries
6. Pass 2 episode extraction: structured episode matches expected format
7. Entity resolution: "SQLite 3.53.0" merges with existing "SQLite" node (>0.95 similarity)
8. Entity resolution: "SQLite migration" creates child with version_of edge (0.80-0.95 similarity)
9. Entity resolution: completely new concept creates new node (<0.80 similarity)
10. Strength computation: frequency, recency, outcome, causal factors produce expected values
11. Strength decay: activity-relative, not calendar-relative. No sessions = no decay.
12. Supersession: old node gets strength 0, supersedes edge created, retrieval ignores it
13. Supersession recovery: future episode matching superseded node triggers consolidator review
14. Spreading activation: entry points activate connected nodes with decay per hop
15. Spreading activation: superseded nodes (strength 0) are skipped
16. Spreading activation: tiered output (high/medium/low) based on activation level
17. Involuntary retrieval: new file read → annotation injected
18. Involuntary retrieval: previously-seen file → no injection
19. Contradiction checker: direct contradiction detected and warned
20. Contradiction checker: indirect contradiction detected (code doesn't reference decision but undermines intent)
21. Contradiction checker: non-contradiction correctly passes
22. Contradiction checker: 3 consecutive Haiku failures → disable for session
23. Crash recovery: kill process mid-consolidation → next SessionStart finds and reconsolidates
24. Full cycle end-to-end: create project → execute session with tool calls → consolidation → new session → retrieval surfaces prior knowledge → write triggers contradiction check

## Constraints

- All LLM calls for consolidation and contradiction checking are async — NEVER block the agent or the user
- JSONL events are flushed synchronously (appendFileSync) — survives any crash
- SQLite writes use transactions — graph is always consistent
- No network-accessible API (unlike claude-mem's unauthenticated HTTP server on port 37777)
- No auto-injection of bulk context at SessionStart (unlike claude-mem's 25K token dump). Retrieval is selective via spreading activation.
- Embedding API calls are the only external network dependency. Cache embeddings aggressively — same text = same embedding, no need to re-call.
- The plugin does NOT modify the agent's behavior. It captures events, injects knowledge, and warns about contradictions. The agent can ignore all of it.

## Configuration

Settings in ~/.engram/config.json:

```json
{
  "embeddingProvider": "anthropic",
  "embeddingModel": "voyage-3-lite",
  "consolidationModel": "claude-sonnet-4-6",
  "episodeExtractionModel": "claude-opus-4-6",
  "contradictionModel": "claude-haiku-4-5",
  "decayFactor": 0.6,
  "activationThreshold": 0.1,
  "windowSize": 10,
  "windowOverlap": 3,
  "minEventsForFullConsolidation": 3,
  "contradictionStrengthThreshold": 0.3,
  "maxContradictionFailures": 3,
  "probeTimeoutMs": 30000
}
```

All values are configurable. The defaults are initial values to be calibrated empirically during evaluation. The decay factor (0.6), activation threshold (0.1), and window parameters (10/3) should be reported with sensitivity analysis in the paper.

## Out of Scope for v1

- UI/viewer for the knowledge graph (build later if needed)
- Multi-user shared memory (each user has their own ~/.engram)
- Real-time collaboration between multiple agents
- Training/fine-tuning models on the graph data
- GSD-specific features beyond basic context tagging
