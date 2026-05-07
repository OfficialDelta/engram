import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleQueryKnowledge,
	handleSaveDecision,
	runMcp,
} from "../cli/mcp.js";
import { ensureDataDirs } from "../core/project-identity.js";
import { createEdge, createNode, getNode } from "../db/graph.js";
import { initializeSchema } from "../db/migrations.js";

vi.mock("../core/embed.js", () => ({
	getEmbedding: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
}));

vi.mock("../core/entity-resolution.js", () => ({
	resolveEntity: vi.fn().mockResolvedValue({ action: "create_new" }),
}));

vi.mock("../core/config.js", () => ({
	loadConfig: vi.fn().mockReturnValue({
		llm: {},
		embedding: { provider: "local" },
		consolidation: {},
	}),
	getConfigPath: vi.fn().mockReturnValue("/tmp/engram-test-config.json"),
}));

vi.mock("../db/embeddings.js", () => ({
	storeEmbedding: vi.fn(),
	findSimilar: vi.fn().mockReturnValue([]),
}));

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "engram-mcp-"));
}

describe("handleQueryKnowledge", () => {
	let tmpDir: string;
	let db: BetterSqlite3.Database;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		ensureDataDirs(tmpDir);
		const dbPath = path.join(tmpDir, "test-mcp.db");
		db = initializeSchema(dbPath);
	});

	afterEach(() => {
		db.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns context when graph has relevant nodes", async () => {
		const entry = createNode(db, {
			name: "AuthService",
			nodeType: "concept",
			description: "Handles user authentication and token management",
			affectedFiles: ["src/auth.ts"],
			strength: 1.0,
			metadata: {},
		});
		const neighbor = createNode(db, {
			name: "TokenStore",
			nodeType: "concept",
			description: "Persists refresh tokens for authenticated sessions",
			affectedFiles: ["src/tokens.ts"],
			strength: 1.0,
			metadata: {},
		});
		createEdge(db, {
			sourceNodeId: entry.id,
			targetNodeId: neighbor.id,
			relationshipType: "uses",
			weight: 1.0,
			metadata: {},
		});

		const result = await handleQueryKnowledge(db, "What about `AuthService`?");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]!.type).toBe("text");
		expect(result.content[0]!.text).toContain("TokenStore");
		expect(result.content[0]!.text.length).toBeGreaterThan(0);
	});

	it("returns empty message when graph is empty", async () => {
		const result = await handleQueryKnowledge(db, "`SomeModule`");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]!.type).toBe("text");
		expect(result.content[0]!.text).toBe("No knowledge stored yet.");
	});

	it("returns empty message when no entry points extracted", async () => {
		createNode(db, {
			name: "AuthService",
			nodeType: "concept",
			description: "Handles user authentication",
			affectedFiles: ["src/auth.ts"],
			strength: 1.0,
			metadata: {},
		});

		const result = await handleQueryKnowledge(db, "tell me about stuff");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]!.type).toBe("text");
		expect(result.content[0]!.text).toBe("No knowledge stored yet.");
	});

	it("returns empty message for empty string question", async () => {
		const result = await handleQueryKnowledge(db, "");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]!.type).toBe("text");
		expect(result.content[0]!.text).toBe("No knowledge stored yet.");
	});

	it("runMcp is exported as a function", () => {
		expect(typeof runMcp).toBe("function");
	});
});

