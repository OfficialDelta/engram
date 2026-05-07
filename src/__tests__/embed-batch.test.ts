import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphChangeRequest } from "../types.js";

vi.mock("../core/config.js", () => ({
	loadConfig: vi.fn(() => ({
		llm: {},
		embedding: { provider: "ollama", ollamaUrl: "http://localhost:11434" },
		consolidation: { turnThreshold: 5, eventThreshold: 50 },
	})),
}));

describe("Ollama concurrent embedding via Promise.all", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("fires all fetch calls concurrently and returns one embedding per text", async () => {
		let callCount = 0;
		globalThis.fetch = vi.fn().mockImplementation(() => {
			callCount++;
			const idx = callCount;
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve({ embedding: [idx * 0.1, idx * 0.2] }),
			});
		});

		const { getEmbedding } =
			await vi.importActual<typeof import("../core/embed.js")>(
				"../core/embed.js",
			);
		const result = await getEmbedding(["alpha", "beta", "gamma"], {
			provider: "ollama",
		});

		expect(result).toHaveLength(3);
		expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(3);
		for (const emb of result) {
			expect(emb.length).toBeGreaterThan(0);
		}
	});
});

vi.mock("../core/embed.ts", () => ({
	getEmbedding: vi
		.fn()
		.mockImplementation(async (texts: string[]) =>
			texts.map(() => Array.from({ length: 512 }, (_, i) => (i + 1) / 512)),
		),
	getDimensions: vi.fn().mockReturnValue(512),
}));

vi.mock("../core/entity-resolution.ts", () => ({
	resolveEntity: vi.fn().mockResolvedValue({ action: "create_new" }),
	shouldUpdateDescription: vi.fn().mockResolvedValue(true),
}));

