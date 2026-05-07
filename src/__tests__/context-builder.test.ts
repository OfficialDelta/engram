import { describe, expect, it } from "vitest";
import { buildContext } from "../core/context-builder.js";
import type {
	Annotation,
	ContradictionResult,
	GraphNode,
	NodeResult,
	TieredResults,
} from "../types.js";

function makeNode(overrides?: Partial<GraphNode>): GraphNode {
	return {
		id: "n1",
		name: "test-node",
		nodeType: "concept",
		description: "A test node description.",
		affectedFiles: [],
		strength: 1.0,
		metadata: {},
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		...overrides,
	};
}

function makeResult(
	activation: number,
	overrides?: Partial<GraphNode>,
): NodeResult {
	return { node: makeNode(overrides), activation };
}

function makeContradiction(
	overrides?: Partial<ContradictionResult>,
): ContradictionResult {
	return {
		verdict: "DIRECT_CONTRADICTION",
		severity: "high",
		explanation: "Test contradiction",
		recommendation: "Fix it",
		...overrides,
	};
}

function makeAnnotation(name: string, desc: string): Annotation {
	return { nodeId: "n1", name, description: desc, strength: 0.9 };
}

const emptyTiered: TieredResults = { high: [], medium: [] };

describe("context-builder", () => {
	it("wraps output in delimiters", () => {
		const tiered: TieredResults = {
			high: [makeResult(0.8, { name: "SomeNode" })],
			medium: [],
		};
		const result = buildContext([], [], tiered);
		expect(result).toMatch(/^\[Engram: Prior project knowledge\]\n/);
		expect(result).toMatch(/\n\[End Engram context\]$/);
	});

	it("returns empty string for empty inputs", () => {
		expect(buildContext([], [], emptyTiered)).toBe("");
	});

	it("groups output by nodeType with correct headers", () => {
		const tiered: TieredResults = {
			high: [
				makeResult(0.9, { name: "Dec1", nodeType: "decision" }),
				makeResult(0.8, { name: "Pat1", nodeType: "pattern" }),
				makeResult(0.8, { name: "Con1", nodeType: "concept" }),
				makeResult(0.7, { name: "File1", nodeType: "file" }),
			],
			medium: [],
		};
		const result = buildContext([], [], tiered);
		expect(result).toContain("## Decisions");
		expect(result).toContain("## Findings");
		expect(result).toContain("## Context");
		expect(result).toContain("## File Context");
	});

	it("orders groups: Decisions → Findings → Context → File Context → Entities", () => {
		const tiered: TieredResults = {
			high: [
				makeResult(0.9, { name: "Con1", nodeType: "concept" }),
				makeResult(0.9, { name: "Dec1", nodeType: "decision" }),
				makeResult(0.9, { name: "Pat1", nodeType: "pattern" }),
				makeResult(0.9, { name: "File1", nodeType: "file" }),
				makeResult(0.9, { name: "Ent1", nodeType: "entity" }),
			],
			medium: [],
		};
		const result = buildContext([], [], tiered);
		const positions = [
			result.indexOf("## Decisions"),
			result.indexOf("## Findings"),
			result.indexOf("## Context"),
			result.indexOf("## File Context"),
			result.indexOf("## Entities"),
		];
		for (let i = 0; i < positions.length - 1; i++) {
			expect(positions[i]).toBeLessThan(positions[i + 1]!);
		}
	});

	it("includes session IDs from metadata.sourceEpisodes", () => {
		const tiered: TieredResults = {
			high: [
				makeResult(0.8, {
					name: "TrackedNode",
					metadata: { sourceEpisodes: ["session-abc", "session-def"] },
				}),
			],
			medium: [],
		};
		const result = buildContext([], [], tiered);
		expect(result).toContain("(sessions: session-abc, session-def)");
	});

	it("handles missing metadata gracefully", () => {
		const tiered: TieredResults = {
			high: [makeResult(0.8, { name: "NoMeta", metadata: {} })],
			medium: [],
		};
		const result = buildContext([], [], tiered);
		expect(result).toContain("NoMeta");
		expect(result).not.toContain("(sessions:");
	});

	it("labels high-tier with [high] and medium-tier with [medium]", () => {
		const tiered: TieredResults = {
			high: [makeResult(0.8, { name: "HighNode" })],
			medium: [makeResult(0.4, { name: "MedNode" })],
		};
		const result = buildContext([], [], tiered);
		expect(result).toContain("[high] HighNode");
		expect(result).toContain("[medium] MedNode");
	});

	it("medium tier shows only first sentence", () => {
		const tiered: TieredResults = {
			high: [],
			medium: [
				makeResult(0.4, {
					name: "Verbose",
					description:
						"First sentence here. Second sentence with more detail. Third sentence.",
				}),
			],
		};
		const result = buildContext([], [], tiered);
		expect(result).toContain("First sentence here.");
		expect(result).not.toContain("Second sentence");
	});

	it("enforces budget including delimiter overhead", () => {
		const tiered: TieredResults = {
			high: Array.from({ length: 50 }, (_, i) =>
				makeResult(0.9, { name: `Node${i}`, description: "x".repeat(100) }),
			),
			medium: [],
		};
		const budget = 200;
		const result = buildContext([], [], tiered, budget);
		expect(result.length).toBeLessThanOrEqual(budget);
		expect(result).toMatch(/^\[Engram: Prior project knowledge\]/);
		expect(result).toMatch(/\[End Engram context\]$/);
	});

	it("places contradictions after open delimiter and before grouped results", () => {
		const tiered: TieredResults = {
			high: [makeResult(0.8, { name: "SomeNode", nodeType: "decision" })],
			medium: [],
		};
		const result = buildContext([makeContradiction()], [], tiered);
		const _openEnd = result.indexOf("\n") + 1;
		const contradictionPos = result.indexOf("CONTRADICTION");
		const groupPos = result.indexOf("## Decisions");
		expect(contradictionPos).toBeGreaterThan(0);
		expect(contradictionPos).toBeLessThan(groupPos);
	});

	it("wraps contradictions-only output in delimiters", () => {
		const result = buildContext([makeContradiction()], [], emptyTiered);
		expect(result).toMatch(/^\[Engram: Prior project knowledge\]/);
		expect(result).toMatch(/\[End Engram context\]$/);
		expect(result).toContain("CONTRADICTION");
	});

	it("suppresses empty groups", () => {
		const tiered: TieredResults = {
			high: [makeResult(0.9, { name: "Dec1", nodeType: "decision" })],
			medium: [],
		};
		const result = buildContext([], [], tiered);
		expect(result).toContain("## Decisions");
		expect(result).not.toContain("## Findings");
		expect(result).not.toContain("## Context");
		expect(result).not.toContain("## File Context");
		expect(result).not.toContain("## Entities");
	});

	it("renders high-tier nodes before medium-tier within a group", () => {
		const tiered: TieredResults = {
			high: [makeResult(0.8, { name: "HighConcept", nodeType: "concept" })],
			medium: [makeResult(0.4, { name: "MedConcept", nodeType: "concept" })],
		};
		const result = buildContext([], [], tiered);
		const highPos = result.indexOf("[high] HighConcept");
		const medPos = result.indexOf("[medium] MedConcept");
		expect(highPos).toBeLessThan(medPos);
	});

	it("returns empty string with budget=0", () => {
		expect(
			buildContext(
				[makeContradiction()],
				[makeAnnotation("A", "b")],
				{ high: [makeResult(0.9, { name: "N" })], medium: [] },
				0,
			),
		).toBe("");
	});

	describe("cross-cutting decisions", () => {
		it("renders cross-cutting decisions in Project-wide decisions section", () => {
			const tiered: TieredResults = {
				high: [
					makeResult(0.9, {
						name: "CrossDec",
						nodeType: "decision",
						affectedFiles: ["a.ts", "b.ts", "c.ts"],
					}),
				],
				medium: [],
			};
			const result = buildContext([], [], tiered);
			expect(result).toContain("## Project-wide decisions");
			expect(result).toContain("CrossDec");
		});

		it("does not render cross-cutting decisions in Decisions group", () => {
			const tiered: TieredResults = {
				high: [
					makeResult(0.9, {
						name: "CrossDec",
						nodeType: "decision",
						affectedFiles: ["a.ts", "b.ts", "c.ts"],
					}),
				],
				medium: [],
			};
			const result = buildContext([], [], tiered);
			expect(result).not.toContain("## Decisions");
		});

		it("renders non-cross-cutting decisions in Decisions group normally", () => {
			const tiered: TieredResults = {
				high: [
					makeResult(0.9, {
						name: "LocalDec",
						nodeType: "decision",
						affectedFiles: ["a.ts"],
					}),
				],
				medium: [],
			};
			const result = buildContext([], [], tiered);
			expect(result).toContain("## Decisions");
			expect(result).toContain("LocalDec");
			expect(result).not.toContain("## Project-wide decisions");
		});

		it("splits decisions correctly when both cross-cutting and non-cross-cutting exist", () => {
			const tiered: TieredResults = {
				high: [
					makeResult(0.9, {
						id: "cross",
						name: "CrossDec",
						nodeType: "decision",
						affectedFiles: ["a.ts", "b.ts", "c.ts"],
					}),
					makeResult(0.8, {
						id: "local",
						name: "LocalDec",
						nodeType: "decision",
						affectedFiles: ["x.ts"],
					}),
				],
				medium: [],
			};
			const result = buildContext([], [], tiered);
			expect(result).toContain("## Project-wide decisions");
			expect(result).toContain("## Decisions");
			const pwdSection = result.slice(
				result.indexOf("## Project-wide decisions"),
				result.indexOf("## Decisions"),
			);
			expect(pwdSection).toContain("CrossDec");
			expect(pwdSection).not.toContain("LocalDec");
			const decSection = result.slice(result.indexOf("## Decisions"));
			expect(decSection).toContain("LocalDec");
			expect(decSection).not.toContain("CrossDec");
		});

		it("Project-wide decisions section appears before per-type groups", () => {
			const tiered: TieredResults = {
				high: [
					makeResult(0.9, {
						id: "cross",
						name: "CrossDec",
						nodeType: "decision",
						affectedFiles: ["a.ts", "b.ts", "c.ts"],
					}),
					makeResult(0.8, {
						id: "local",
						name: "LocalDec",
						nodeType: "decision",
						affectedFiles: ["x.ts"],
					}),
				],
				medium: [],
			};
			const result = buildContext([], [], tiered);
			const pwdPos = result.indexOf("## Project-wide decisions");
			const decPos = result.indexOf("## Decisions");
			expect(pwdPos).toBeGreaterThan(-1);
			expect(decPos).toBeGreaterThan(-1);
			expect(pwdPos).toBeLessThan(decPos);
		});

		it("non-decision nodes with 3+ affected files stay in their normal group", () => {
			const tiered: TieredResults = {
				high: [
					makeResult(0.9, {
						name: "BigPattern",
						nodeType: "pattern",
						affectedFiles: ["a.ts", "b.ts", "c.ts", "d.ts"],
					}),
				],
				medium: [],
			};
			const result = buildContext([], [], tiered);
			expect(result).toContain("## Findings");
			expect(result).toContain("BigPattern");
			expect(result).not.toContain("## Project-wide decisions");
		});

		it("decision with exactly 2 affected files stays in Decisions (boundary)", () => {
			const tiered: TieredResults = {
				high: [
					makeResult(0.9, {
						name: "TwoFileDec",
						nodeType: "decision",
						affectedFiles: ["a.ts", "b.ts"],
					}),
				],
				medium: [],
			};
			const result = buildContext([], [], tiered);
			expect(result).toContain("## Decisions");
			expect(result).toContain("TwoFileDec");
			expect(result).not.toContain("## Project-wide decisions");
		});

		it("decision with exactly 3 affected files goes to Project-wide decisions (boundary)", () => {
			const tiered: TieredResults = {
				high: [
					makeResult(0.9, {
						name: "ThreeFileDec",
						nodeType: "decision",
						affectedFiles: ["a.ts", "b.ts", "c.ts"],
					}),
				],
				medium: [],
			};
			const result = buildContext([], [], tiered);
			expect(result).toContain("## Project-wide decisions");
			expect(result).toContain("ThreeFileDec");
			expect(result).not.toContain("## Decisions");
		});

		it("omits Project-wide decisions header when no decisions have 3+ files", () => {
			const tiered: TieredResults = {
				high: [
					makeResult(0.9, {
						name: "D1",
						nodeType: "decision",
						affectedFiles: ["a.ts"],
					}),
					makeResult(0.8, {
						name: "D2",
						nodeType: "decision",
						affectedFiles: ["a.ts", "b.ts"],
					}),
				],
				medium: [],
			};
			const result = buildContext([], [], tiered);
			expect(result).not.toContain("## Project-wide decisions");
			expect(result).toContain("## Decisions");
		});
	});
});
