import { describe, expect, it } from "vitest";
import {
	createEdge,
	createEpisode,
	createNode,
	deleteEdge,
	deleteNode,
	getConnectedNodes,
	getDecisionNodesForFile,
	getEdgesForNode,
	getNode,
	getNodesByFile,
	getNodesByName,
	getNodesByNameFuzzy,
	updateEdge,
	updateNode,
} from "../db/graph.js";
import { initializeSchema } from "../db/migrations.js";
import type {
	CreateEdgeInput,
	CreateEpisodeInput,
	CreateNodeInput,
} from "../types.js";

function freshDb() {
	return initializeSchema(":memory:");
}

function makeNodeInput(overrides?: Partial<CreateNodeInput>): CreateNodeInput {
	return {
		name: "test-node",
		nodeType: "concept",
		description: "a test node",
		affectedFiles: ["src/main.ts"],
		strength: 0.8,
		metadata: { key: "value" },
		...overrides,
	};
}

describe("graph CRUD operations", () => {
	describe("createNode + getNode", () => {
		it("round-trips all fields including parsed JSON", () => {
			const db = freshDb();
			const input = makeNodeInput({
				affectedFiles: ["src/a.ts", "src/b.ts"],
				metadata: { tags: ["important"], count: 42 },
			});

			const created = createNode(db, input);

			expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
			expect(created.name).toBe(input.name);
			expect(created.nodeType).toBe(input.nodeType);
			expect(created.description).toBe(input.description);
			expect(created.affectedFiles).toEqual(["src/a.ts", "src/b.ts"]);
			expect(created.strength).toBe(0.8);
			expect(created.metadata).toEqual({ tags: ["important"], count: 42 });
			expect(created.createdAt).toBeTruthy();
			expect(created.updatedAt).toBeTruthy();

			const fetched = getNode(db, created.id);
			expect(fetched).toBeDefined();
			expect(fetched!.id).toBe(created.id);
			expect(fetched!.affectedFiles).toEqual(["src/a.ts", "src/b.ts"]);
			expect(fetched!.metadata).toEqual({ tags: ["important"], count: 42 });
			expect(fetched!.nodeType).toBe("concept");

			db.close();
		});
	});

	describe("updateNode", () => {
		it("updates name and strength, sets updatedAt", () => {
			const db = freshDb();
			const node = createNode(db, makeNodeInput());

			const updated = updateNode(db, node.id, {
				name: "renamed",
				strength: 0.5,
			});
			expect(updated).toBeDefined();
			expect(updated!.name).toBe("renamed");
			expect(updated!.strength).toBe(0.5);
			expect(updated!.description).toBe(node.description);
			expect(updated!.updatedAt).toBeTruthy();

			const refetched = getNode(db, node.id);
			expect(refetched!.name).toBe("renamed");
			expect(refetched!.strength).toBe(0.5);

			db.close();
		});

		it("returns undefined for non-existent ID", () => {
			const db = freshDb();
			const result = updateNode(db, "fake-id-000", { name: "nope" });
			expect(result).toBeUndefined();
			db.close();
		});
	});

	describe("createEdge", () => {
		it("creates edge between two nodes with all fields", () => {
			const db = freshDb();
			const a = createNode(db, makeNodeInput({ name: "node-a" }));
			const b = createNode(db, makeNodeInput({ name: "node-b" }));

			const edgeInput: CreateEdgeInput = {
				sourceNodeId: a.id,
				targetNodeId: b.id,
				relationshipType: "depends_on",
				weight: 0.9,
				metadata: { reason: "import" },
			};
			const edge = createEdge(db, edgeInput);

			expect(edge.id).toMatch(/^[0-9a-f-]{36}$/);
			expect(edge.sourceNodeId).toBe(a.id);
			expect(edge.targetNodeId).toBe(b.id);
			expect(edge.relationshipType).toBe("depends_on");
			expect(edge.weight).toBe(0.9);
			expect(edge.metadata).toEqual({ reason: "import" });
			expect(edge.createdAt).toBeTruthy();

			db.close();
		});
	});

	describe("updateEdge", () => {
		it("updates weight on existing edge", () => {
			const db = freshDb();
			const a = createNode(db, makeNodeInput({ name: "a" }));
			const b = createNode(db, makeNodeInput({ name: "b" }));
			const edge = createEdge(db, {
				sourceNodeId: a.id,
				targetNodeId: b.id,
				relationshipType: "related",
				weight: 1.0,
				metadata: {},
			});

			const updated = updateEdge(db, edge.id, { weight: 0.3 });
			expect(updated).toBeDefined();
			expect(updated!.weight).toBe(0.3);

			db.close();
		});
	});

	describe("getNodesByFile", () => {
		it("returns nodes whose affectedFiles contain the path", () => {
			const db = freshDb();
			createNode(
				db,
				makeNodeInput({
					name: "n1",
					affectedFiles: ["src/main.ts", "src/util.ts"],
				}),
			);
			createNode(
				db,
				makeNodeInput({ name: "n2", affectedFiles: ["src/main.ts"] }),
			);
			createNode(
				db,
				makeNodeInput({ name: "n3", affectedFiles: ["src/other.ts"] }),
			);

			const results = getNodesByFile(db, "src/main.ts");
			const names = results.map((n) => n.name);

			expect(names).toHaveLength(2);
			expect(names).toContain("n1");
			expect(names).toContain("n2");

			db.close();
		});

		it("returns empty array for path not in any node", () => {
			const db = freshDb();
			createNode(db, makeNodeInput({ affectedFiles: ["src/a.ts"] }));

			const results = getNodesByFile(db, "src/nonexistent.ts");
			expect(results).toEqual([]);

			db.close();
		});
	});

	describe("getDecisionNodesForFile", () => {
		it("returns only decision-type nodes for the file", () => {
			const db = freshDb();
			createNode(
				db,
				makeNodeInput({
					name: "decision-1",
					nodeType: "decision",
					affectedFiles: ["src/api.ts"],
				}),
			);
			createNode(
				db,
				makeNodeInput({
					name: "concept-1",
					nodeType: "concept",
					affectedFiles: ["src/api.ts"],
				}),
			);
			createNode(
				db,
				makeNodeInput({
					name: "decision-2",
					nodeType: "decision",
					affectedFiles: ["src/other.ts"],
				}),
			);

			const results = getDecisionNodesForFile(db, "src/api.ts");

			expect(results).toHaveLength(1);
			expect(results[0]!.name).toBe("decision-1");
			expect(results[0]!.nodeType).toBe("decision");

			db.close();
		});
	});

	describe("getConnectedNodes", () => {
		it("returns direct neighbors at depth=1", () => {
			const db = freshDb();
			const a = createNode(db, makeNodeInput({ name: "A" }));
			const b = createNode(db, makeNodeInput({ name: "B" }));
			const c = createNode(db, makeNodeInput({ name: "C" }));

			createEdge(db, {
				sourceNodeId: a.id,
				targetNodeId: b.id,
				relationshipType: "r",
				weight: 1,
				metadata: {},
			});
			createEdge(db, {
				sourceNodeId: b.id,
				targetNodeId: c.id,
				relationshipType: "r",
				weight: 1,
				metadata: {},
			});

			const result = getConnectedNodes(db, a.id, 1);
			const names = result.map((n) => n.name);

			expect(names).toEqual(["B"]);

			db.close();
		});

		it("returns two-hop neighbors at depth=2", () => {
			const db = freshDb();
			const a = createNode(db, makeNodeInput({ name: "A" }));
			const b = createNode(db, makeNodeInput({ name: "B" }));
			const c = createNode(db, makeNodeInput({ name: "C" }));

			createEdge(db, {
				sourceNodeId: a.id,
				targetNodeId: b.id,
				relationshipType: "r",
				weight: 1,
				metadata: {},
			});
			createEdge(db, {
				sourceNodeId: b.id,
				targetNodeId: c.id,
				relationshipType: "r",
				weight: 1,
				metadata: {},
			});

			const result = getConnectedNodes(db, a.id, 2);
			const names = result.map((n) => n.name).sort();

			expect(names).toEqual(["B", "C"]);

			db.close();
		});

		it("traverses edges bidirectionally", () => {
			const db = freshDb();
			const a = createNode(db, makeNodeInput({ name: "A" }));
			const b = createNode(db, makeNodeInput({ name: "B" }));

			createEdge(db, {
				sourceNodeId: a.id,
				targetNodeId: b.id,
				relationshipType: "r",
				weight: 1,
				metadata: {},
			});

			const result = getConnectedNodes(db, b.id, 1);
			const names = result.map((n) => n.name);

			expect(names).toEqual(["A"]);

			db.close();
		});
	});

	describe("getEdgesForNode", () => {
		it("returns edges where node is source or target", () => {
			const db = freshDb();
			const a = createNode(db, makeNodeInput({ name: "A" }));
			const b = createNode(db, makeNodeInput({ name: "B" }));
			const c = createNode(db, makeNodeInput({ name: "C" }));

			const e1 = createEdge(db, {
				sourceNodeId: a.id,
				targetNodeId: b.id,
				relationshipType: "r",
				weight: 0.5,
				metadata: {},
			});
			const e2 = createEdge(db, {
				sourceNodeId: c.id,
				targetNodeId: a.id,
				relationshipType: "r",
				weight: 0.7,
				metadata: {},
			});
			createEdge(db, {
				sourceNodeId: b.id,
				targetNodeId: c.id,
				relationshipType: "r",
				weight: 1,
				metadata: {},
			});

			const edges = getEdgesForNode(db, a.id);
			const edgeIds = edges.map((e) => e.id).sort();

			expect(edges).toHaveLength(2);
			expect(edgeIds).toEqual([e1.id, e2.id].sort());

			db.close();
		});

		it("returns empty array for isolated node", () => {
			const db = freshDb();
			const a = createNode(db, makeNodeInput({ name: "isolated" }));

			const edges = getEdgesForNode(db, a.id);
			expect(edges).toEqual([]);

			db.close();
		});
	});

	describe("getNodesByName", () => {
		it("returns nodes with exact name match", () => {
			const db = freshDb();
			createNode(db, makeNodeInput({ name: "alpha" }));
			createNode(db, makeNodeInput({ name: "alpha" }));
			createNode(db, makeNodeInput({ name: "beta" }));

			const results = getNodesByName(db, "alpha");
			expect(results).toHaveLength(2);
			expect(results.every((n) => n.name === "alpha")).toBe(true);

			db.close();
		});

		it("returns empty array for non-existent name", () => {
			const db = freshDb();
			createNode(db, makeNodeInput({ name: "exists" }));

			const results = getNodesByName(db, "does-not-exist");
			expect(results).toEqual([]);

			db.close();
		});
	});

	describe("getNodesByNameFuzzy", () => {
		it("matches partial name substring", () => {
			const db = freshDb();
			createNode(db, makeNodeInput({ name: "AuthService" }));

			const results = getNodesByNameFuzzy(db, "Auth");
			expect(results).toHaveLength(1);
			expect(results[0]!.name).toBe("AuthService");

			db.close();
		});

		it("matches case-insensitively", () => {
			const db = freshDb();
			createNode(db, makeNodeInput({ name: "AuthService" }));

			const results = getNodesByNameFuzzy(db, "authservice");
			expect(results).toHaveLength(1);
			expect(results[0]!.name).toBe("AuthService");

			db.close();
		});

		it("matches full name (LIKE is superset of exact)", () => {
			const db = freshDb();
			createNode(db, makeNodeInput({ name: "AuthService" }));

			const results = getNodesByNameFuzzy(db, "AuthService");
			expect(results).toHaveLength(1);
			expect(results[0]!.name).toBe("AuthService");

			db.close();
		});

		it("returns empty array for no match", () => {
			const db = freshDb();
			createNode(db, makeNodeInput({ name: "AuthService" }));

			const results = getNodesByNameFuzzy(db, "nonexistent");
			expect(results).toEqual([]);

			db.close();
		});

		it("returns multiple matches", () => {
			const db = freshDb();
			createNode(db, makeNodeInput({ name: "ExpressRouter" }));
			createNode(db, makeNodeInput({ name: "ExpressMiddleware" }));
			createNode(db, makeNodeInput({ name: "FastifyRouter" }));

			const results = getNodesByNameFuzzy(db, "Express");
			const names = results.map((n) => n.name).sort();
			expect(names).toEqual(["ExpressMiddleware", "ExpressRouter"]);

			db.close();
		});

		it("escapes special LIKE characters in search term", () => {
			const db = freshDb();
			createNode(db, makeNodeInput({ name: "100% complete" }));
			createNode(db, makeNodeInput({ name: "100 items" }));

			const results = getNodesByNameFuzzy(db, "100%");
			expect(results).toHaveLength(1);
			expect(results[0]!.name).toBe("100% complete");

			db.close();
		});
	});

	describe("deleteNode", () => {
		it("removes node and all connected edges", () => {
			const db = freshDb();
			const a = createNode(db, makeNodeInput({ name: "A" }));
			const b = createNode(db, makeNodeInput({ name: "B" }));
			const c = createNode(db, makeNodeInput({ name: "C" }));

			createEdge(db, {
				sourceNodeId: a.id,
				targetNodeId: b.id,
				relationshipType: "r",
				weight: 1,
				metadata: {},
			});
			createEdge(db, {
				sourceNodeId: c.id,
				targetNodeId: a.id,
				relationshipType: "r",
				weight: 1,
				metadata: {},
			});
			createEdge(db, {
				sourceNodeId: b.id,
				targetNodeId: c.id,
				relationshipType: "r",
				weight: 1,
				metadata: {},
			});

			const deleted = deleteNode(db, a.id);
			expect(deleted).toBe(true);

			expect(getNode(db, a.id)).toBeUndefined();
			expect(getEdgesForNode(db, a.id)).toEqual([]);

			// b→c edge should survive
			const bcEdges = getEdgesForNode(db, b.id);
			expect(bcEdges).toHaveLength(1);

			db.close();
		});

		it("removes node embedding from node_embeddings", () => {
			const db = freshDb();
			const node = createNode(db, makeNodeInput({ name: "embedded" }));

			const dim = (
				db
					.prepare(
						"SELECT value FROM metadata WHERE key = 'embedding_dimension'",
					)
					.get() as { value: string }
			).value;
			const vector = new Float32Array(Number(dim)).fill(0.1);
			const buf = Buffer.from(vector.buffer);
			db.prepare("DELETE FROM node_embeddings WHERE node_id = ?").run(node.id);
			db.prepare(
				"INSERT INTO node_embeddings(node_id, embedding) VALUES (?, ?)",
			).run(node.id, buf);

			deleteNode(db, node.id);

			const row = db
				.prepare("SELECT node_id FROM node_embeddings WHERE node_id = ?")
				.get(node.id);
			expect(row).toBeUndefined();

			db.close();
		});

		it("returns false for non-existent node", () => {
			const db = freshDb();
			const result = deleteNode(db, "non-existent-id");
			expect(result).toBe(false);
			db.close();
		});
	});

	describe("deleteEdge", () => {
		it("removes a single edge without affecting nodes", () => {
			const db = freshDb();
			const a = createNode(db, makeNodeInput({ name: "A" }));
			const b = createNode(db, makeNodeInput({ name: "B" }));
			const edge = createEdge(db, {
				sourceNodeId: a.id,
				targetNodeId: b.id,
				relationshipType: "r",
				weight: 1,
				metadata: {},
			});

			const deleted = deleteEdge(db, edge.id);
			expect(deleted).toBe(true);

			expect(getEdgesForNode(db, a.id)).toEqual([]);
			expect(getNode(db, a.id)).toBeDefined();
			expect(getNode(db, b.id)).toBeDefined();

			db.close();
		});

		it("returns false for non-existent edge", () => {
			const db = freshDb();
			const result = deleteEdge(db, "non-existent-edge");
			expect(result).toBe(false);
			db.close();
		});
	});

	describe("createEpisode", () => {
		it("round-trips with nodesInvolved array", () => {
			const db = freshDb();
			const input: CreateEpisodeInput = {
				sessionId: "session-abc",
				summary: "user explored the graph",
				nodesInvolved: ["node-1", "node-2"],
				timestamp: new Date().toISOString(),
				metadata: { tool: "cli" },
			};

			const episode = createEpisode(db, input);

			expect(episode.id).toMatch(/^[0-9a-f-]{36}$/);
			expect(episode.sessionId).toBe("session-abc");
			expect(episode.summary).toBe("user explored the graph");
			expect(episode.nodesInvolved).toEqual(["node-1", "node-2"]);
			expect(episode.metadata).toEqual({ tool: "cli" });

			db.close();
		});
	});
});
