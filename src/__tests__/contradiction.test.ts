import { describe, expect, it } from "vitest";
import { ContradictionChecker } from "../core/contradiction.js";
import { createNode } from "../db/graph.js";
import { initializeSchema } from "../db/migrations.js";
import type { ContradictionVerdict, CreateNodeInput } from "../types.js";

function freshDb() {
	return initializeSchema(":memory:");
}

function makeDecisionNode(
	overrides?: Partial<CreateNodeInput>,
): CreateNodeInput {
	return {
		name: "use-typescript",
		nodeType: "decision",
		description: "All source files must use TypeScript",
		affectedFiles: ["src/main.ts"],
		strength: 0.8,
		metadata: {},
		...overrides,
	};
}

function createMockClient(input: Record<string, unknown>) {
	return {
		messages: {
			create: async () => ({
				content: [
					{ type: "tool_use", id: "test", name: "check_contradiction", input },
				],
			}),
		},
	};
}

function createFailingClient() {
	return {
		messages: {
			create: async () => {
				throw new Error("API error");
			},
		},
	};
}

describe("ContradictionChecker", () => {
	it("returns null when no decision nodes found for file", async () => {
		const db = freshDb();
		const checker = new ContradictionChecker();
		const result = await checker.checkContradiction(
			db,
			"src/unknown.ts",
			"some code",
			{
				client: createMockClient({
					verdict: "DIRECT_CONTRADICTION",
					severity: "high",
					explanation: "x",
					recommendation: "y",
				}),
			},
		);
		expect(result).toBeNull();
	});

	it("returns null when all decisions are below strength threshold", async () => {
		const db = freshDb();
		createNode(db, makeDecisionNode({ strength: 0.2 }));
		const checker = new ContradictionChecker();
		const result = await checker.checkContradiction(
			db,
			"src/main.ts",
			"some code",
			{
				client: createMockClient({
					verdict: "DIRECT_CONTRADICTION",
					severity: "high",
					explanation: "x",
					recommendation: "y",
				}),
			},
		);
		expect(result).toBeNull();
	});

	it("detects direct contradiction", async () => {
		const db = freshDb();
		createNode(db, makeDecisionNode());
		const checker = new ContradictionChecker();
		const mockResult = {
			verdict: "DIRECT_CONTRADICTION" as ContradictionVerdict,
			severity: "high" as const,
			explanation: "Directly contradicts TypeScript decision",
			recommendation: "Use .ts extension",
		};
		const result = await checker.checkContradiction(
			db,
			"src/main.ts",
			"const x = 1",
			{
				client: createMockClient(
					mockResult as unknown as Record<string, unknown>,
				),
			},
		);
		expect(result).toEqual(mockResult);
	});

	it("detects indirect contradiction", async () => {
		const db = freshDb();
		createNode(db, makeDecisionNode());
		const checker = new ContradictionChecker();
		const mockResult = {
			verdict: "INDIRECT_CONTRADICTION" as ContradictionVerdict,
			severity: "medium" as const,
			explanation: "Indirectly contradicts pattern",
			recommendation: "Review approach",
		};
		const result = await checker.checkContradiction(db, "src/main.ts", "code", {
			client: createMockClient(
				mockResult as unknown as Record<string, unknown>,
			),
		});
		expect(result).toEqual(mockResult);
	});

	it("returns null for no contradiction verdict", async () => {
		const db = freshDb();
		createNode(db, makeDecisionNode());
		const checker = new ContradictionChecker();
		const result = await checker.checkContradiction(
			db,
			"src/main.ts",
			"good code",
			{
				client: createMockClient({
					verdict: "NO_CONTRADICTION",
					severity: "low",
					explanation: "No issues",
					recommendation: "None",
				}),
			},
		);
		expect(result).toBeNull();
	});

	it("increments failure count on API error", async () => {
		const db = freshDb();
		createNode(db, makeDecisionNode());
		const checker = new ContradictionChecker();
		const result = await checker.checkContradiction(db, "src/main.ts", "code", {
			client: createFailingClient(),
		});
		expect(result).toBeNull();
		expect(checker.failureCount).toBe(1);
	});

	it("disables after 3 consecutive failures", async () => {
		const db = freshDb();
		createNode(db, makeDecisionNode());
		const checker = new ContradictionChecker();
		const config = { client: createFailingClient() };

		await checker.checkContradiction(db, "src/main.ts", "code", config);
		await checker.checkContradiction(db, "src/main.ts", "code", config);
		await checker.checkContradiction(db, "src/main.ts", "code", config);

		expect(checker.isDisabled).toBe(true);
		expect(checker.failureCount).toBe(3);

		const result = await checker.checkContradiction(
			db,
			"src/main.ts",
			"code",
			config,
		);
		expect(result).toBeNull();
	});

	it("resets failure count on success", async () => {
		const db = freshDb();
		createNode(db, makeDecisionNode());
		const checker = new ContradictionChecker();

		await checker.checkContradiction(db, "src/main.ts", "code", {
			client: createFailingClient(),
		});
		expect(checker.failureCount).toBe(1);

		await checker.checkContradiction(db, "src/main.ts", "code", {
			client: createMockClient({
				verdict: "NO_CONTRADICTION",
				severity: "low",
				explanation: "ok",
				recommendation: "none",
			}),
		});
		expect(checker.failureCount).toBe(0);
	});
});