describe("applyGraphChanges batch embedding", () => {
	let applyGraphChanges: typeof import("../core/consolidation.js").applyGraphChanges;
	let initializeSchema: typeof import("../db/migrations.js").initializeSchema;

	beforeEach(async () => {
		vi.clearAllMocks();
		const mod = await import("../core/consolidation.js");
		applyGraphChanges = mod.applyGraphChanges;
		const migrations = await import("../db/migrations.js");
		initializeSchema = migrations.initializeSchema;
	});

	it("batches 5 create_new nodes into exactly 1 getEmbedding call", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-batch-"));
		const dbPath = path.join(tmpDir, "test.db");
		const db = initializeSchema(dbPath);

		try {
			const changes: GraphChangeRequest = {
				nodesToCreate: [
					{
						name: "Node-1",
						nodeType: "concept",
						description: "Desc 1",
						affectedFiles: [],
						causallyImportant: false,
					},
					{
						name: "Node-2",
						nodeType: "pattern",
						description: "Desc 2",
						affectedFiles: [],
						causallyImportant: false,
					},
					{
						name: "Node-3",
						nodeType: "file",
						description: "Desc 3",
						affectedFiles: ["/a.ts"],
						causallyImportant: true,
					},
					{
						name: "Node-4",
						nodeType: "entity",
						description: "Desc 4",
						affectedFiles: [],
						causallyImportant: false,
					},
					{
						name: "Node-5",
						nodeType: "decision",
						description: "Desc 5",
						affectedFiles: [],
						causallyImportant: true,
					},
				],
				nodesToUpdate: [],
				edgesToCreate: [],
			};

			await applyGraphChanges(db, changes, "sess-1", "ep-1", "success");

			const { getEmbedding } = await import("../core/embed.js");
			const mock = vi.mocked(getEmbedding);
			expect(mock).toHaveBeenCalledTimes(1);
			expect(mock.mock.calls[0]![0]).toHaveLength(5);

			const nodesCount = db
				.prepare("SELECT COUNT(*) as c FROM nodes")
				.get() as { c: number };
			expect(nodesCount.c).toBe(5);
		} finally {
			db.close();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("batches only non-merge ops (3 create_new out of 5 total)", async () => {
		const { resolveEntity } = await import("../core/entity-resolution.js");
		const { createNode } = await import("../db/graph.js");

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-batch-"));
		const dbPath = path.join(tmpDir, "test.db");
		const db = initializeSchema(dbPath);

		try {
			const existing1 = createNode(db, {
				name: "Existing-A",
				nodeType: "concept",
				description: "Pre-existing A",
				affectedFiles: [],
				strength: 1.0,
				metadata: { sourceEpisodes: ["ep-0"] },
			});
			const existing2 = createNode(db, {
				name: "Existing-B",
				nodeType: "pattern",
				description: "Pre-existing B",
				affectedFiles: [],
				strength: 1.0,
				metadata: { sourceEpisodes: ["ep-0"] },
			});

			let callIdx = 0;
			vi.mocked(resolveEntity).mockImplementation(async (_db, _name) => {
				callIdx++;
				if (callIdx <= 2) {
					return {
						action: "merge",
						existingNodeId: callIdx === 1 ? existing1.id : existing2.id,
					};
				}
				return { action: "create_new" };
			});

			const changes: GraphChangeRequest = {
				nodesToCreate: [
					{
						name: "Merge-1",
						nodeType: "concept",
						description: "Will merge",
						affectedFiles: [],
						causallyImportant: false,
					},
					{
						name: "Merge-2",
						nodeType: "pattern",
						description: "Will merge",
						affectedFiles: [],
						causallyImportant: false,
					},
					{
						name: "New-3",
						nodeType: "file",
						description: "Create new",
						affectedFiles: [],
						causallyImportant: false,
					},
					{
						name: "New-4",
						nodeType: "entity",
						description: "Create new",
						affectedFiles: [],
						causallyImportant: false,
					},
					{
						name: "New-5",
						nodeType: "decision",
						description: "Create new",
						affectedFiles: [],
						causallyImportant: false,
					},
				],
				nodesToUpdate: [],
				edgesToCreate: [],
			};

			const nodeIdMap = await applyGraphChanges(
				db,
				changes,
				"sess-1",
				"ep-1",
				"success",
			);

			const { getEmbedding } = await import("../core/embed.js");
			const mock = vi.mocked(getEmbedding);
			expect(mock).toHaveBeenCalledTimes(1);
			expect(mock.mock.calls[0]![0]).toHaveLength(3);

			expect(nodeIdMap.size).toBe(5);
			expect(nodeIdMap.get("Merge-1")).toBe(existing1.id);
			expect(nodeIdMap.get("Merge-2")).toBe(existing2.id);
		} finally {
			db.close();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("does not call getEmbedding when all nodes are merges", async () => {
		const { resolveEntity } = await import("../core/entity-resolution.js");
		const { createNode } = await import("../db/graph.js");

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-batch-"));
		const dbPath = path.join(tmpDir, "test.db");
		const db = initializeSchema(dbPath);

		try {
			const existing1 = createNode(db, {
				name: "Existing-X",
				nodeType: "concept",
				description: "Pre-existing X",
				affectedFiles: [],
				strength: 1.0,
				metadata: { sourceEpisodes: ["ep-0"] },
			});
			const existing2 = createNode(db, {
				name: "Existing-Y",
				nodeType: "pattern",
				description: "Pre-existing Y",
				affectedFiles: [],
				strength: 1.0,
				metadata: { sourceEpisodes: ["ep-0"] },
			});

			let callIdx = 0;
			vi.mocked(resolveEntity).mockImplementation(async () => {
				callIdx++;
				return {
					action: "merge",
					existingNodeId: callIdx === 1 ? existing1.id : existing2.id,
				};
			});

			const changes: GraphChangeRequest = {
				nodesToCreate: [
					{
						name: "MergeOnly-1",
						nodeType: "concept",
						description: "Merge",
						affectedFiles: [],
						causallyImportant: false,
					},
					{
						name: "MergeOnly-2",
						nodeType: "pattern",
						description: "Merge",
						affectedFiles: [],
						causallyImportant: false,
					},
				],
				nodesToUpdate: [],
				edgesToCreate: [],
			};

			const nodeIdMap = await applyGraphChanges(
				db,
				changes,
				"sess-1",
				"ep-1",
				"success",
			);

			const { getEmbedding } = await import("../core/embed.js");
			expect(vi.mocked(getEmbedding)).not.toHaveBeenCalled();

			expect(nodeIdMap.size).toBe(2);
			expect(nodeIdMap.get("MergeOnly-1")).toBe(existing1.id);
			expect(nodeIdMap.get("MergeOnly-2")).toBe(existing2.id);
		} finally {
			db.close();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
