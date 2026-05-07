import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/config.js", () => ({
	loadConfig: vi.fn(() => ({
		llm: {},
		embedding: { provider: "voyage-3-lite" },
		consolidation: {},
	})),
}));

vi.mock("../core/embed.js", () => ({
	getEmbedding: vi.fn(async (texts: string[]) =>
		texts.map(() => Array.from({ length: 512 }, (_, i) => (i + 1) / 512)),
	),
	getDimensions: vi.fn().mockReturnValue(512),
}));

vi.mock("../core/project-identity.js", async () => {
	const actual = await vi.importActual<
		typeof import("../core/project-identity.js")
	>("../core/project-identity.js");
	return {
		...actual,
		getDbPath: vi.fn(),
	};
});

describe("runReEmbed", () => {
	let runReEmbed: typeof import("../cli/re-embed.js").runReEmbed;
	let initializeSchema: typeof import("../db/migrations.js").initializeSchema;
	let createNode: typeof import("../db/graph.js").createNode;
	let getEmbedding: typeof import("../core/embed.js").getEmbedding;
	let getDbPath: typeof import("../core/project-identity.js").getDbPath;

	let tmpDir: string;

	beforeEach(async () => {
		vi.clearAllMocks();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-re-embed-"));

		const reEmbed = await import("../cli/re-embed.js");
		runReEmbed = reEmbed.runReEmbed;
		const migrations = await import("../db/migrations.js");
		initializeSchema = migrations.initializeSchema;
		const graph = await import("../db/graph.js");
		createNode = graph.createNode;
		const embed = await import("../core/embed.js");
		getEmbedding = embed.getEmbedding;
		const projectIdentity = await import("../core/project-identity.js");
		getDbPath = projectIdentity.getDbPath;
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns early with message when DB does not exist", async () => {
		vi.mocked(getDbPath).mockReturnValue(
			path.join(tmpDir, "nonexistent", "engram.db"),
		);

		const result = await runReEmbed({ cwd: tmpDir });

		expect(result.nodesEmbedded).toBe(0);
		expect(vi.mocked(getEmbedding)).not.toHaveBeenCalled();
	});

	it("rebuilds vec0 and updates metadata with 0 nodes", async () => {
		const dbPath = path.join(tmpDir, "engram.db");
		const db = initializeSchema(dbPath, 384, "local");
		db.close();

		vi.mocked(getDbPath).mockReturnValue(dbPath);

		const result = await runReEmbed({ cwd: tmpDir });

		expect(result).toEqual({
			nodesEmbedded: 0,
			provider: "voyage-3-lite",
			dimension: 512,
		});
		expect(vi.mocked(getEmbedding)).not.toHaveBeenCalled();

		const { Database } = await import("../db/migrations.js");
		const sqliteVec = await import("sqlite-vec");
		const verifyDb = new Database(dbPath, { readonly: true });
		sqliteVec.load(verifyDb);
		try {
			const dim = verifyDb
				.prepare("SELECT value FROM metadata WHERE key = 'embedding_dimension'")
				.get() as { value: string };
			const prov = verifyDb
				.prepare("SELECT value FROM metadata WHERE key = 'embedding_provider'")
				.get() as { value: string };
			expect(dim.value).toBe("512");
			expect(prov.value).toBe("voyage-3-lite");
		} finally {
			verifyDb.close();
		}
	});

	it("embeds 5 nodes in a single batch", async () => {
		const dbPath = path.join(tmpDir, "engram.db");
		const db = initializeSchema(dbPath, 512, "voyage-3-lite");
		const nodeNames: string[] = [];
		for (let i = 1; i <= 5; i++) {
			const node = createNode(db, {
				name: `Node-${i}`,
				nodeType: "concept",
				description: `Description ${i}`,
				affectedFiles: [],
				strength: 1.0,
				metadata: { sourceEpisodes: ["ep-0"] },
			});
			nodeNames.push(node.name);
		}
		db.close();

		vi.mocked(getDbPath).mockReturnValue(dbPath);

		const result = await runReEmbed({ cwd: tmpDir });

		expect(result.nodesEmbedded).toBe(5);

		const mock = vi.mocked(getEmbedding);
		expect(mock).toHaveBeenCalledTimes(1);
		const texts = mock.mock.calls[0]![0] as string[];
		expect(texts).toHaveLength(5);
		for (let i = 0; i < 5; i++) {
			expect(texts[i]).toBe(`Node-${i + 1} Description ${i + 1}`);
		}

		const { Database } = await import("../db/migrations.js");
		const sqliteVec = await import("sqlite-vec");
		const verifyDb = new Database(dbPath, { readonly: true });
		sqliteVec.load(verifyDb);
		try {
			const count = verifyDb
				.prepare("SELECT COUNT(*) as c FROM node_embeddings")
				.get() as { c: number };
			expect(count.c).toBe(5);
		} finally {
			verifyDb.close();
		}
	});

	it("chunks 250 nodes into 3 batches", async () => {
		const dbPath = path.join(tmpDir, "engram.db");
		const db = initializeSchema(dbPath, 512, "voyage-3-lite");
		for (let i = 1; i <= 250; i++) {
			createNode(db, {
				name: `Node-${i}`,
				nodeType: "concept",
				description: `Description ${i}`,
				affectedFiles: [],
				strength: 1.0,
				metadata: { sourceEpisodes: ["ep-0"] },
			});
		}
		db.close();

		vi.mocked(getDbPath).mockReturnValue(dbPath);

		const result = await runReEmbed({ cwd: tmpDir });

		expect(result.nodesEmbedded).toBe(250);

		const mock = vi.mocked(getEmbedding);
		expect(mock).toHaveBeenCalledTimes(3);
		expect((mock.mock.calls[0]![0] as string[]).length).toBe(100);
		expect((mock.mock.calls[1]![0] as string[]).length).toBe(100);
		expect((mock.mock.calls[2]![0] as string[]).length).toBe(50);
	});

	it("dry-run does not modify the database", async () => {
		const dbPath = path.join(tmpDir, "engram.db");
		const db = initializeSchema(dbPath, 384, "local");
		for (let i = 1; i <= 3; i++) {
			createNode(db, {
				name: `Node-${i}`,
				nodeType: "concept",
				description: `Desc ${i}`,
				affectedFiles: [],
				strength: 1.0,
				metadata: { sourceEpisodes: ["ep-0"] },
			});
		}
		db.close();

		vi.mocked(getDbPath).mockReturnValue(dbPath);

		const result = await runReEmbed({ cwd: tmpDir, dryRun: true });

		expect(result.nodesEmbedded).toBe(0);
		expect(vi.mocked(getEmbedding)).not.toHaveBeenCalled();

		const { Database } = await import("../db/migrations.js");
		const sqliteVec = await import("sqlite-vec");
		const verifyDb = new Database(dbPath, { readonly: true });
		sqliteVec.load(verifyDb);
		try {
			const dim = verifyDb
				.prepare("SELECT value FROM metadata WHERE key = 'embedding_dimension'")
				.get() as { value: string };
			expect(dim.value).toBe("384");
		} finally {
			verifyDb.close();
		}
	});

	it("progress output contains node count", async () => {
		const dbPath = path.join(tmpDir, "engram.db");
		const db = initializeSchema(dbPath, 512, "voyage-3-lite");
		for (let i = 1; i <= 5; i++) {
			createNode(db, {
				name: `Node-${i}`,
				nodeType: "concept",
				description: `Desc ${i}`,
				affectedFiles: [],
				strength: 1.0,
				metadata: { sourceEpisodes: ["ep-0"] },
			});
		}
		db.close();

		vi.mocked(getDbPath).mockReturnValue(dbPath);

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.join(" "));
		};

		try {
			await runReEmbed({ cwd: tmpDir });
		} finally {
			console.log = origLog;
		}

		const allOutput = logs.join("\n");
		expect(allOutput).toContain("5");
		expect(allOutput).toContain("voyage-3-lite");
	});

	it("metadata updated after re-embed", async () => {
		const dbPath = path.join(tmpDir, "engram.db");
		const db = initializeSchema(dbPath, 384, "local");
		for (let i = 1; i <= 2; i++) {
			createNode(db, {
				name: `Node-${i}`,
				nodeType: "concept",
				description: `Desc ${i}`,
				affectedFiles: [],
				strength: 1.0,
				metadata: { sourceEpisodes: ["ep-0"] },
			});
		}
		db.close();

		vi.mocked(getDbPath).mockReturnValue(dbPath);

		await runReEmbed({ cwd: tmpDir });

		const { Database } = await import("../db/migrations.js");
		const sqliteVec = await import("sqlite-vec");
		const verifyDb = new Database(dbPath, { readonly: true });
		sqliteVec.load(verifyDb);
		try {
			const prov = verifyDb
				.prepare("SELECT value FROM metadata WHERE key = 'embedding_provider'")
				.get() as { value: string };
			const dim = verifyDb
				.prepare("SELECT value FROM metadata WHERE key = 'embedding_dimension'")
				.get() as { value: string };
			expect(prov.value).toBe("voyage-3-lite");
			expect(dim.value).toBe("512");
		} finally {
			verifyDb.close();
		}
	});
});
