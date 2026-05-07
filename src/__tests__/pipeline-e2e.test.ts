import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphChangeRequest, StructuredEpisode } from "../types.js";

vi.mock("../core/embed.js", () => ({
	getEmbedding: vi.fn(async (texts: string[]) => {
		return texts.map((text: string) => {
			let h = 0;
			for (const ch of text) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
			return Array.from({ length: 512 }, (_, i) => Math.sin(h + i * 0.37));
		});
	}),
	getDimensions: vi.fn().mockReturnValue(512),
}));

vi.mock("../core/consolidation.js", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../core/consolidation.js")>();
	return { ...mod, spawnConsolidation: vi.fn() };
});

vi.mock("../db/embeddings.js", () => ({
	storeEmbedding: vi.fn(),
	findSimilar: vi.fn(
		(_db: unknown, _vector: number[], _threshold: number, _limit: number) => {
			return [];
		},
	),
}));

const findSimilarMock = vi.mocked(
	(await import("../db/embeddings.js")).findSimilar,
);

function createTmpDataDir(): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-pipeline-"));
	fs.mkdirSync(path.join(tmpDir, "events"), { recursive: true });
	fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
	fs.mkdirSync(path.join(tmpDir, "episodes"), { recursive: true });
	fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true });
	return tmpDir;
}

function createMockClient(
	pass1JSON: string,
	pass2ToolInput: { episode: StructuredEpisode; changes: GraphChangeRequest },
) {
	return {
		messages: {
			create: vi
				.fn()
				.mockImplementation(async (params: Record<string, unknown>) => {
					if (params.tools) {
						return {
							content: [
								{
									type: "tool_use",
									id: "call_1",
									name: "extract_episode",
									input: pass2ToolInput,
								},
							],
						};
					}
					return { content: [{ type: "text", text: pass1JSON }] };
				}),
		},
	};
}