describe("save_decision integration", () => {
	let tmpDir: string;
	let db: BetterSqlite3.Database;

	beforeEach(() => {
		vi.clearAllMocks();
		tmpDir = makeTmpDir();
		ensureDataDirs(tmpDir);
		const dbPath = path.join(tmpDir, "test-mcp.db");
		db = initializeSchema(dbPath);
	});

	afterEach(() => {
		db.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("saved decision is queryable via query_knowledge", async () => {
		const result = await handleSaveDecision(db, {
			decision: "Use SQLite for storage",
			rationale: "Lightweight, zero-config, embedded",
			affected_files: ["src/db/graph.ts"],
			alternatives_considered: ["PostgreSQL", "MongoDB"],
		});

		expect(result).not.toHaveProperty("isError");
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.action).toBe("created");
		expect(parsed.nodeId).toBeDefined();

		const row = db
			.prepare("SELECT * FROM nodes WHERE node_type = ?")
			.get("decision") as { id: string } | undefined;
		expect(row).toBeDefined();
		expect(row!.id).toBe(parsed.nodeId);

		// Spreading activation excludes entry nodes from results and returns neighbors.
		// Add a related concept node with an edge so the decision's neighborhood is non-empty.
		const neighbor = createNode(db, {
			name: "EmbeddedDatabasePattern",
			nodeType: "concept",
			description: "Pattern of using embedded databases for local-first apps",
			affectedFiles: ["src/db/graph.ts"],
			strength: 1.0,
			metadata: {},
		});
		createEdge(db, {
			sourceNodeId: parsed.nodeId,
			targetNodeId: neighbor.id,
			relationshipType: "supports",
			weight: 1.0,
			metadata: {},
		});

		const queryResult = await handleQueryKnowledge(
			db,
			"What about `Use SQLite for storage`?",
		);
		expect(queryResult.content).toHaveLength(1);
		expect(queryResult.content[0]!.text).not.toBe("No knowledge stored yet.");
		expect(queryResult.content[0]!.text).toContain("EmbeddedDatabasePattern");
	});

	it("saved decision node has correct metadata", async () => {
		const result = await handleSaveDecision(db, {
			decision: "Use REST over GraphQL",
			rationale: "Team familiarity and simpler tooling",
			affected_files: ["src/api/routes.ts"],
			alternatives_considered: ["GraphQL", "gRPC"],
		});

		expect(result).not.toHaveProperty("isError");
		const parsed = JSON.parse(result.content[0]!.text);

		const node = getNode(db, parsed.nodeId);
		expect(node).toBeDefined();
		expect(node!.nodeType).toBe("decision");

		const meta = node!.metadata as Record<string, unknown>;
		expect(meta.source).toBe("explicit");
		expect(meta.alternatives).toEqual(["GraphQL", "gRPC"]);
		expect(node!.strength).toBeGreaterThan(0);
		expect(node!.affectedFiles).toContain("src/api/routes.ts");
	});
});

describe("handleSaveDecision", () => {
	let tmpDir: string;
	let db: BetterSqlite3.Database;

	beforeEach(() => {
		vi.clearAllMocks();
		tmpDir = makeTmpDir();
		ensureDataDirs(tmpDir);
		const dbPath = path.join(tmpDir, "test-mcp.db");
		db = initializeSchema(dbPath);
	});

	afterEach(() => {
		db.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates a decision node with correct fields", async () => {
		const result = await handleSaveDecision(db, {
			decision: "Use PostgreSQL for persistence",
			rationale: "Better JSON support and scalability",
			affected_files: ["src/db.ts"],
			alternatives_considered: ["SQLite", "MySQL"],
		});

		expect(result).not.toHaveProperty("isError");
		expect(result.content).toHaveLength(1);
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.action).toBe("created");
		expect(parsed.nodeId).toBeDefined();

		const node = getNode(db, parsed.nodeId);
		expect(node).toBeDefined();
		expect(node!.nodeType).toBe("decision");
		expect(node!.name).toBe("Use PostgreSQL for persistence");
		expect(node!.description).toBe("Better JSON support and scalability");
		expect(node!.affectedFiles).toEqual(["src/db.ts"]);
		const meta = node!.metadata as Record<string, unknown>;
		expect(meta.rationale).toBe("Better JSON support and scalability");
		expect(meta.alternatives).toEqual(["SQLite", "MySQL"]);
		expect(meta.source).toBe("explicit");
	});

	it("returns merged action for duplicate decision", async () => {
		const { resolveEntity } = await import("../core/entity-resolution.js");
		const mockResolve = vi.mocked(resolveEntity);

		const existing = createNode(db, {
			name: "Use PostgreSQL",
			nodeType: "decision",
			description: "Original rationale",
			affectedFiles: [],
			strength: 0.8,
			metadata: {
				rationale: "Original rationale",
				alternatives: ["SQLite"],
				source: "explicit",
			},
		});

		mockResolve.mockResolvedValueOnce({
			action: "merge",
			existingNodeId: existing.id,
			similarity: 0.95,
		});

		const result = await handleSaveDecision(db, {
			decision: "Use PostgreSQL",
			rationale: "Additional justification",
			affected_files: [],
			alternatives_considered: ["MySQL"],
		});

		expect(result).not.toHaveProperty("isError");
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.action).toBe("merged");
		expect(parsed.nodeId).toBe(existing.id);

		const updated = getNode(db, existing.id);
		expect(updated!.description).toContain("Additional justification");
		const meta = updated!.metadata as Record<string, unknown>;
		expect(meta.alternatives).toEqual(
			expect.arrayContaining(["SQLite", "MySQL"]),
		);
	});

	it("handles missing optional fields", async () => {
		const result = await handleSaveDecision(db, {
			decision: "Use REST over GraphQL",
			rationale: "Team familiarity",
			affected_files: [],
			alternatives_considered: [],
		});

		expect(result).not.toHaveProperty("isError");
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.action).toBe("created");

		const node = getNode(db, parsed.nodeId);
		expect(node!.affectedFiles).toEqual([]);
		const meta = node!.metadata as Record<string, unknown>;
		expect(meta.alternatives).toEqual([]);
	});

	it("returns error on embedding failure", async () => {
		const { getEmbedding } = await import("../core/embed.js");
		const mockEmbed = vi.mocked(getEmbedding);
		mockEmbed.mockRejectedValueOnce(new Error("Embedding API unavailable"));

		const result = await handleSaveDecision(db, {
			decision: "Some decision",
			rationale: "Some rationale",
			affected_files: [],
			alternatives_considered: [],
		});

		expect(result).toHaveProperty("isError", true);
		expect(result.content[0]!.text).toContain("Embedding API unavailable");
	});

	it("creates version_of edge for create_child resolution", async () => {
		const { resolveEntity } = await import("../core/entity-resolution.js");
		const mockResolve = vi.mocked(resolveEntity);

		const parent = createNode(db, {
			name: "Use PostgreSQL v1",
			nodeType: "decision",
			description: "Original decision",
			affectedFiles: [],
			strength: 0.8,
			metadata: {},
		});

		mockResolve.mockResolvedValueOnce({
			action: "create_child",
			existingNodeId: parent.id,
			similarity: 0.7,
		});

		const result = await handleSaveDecision(db, {
			decision: "Use PostgreSQL v2",
			rationale: "Updated approach",
			affected_files: [],
			alternatives_considered: [],
		});

		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.action).toBe("created");

		const edges = db
			.prepare(
				"SELECT * FROM edges WHERE source_node_id = ? AND relationship_type = ?",
			)
			.all(parsed.nodeId, "version_of") as Array<{
			target_node_id: string;
			weight: number;
		}>;
		expect(edges).toHaveLength(1);
		expect(edges[0]!.target_node_id).toBe(parent.id);
		expect(edges[0]!.weight).toBe(0.8);
	});
});
