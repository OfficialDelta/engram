# engram

[![npm version](https://img.shields.io/npm/v/engram)](https://www.npmjs.com/package/engram)
[![license](https://img.shields.io/npm/l/engram)](LICENSE)

Persistent knowledge graph for AI coding agents. Engram captures decisions, patterns, and context from your coding sessions and resurfaces them when relevant -- giving your AI agent long-term memory that survives across conversations.

## Quick Start

```bash
npm install -g engram
engram install        # Register hooks for this project
engram config         # Configure API keys and providers
engram status         # Check system health
```

After installation, engram runs automatically in the background. It captures events during your Claude Code sessions, consolidates them into a knowledge graph, and injects relevant context into future prompts.

## How It Works

Engram hooks into your AI coding agent's lifecycle at four points:

1. **Event capture** -- As you work, engram records file reads, writes, test runs, decisions, and other significant events via post-tool-use hooks.
2. **Consolidation** -- When a session ends (or on compaction), a two-pass LLM pipeline processes the event stream: first summarizing event windows into narratives, then extracting structured episodes, decisions, patterns, and graph changes.
3. **Knowledge graph** -- Extracted knowledge is stored as nodes (concepts, decisions, patterns, files, entities) and weighted edges in a SQLite database with vector embeddings for semantic search.
4. **Retrieval & context injection** -- On each new user prompt, engram extracts entry points (file paths, quoted concepts), applies spreading activation to traverse the graph, and injects the most relevant knowledge into the prompt context.

### Spreading Activation

Retrieval uses a spreading activation algorithm: entry nodes receive initial activation equal to their strength, then activation propagates along edges with configurable decay (default 0.6 per hop). Nodes above the activation threshold (default 0.3) are returned, tiered into high and medium relevance. This surfaces not just directly related knowledge, but connected context up to 5 hops away.

### Consolidation Pipeline

The consolidation pipeline runs in two passes:

- **Pass 1 (Summarize)** -- Sliding windows over the event stream produce causal narratives, identifying files modified, decisions made, gotchas discovered, and lessons learned.
- **Pass 2 (Extract)** -- All summaries are analyzed to produce structured episodes and graph change requests. Entity resolution prevents duplicate nodes by checking embedding similarity against existing graph entries.

## Architecture

```
User Prompt
    |
    v
[Entry Point Extraction] --> [Spreading Activation] --> [Context Builder]
                                     |                         |
                                     v                         v
                              [Knowledge Graph]         Injected Context
                              (SQLite + vec0)
                                     ^
                                     |
[Event Stream] --> [Consolidation Pipeline] --> [Entity Resolution]
     ^                    |
     |                    v
[Hook Adapters]    [Embedding Provider]
(Claude Code,       (Voyage, OpenAI,
 GSD)                Ollama, Local)
```

### Core Modules

| Module | Purpose |
|--------|---------|
| `src/core/consolidation.ts` | Two-pass LLM pipeline: summarization and graph extraction |
| `src/core/retrieval.ts` | Spreading activation algorithm for knowledge retrieval |
| `src/core/embed.ts` | Embedding provider abstraction (Voyage, OpenAI, Ollama, local) |
| `src/core/context-builder.ts` | Formats retrieved knowledge into prompt-injectable context |
| `src/core/entity-resolution.ts` | Deduplicates nodes via embedding similarity |
| `src/core/strength.ts` | Node strength: `frequency x recency x outcomeConsistency x causalImportance` |
| `src/core/event-stream.ts` | Event classification and derived event detection |
| `src/db/graph.ts` | SQLite CRUD for nodes, edges, and episodes |
| `src/db/embeddings.ts` | Vector storage and cosine similarity search (vec0) |
| `src/adapters/claude-code/` | Hook implementations for Claude Code lifecycle |

## CLI Reference

| Command | Description |
|---------|-------------|
| `engram install` | Register engram hooks and initialize project data |
| `engram uninstall` | Remove engram hooks from Claude Code settings |
| `engram status` | Show engram graph stats, hook registration, and data info |
| `engram config` | Show, set, or interactively configure engram settings |
| `engram mcp` | Start MCP server exposing engram tools |
| `engram consolidate` | Manually consolidate stale sessions |
| `engram inspect` | Show detailed knowledge graph summary |
| `engram re-embed` | Re-embed all nodes after changing embedding provider |
| `engram ingest` | Scan codebase to cold-start the knowledge graph |

Run `engram <command> --help` for detailed usage on any command.

## MCP Server

Engram exposes two tools via the [Model Context Protocol](https://modelcontextprotocol.io/):

- **`query_knowledge`** -- Query the knowledge graph with a natural language question.
- **`save_decision`** -- Save a decision to the knowledge graph for future retrieval.

To configure in Claude Code, add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "engram": { "command": "engram", "args": ["mcp"] }
  }
}
```

## Configuration

Engram stores its configuration in `~/.engram/config.json`. Use `engram config` to manage settings interactively, or set individual keys with `engram config set <key> <value>`.

### LLM Provider

| Setting | Env Variable | Description |
|---------|-------------|-------------|
| `llm.apiKey` | `ANTHROPIC_API_KEY` | Anthropic API key for consolidation |
| `llm.pass1Model` | -- | Model for summarization pass |
| `llm.pass2Model` | -- | Model for extraction pass |

### Embedding Provider

| Setting | Env Variable | Description |
|---------|-------------|-------------|
| `embedding.provider` | `ENGRAM_EMBEDDING_PROVIDER` | `voyage-3-lite` (default), `openai`, `text-embedding-3-small`, `ollama`, `local` |
| `embedding.apiKey` | -- | API key for embedding provider |
| `embedding.ollamaUrl` | -- | Ollama server URL (if using Ollama) |

### Consolidation

| Setting | Description |
|---------|-------------|
| `consolidation.provider` | `api` (Anthropic API) or `claude-cli` (Claude subscription) |
| `consolidation.windowSize` | Events per consolidation window (auto-computed by default) |
| `consolidation.windowOverlap` | Event overlap between windows |

## Data Storage

Engram stores project data in `.engram/` at the project root:

```
.engram/
  engram.db           # SQLite database (nodes, edges, embeddings)
  events/             # Per-session event logs (.jsonl)
  episodes/           # Consolidated session episodes
  logs/               # Hook execution logs
```

Add `.engram/` to your `.gitignore` -- the knowledge graph is local to each developer's machine.

## Requirements

- Node.js >= 20.0.0
- An Anthropic API key (for consolidation) or Claude CLI subscription
- An embedding provider API key, or use `local` for offline embeddings

## License

[MIT](LICENSE)