describe("Multi-Session Pipeline E2E: capture → consolidate → retrieve → context → contradiction", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(async () => {
		tmpDir = createTmpDataDir();
		dbPath = path.join(tmpDir, "engram.db");

		fs.mkdirSync(path.join(tmpDir, "project", "src"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, "project", "src", "auth.ts"),
			"export const auth = {};",
		);
		fs.writeFileSync(
			path.join(tmpDir, "project", "src", "db-schema.ts"),
			"export const schema = {};",
		);
		fs.writeFileSync(
			path.join(tmpDir, "project", "src", "cache.ts"),
			"export const cache = {};",
		);

		const { initializeSchema } = await import("../db/migrations.js");
		const db = initializeSchema(dbPath);
		db.close();

		findSimilarMock.mockReset();
		findSimilarMock.mockReturnValue([]);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("3-session pipeline: auth → cache (merge) → retrieval → contradiction", async () => {
		const { appendEvent } = await import("../core/event-stream.js");
		const { consolidateSession } = await import("../core/consolidation.js");
		const { spreadingActivation } = await import("../core/retrieval.js");
		const { buildContext } = await import("../core/context-builder.js");
		const { initializeSchema } = await import("../db/migrations.js");
		const { ContradictionChecker } = await import("../core/contradiction.js");
		const { getNodesByName } = await import("../db/graph.js");

		const authFile = path.join(tmpDir, "project", "src", "auth.ts");
		const schemaFile = path.join(tmpDir, "project", "src", "db-schema.ts");
		const cacheFile = path.join(tmpDir, "project", "src", "cache.ts");

		// ─── Session 1: Auth module implementation ───────────────────────
		appendEvent(
			"session-1",
			{
				type: "file_read",
				sessionId: "session-1",
				timestamp: "2025-01-01T00:00:00Z",
				filePath: authFile,
			},
			tmpDir,
		);
		appendEvent(
			"session-1",
			{
				type: "file_write",
				sessionId: "session-1",
				timestamp: "2025-01-01T00:01:00Z",
				filePath: authFile,
				linesChanged: 25,
				evidenceSnippet: "jwt auth middleware with bcrypt",
			},
			tmpDir,
		);
		appendEvent(
			"session-1",
			{
				type: "file_read",
				sessionId: "session-1",
				timestamp: "2025-01-01T00:02:00Z",
				filePath: schemaFile,
			},
			tmpDir,
		);
		appendEvent(
			"session-1",
			{
				type: "test_run",
				sessionId: "session-1",
				timestamp: "2025-01-01T00:03:00Z",
				command: "npm test",
				exitCode: 0,
				passed: true,
			},
			tmpDir,
		);

		const pass1Session1 = JSON.stringify({
			summary: "Implemented auth middleware using bcrypt for password hashing",
			filesModified: [authFile, schemaFile],
			decisionsIdentified: ["Use bcrypt for password hashing"],
			outcome: "progress",
		});

		const pass2Session1: {
			episode: StructuredEpisode;
			changes: GraphChangeRequest;
		} = {
			episode: {
				goal: "Implement authentication",
				approach: "Added JWT middleware and bcrypt hashing",
				outcome: "success",
				discoveries: [
					{
						content: "bcrypt rounds set to 12",
						evidence: `${authFile}:15`,
						confidence: 0.9,
					},
				],
				decisions: [
					{
						content: "Use bcrypt for password hashing",
						rationale: "Industry standard, configurable work factor",
						isImplicit: false,
					},
				],
				errors: [],
			},
			changes: {
				nodesToCreate: [
					{
						name: "auth-middleware",
						nodeType: "pattern",
						description:
							"JWT-based authentication middleware for route protection",
						affectedFiles: [authFile],
						causallyImportant: true,
					},
					{
						name: "bcrypt-hashing",
						nodeType: "decision",
						description: "Use bcrypt with 12 rounds for password hashing",
						affectedFiles: [authFile],
						causallyImportant: false,
					},
				],
				nodesToUpdate: [],
				edgesToCreate: [
					{
						sourceNodeName: "auth-middleware",
						targetNodeName: "bcrypt-hashing",
						relationshipType: "depends_on",
						weight: 1.0,
					},
				],
			},
		};

		const mockClient1 = createMockClient(pass1Session1, pass2Session1);
		await consolidateSession("session-1", dbPath, tmpDir, {
			client: mockClient1,
		});

		// Verify session 1 results
		const db1 = initializeSchema(dbPath);
		const nodesAfterS1 = db1.prepare("SELECT * FROM nodes").all() as Array<{
			name: string;
		}>;
		expect(nodesAfterS1.length).toBe(2);
		const nodeNamesS1 = nodesAfterS1.map((r) => r.name);
		expect(nodeNamesS1).toContain("auth-middleware");
		expect(nodeNamesS1).toContain("bcrypt-hashing");

		const edgesAfterS1 = db1.prepare("SELECT * FROM edges").all() as Array<{
			relationship_type: string;
		}>;
		expect(edgesAfterS1.length).toBe(1);
		db1.close();

		// ─── Session 2: Cache layer that depends on auth ─────────────────
		appendEvent(
			"session-2",
			{
				type: "file_read",
				sessionId: "session-2",
				timestamp: "2025-01-02T00:00:00Z",
				filePath: cacheFile,
			},
			tmpDir,
		);
		appendEvent(
			"session-2",
			{
				type: "file_write",
				sessionId: "session-2",
				timestamp: "2025-01-02T00:01:00Z",
				filePath: cacheFile,
				linesChanged: 40,
				evidenceSnippet: "redis cache layer with auth-aware invalidation",
			},
			tmpDir,
		);
		appendEvent(
			"session-2",
			{
				type: "file_read",
				sessionId: "session-2",
				timestamp: "2025-01-02T00:02:00Z",
				filePath: authFile,
			},
			tmpDir,
		);

		// For session 2, configure findSimilar to return the existing
		// auth-middleware node ONLY when the embedding matches auth-middleware's
		// text (triggering entity resolution merge for that node only)
		const db2Pre = initializeSchema(dbPath);
		const existingAuthNode = getNodesByName(db2Pre, "auth-middleware");
		const authNodeId = existingAuthNode[0]!.id;
		db2Pre.close();

		// Compute the expected embedding for "auth-middleware JWT-based..."
		const authText =
			"auth-middleware JWT-based authentication middleware for route protection";
		let authHash = 0;
		for (const ch of authText)
			authHash = ((authHash << 5) - authHash + ch.charCodeAt(0)) | 0;
		const authEmbedding = Array.from({ length: 512 }, (_, i) =>
			Math.sin(authHash + i * 0.37),
		);

		findSimilarMock.mockImplementation(
			(_db: unknown, vector: number[], _threshold: number, _limit: number) => {
				// Cosine similarity check — only match auth-middleware embedding
				let dot = 0;
				let magA = 0;
				let magB = 0;
				for (let i = 0; i < vector.length; i++) {
					dot += vector[i]! * authEmbedding[i]!;
					magA += vector[i]! * vector[i]!;
					magB += authEmbedding[i]! * authEmbedding[i]!;
				}
				const similarity = dot / (Math.sqrt(magA) * Math.sqrt(magB));
				if (similarity > 0.95) {
					return [{ nodeId: authNodeId, distance: 1 - similarity, similarity }];
				}
				return [];
			},
		);

		const pass1Session2 = JSON.stringify({
			summary: "Added redis cache layer with auth-aware invalidation strategy",
			filesModified: [cacheFile],
			decisionsIdentified: ["Cache invalidation tied to auth events"],
			outcome: "progress",
		});

		const pass2Session2: {
			episode: StructuredEpisode;
			changes: GraphChangeRequest;
		} = {
			episode: {
				goal: "Add caching layer",
				approach: "Redis cache with invalidation on auth state changes",
				outcome: "success",
				discoveries: [
					{
						content: "Cache must invalidate on logout",
						evidence: `${cacheFile}:22`,
						confidence: 0.85,
					},
				],
				decisions: [
					{
						content: "Tie cache invalidation to auth events",
						rationale: "Prevents stale cached data after logout",
						isImplicit: false,
					},
				],
				errors: [],
			},
			changes: {
				nodesToCreate: [
					{
						name: "cache-layer",
						nodeType: "pattern",
						description:
							"Redis-based caching layer with auth-aware invalidation",
						affectedFiles: [cacheFile],
						causallyImportant: true,
					},
					{
						name: "auth-middleware",
						nodeType: "pattern",
						description:
							"JWT-based authentication middleware for route protection",
						affectedFiles: [authFile],
						causallyImportant: true,
					},
				],
				nodesToUpdate: [],
				edgesToCreate: [
					{
						sourceNodeName: "cache-layer",
						targetNodeName: "auth-middleware",
						relationshipType: "depends_on",
						weight: 1.0,
					},
				],
			},
		};

		const mockClient2 = createMockClient(pass1Session2, pass2Session2);
		await consolidateSession("session-2", dbPath, tmpDir, {
			client: mockClient2,
		});

		// Verify entity resolution merge: auth-middleware NOT duplicated
		const db2 = initializeSchema(dbPath);
		const authNodes = getNodesByName(db2, "auth-middleware");
		expect(authNodes.length).toBe(1);

		const mergedMeta = authNodes[0]!.metadata as {
			sourceEpisodes?: string[];
		};
		expect(mergedMeta.sourceEpisodes).toBeDefined();
		expect(mergedMeta.sourceEpisodes!.length).toBe(2);

		// Verify cache-layer node exists
		const cacheNodes = getNodesByName(db2, "cache-layer");
		expect(cacheNodes.length).toBe(1);

		// Verify cross-session edge exists (cache-layer → auth-middleware)
		const allEdges = db2.prepare("SELECT * FROM edges").all() as Array<{
			source_node_id: string;
			target_node_id: string;
			relationship_type: string;
		}>;
		const crossSessionEdge = allEdges.find(
			(e) =>
				e.source_node_id === cacheNodes[0]!.id &&
				e.target_node_id === authNodes[0]!.id,
		);
		expect(crossSessionEdge).toBeDefined();

		// ─── Cross-session retrieval verification ────────────────────────
		// Entry point: cache.ts file → should find cache-layer node
		// Then via edge traversal → auth-middleware → bcrypt-hashing
		// Entry nodes (cache-layer) are excluded per MEM021
		const tieredResults = spreadingActivation(db2, [
			{ type: "file", value: cacheFile },
		]);
		const allResults = [...tieredResults.high, ...tieredResults.medium];
		const resultNames = allResults.map((r) => r.node.name);

		// bcrypt-hashing reachable via: cache-layer → auth-middleware → bcrypt-hashing
		expect(resultNames).toContain("bcrypt-hashing");

		// Build context and verify cross-session knowledge
		const contextString = buildContext([], [], tieredResults);
		expect(contextString).toContain("bcrypt");
		expect(contextString).toContain("auth");

		// ─── Session 3: Contradiction detection ──────────────────────────
		const checker = new ContradictionChecker();

		const mockHaikuClient = {
			messages: {
				create: vi.fn().mockResolvedValue({
					content: [
						{
							type: "tool_use",
							id: "t1",
							name: "check_contradiction",
							input: {
								verdict: "DIRECT_CONTRADICTION",
								severity: "high",
								explanation:
									"Switching from bcrypt to argon2 directly contradicts the bcrypt-hashing decision",
								recommendation:
									"Review password hashing strategy before changing",
							},
						},
					],
				}),
			},
		};

		const contradictionResult = await checker.checkContradiction(
			db2,
			authFile,
			"switching from bcrypt to argon2 for password hashing",
			{ client: mockHaikuClient },
		);

		expect(contradictionResult).not.toBeNull();
		expect(contradictionResult!.verdict).toBe("DIRECT_CONTRADICTION");
		expect(contradictionResult!.severity).toBe("high");

		// Verify contradiction appears in context output
		const contextWithContradiction = buildContext(
			[contradictionResult!],
			[],
			tieredResults,
		);
		expect(contextWithContradiction).toContain("⚠️ CONTRADICTION");
		expect(contextWithContradiction).toContain("bcrypt");
		expect(contextWithContradiction).toContain("argon2");

		db2.close();
	});
});
