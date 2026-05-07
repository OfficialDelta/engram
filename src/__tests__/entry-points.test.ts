import type BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	extractEntryPoints,
	resolveEntryPoints,
} from "../core/entry-points.js";
import { storeEmbedding } from "../db/embeddings.js";
import { createNode } from "../db/graph.js";
import { initializeSchema } from "../db/migrations.js";

vi.mock("../core/embed.js", () => ({
	getEmbedding: vi.fn(),
}));

import { getEmbedding } from "../core/embed.js";

const mockGetEmbedding = vi.mocked(getEmbedding);

const DIM = 512;

function makeBaseVector(): number[] {
	const v = new Array(DIM).fill(0);
	v[0] = 1.0;
	return v;
}

function seedNode(
	db: BetterSqlite3.Database,
	name: string,
	embedding: number[],
): string {
	const node = createNode(db, {
		name,
		nodeType: "concept",
		description: `Description of ${name}`,
		affectedFiles: [],
		strength: 1.0,
		metadata: {},
	});
	storeEmbedding(db, node.id, embedding);
	return node.id;
}

describe("extractEntryPoints", () => {
	it("extracts file paths from prompt", () => {
		const result = extractEntryPoints("check src/main.ts for issues");
		expect(result).toEqual([{ type: "file", value: "src/main.ts" }]);
	});

	it("extracts quoted concept names", () => {
		const result = extractEntryPoints('what about "auth flow" here?');
		expect(result).toEqual([{ type: "name", value: "auth flow" }]);
	});

	it("returns empty for natural language without patterns", () => {
		const result = extractEntryPoints("Why did we choose that web framework?");
		expect(result).toEqual([]);
	});

	it("returns empty for empty string", () => {
		const result = extractEntryPoints("");
		expect(result).toEqual([]);
	});
});

describe("resolveEntryPoints", () => {
	let db: BetterSqlite3.Database;

	beforeEach(() => {
		db = initializeSchema(":memory:");
		vi.clearAllMocks();
	});

	it("returns pattern entry points without calling embedding when file path found", async () => {
		const result = await resolveEntryPoints("check src/main.ts", db);
		expect(result).toEqual([{ type: "file", value: "src/main.ts" }]);
		expect(mockGetEmbedding).not.toHaveBeenCalled();
	});

	it("returns pattern entry points without calling embedding when quoted concept found", async () => {
		const result = await resolveEntryPoints('what about "auth flow"', db);
		expect(result).toEqual([{ type: "name", value: "auth flow" }]);
		expect(mockGetEmbedding).not.toHaveBeenCalled();
	});

	it("falls back to embedding search when no patterns extracted", async () => {
		const nodeId = seedNode(
			db,
			"Express to Fastify migration",
			makeBaseVector(),
		);
		mockGetEmbedding.mockResolvedValueOnce([makeBaseVector()]);

		const result = await resolveEntryPoints(
			"Why did we choose that web framework?",
			db,
		);

		expect(mockGetEmbedding).toHaveBeenCalledWith(
			["Why did we choose that web framework?"],
			undefined,
		);
		expect(result).toEqual([{ type: "node", value: nodeId }]);
	});

	it("returns empty array when embedding API throws", async () => {
		seedNode(db, "some-node", makeBaseVector());
		mockGetEmbedding.mockRejectedValueOnce(new Error("Network error"));

		const result = await resolveEntryPoints(
			"Why did we choose that web framework?",
			db,
		);

		expect(result).toEqual([]);
	});

	it("returns empty array when no embeddings in DB match", async () => {
		mockGetEmbedding.mockResolvedValueOnce([makeBaseVector()]);

		const result = await resolveEntryPoints(
			"Why did we choose that web framework?",
			db,
		);

		expect(mockGetEmbedding).toHaveBeenCalled();
		expect(result).toEqual([]);
	});

	it("returns empty array when getEmbedding returns empty array", async () => {
		seedNode(db, "some-node", makeBaseVector());
		mockGetEmbedding.mockResolvedValueOnce([]);

		const result = await resolveEntryPoints("some natural language query", db);

		expect(result).toEqual([]);
	});

	it("passes config through to getEmbedding", async () => {
		mockGetEmbedding.mockResolvedValueOnce([makeBaseVector()]);
		const config = { provider: "ollama", apiKey: "test-key" };

		await resolveEntryPoints("some query", db, config);

		expect(mockGetEmbedding).toHaveBeenCalledWith(["some query"], config);
	});
});
