import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/event-stream.js", () => ({
	classifyToolCall: vi.fn(),
	appendEvent: vi.fn(),
	detectDerivedEvents: vi.fn(() => []),
	getSessionEvents: vi.fn(() => []),
	buildTurnCompleteEvent: vi.fn(() => ({
		type: "turn_complete",
		sessionId: "test",
		timestamp: new Date().toISOString(),
		toolCallCount: 0,
		turnNumber: 1,
	})),
}));

vi.mock("../core/involuntary.js", () => ({
	getFileAnnotations: vi.fn(() => []),
}));

vi.mock("../core/retrieval.js", () => ({
	spreadingActivation: vi.fn(() => ({ high: [], medium: [] })),
}));

vi.mock("../core/consolidation.js", () => ({
	findUnconsolidatedSessions: vi.fn(() => []),
	spawnConsolidation: vi.fn(),
}));

vi.mock("../db/migrations.js", () => ({
	initializeSchema: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock("../core/maintenance.js", () => ({
	runMaintenance: vi.fn(() => ({
		nodesPruned: 0,
		patternsCreated: 0,
		filesSuperseded: 0,
		durationMs: 5,
		skipped: true,
	})),
}));

vi.mock("../core/config.js", () => ({
	loadConfig: vi.fn(() => ({
		llm: {
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			apiKey: "",
		},
		embedding: { provider: "local", model: "all-MiniLM-L6-v2" },
		consolidation: { turnThreshold: 5, eventThreshold: 50 },
	})),
	getMaintenanceConfig: vi.fn(() => ({
		decayThreshold: 0.01,
		decayFactor: 0.9,
	})),
}));

import { processPostToolUse } from "../adapters/claude-code/post-tool-use.js";
import { processSessionStart } from "../adapters/claude-code/session-start.js";
import { processStop } from "../adapters/claude-code/stop.js";
import { extractEntryPoints } from "../adapters/claude-code/user-prompt-submit.js";
import {
	findUnconsolidatedSessions,
	spawnConsolidation,
} from "../core/consolidation.js";
import { buildContext } from "../core/context-builder.js";
import {
	appendEvent,
	buildTurnCompleteEvent,
	classifyToolCall,
	getSessionEvents,
} from "../core/event-stream.js";
import { getFileAnnotations } from "../core/involuntary.js";
import { runMaintenance } from "../core/maintenance.js";
import { ensureDataDirs, getProjectHash } from "../core/project-identity.js";
import {
	loadSessionState,
	type SessionState,
	saveSessionState,
} from "../core/session-state.js";
import type {
	Annotation,
	ContradictionResult,
	FileReadEvent,
	FileWriteEvent,
	GraphNode,
	NodeResult,
	TieredResults,
} from "../types.js";

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "engram-test-"));
}

function makeSessionDir(dir: string): void {
	fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
}

function makeEventsDir(dir: string): void {
	fs.mkdirSync(path.join(dir, "events"), { recursive: true });
}

function defaultState(): SessionState {
	return {
		seenFiles: [],
		contradictionFailures: 0,
		contradictionDisabled: false,
		pendingContradictions: [],
		turnCount: 0,
		toolCallCount: 0,
	};
}

// ── project-identity ────────────────────────────────────────────

describe("project-identity", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("getProjectHash returns 16-char hex string", () => {
		const hash = getProjectHash(process.cwd());
		expect(hash).toMatch(/^[0-9a-f]{16}$/);
	});

	it("getProjectHash returns consistent hash for same path", () => {
		expect(getProjectHash(process.cwd())).toBe(getProjectHash(process.cwd()));
	});

	it("getProjectHash falls back to cwd hash for non-git directory", () => {
		const hash = getProjectHash(tmpDir);
		expect(hash).toMatch(/^[0-9a-f]{16}$/);
	});

	it("ensureDataDirs creates all required subdirectories", () => {
		const dataDir = ensureDataDirs(tmpDir);
		try {
			for (const sub of ["events", "sessions", "episodes", "logs"]) {
				expect(fs.existsSync(path.join(dataDir, sub))).toBe(true);
			}
		} finally {
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("ensureDataDirs creates metrics directory", () => {
		const dataDir = ensureDataDirs(tmpDir);
		try {
			expect(fs.existsSync(path.join(dataDir, "metrics"))).toBe(true);
		} finally {
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});
});

// ── session-state ───────────────────────────────────────────────

describe("session-state", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		makeSessionDir(tmpDir);
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("loadSessionState returns defaults for missing file", () => {
		const state = loadSessionState(tmpDir, "nonexistent");
		expect(state).toEqual(defaultState());
	});

	it("loadSessionState returns defaults for corrupt JSON", () => {
		const filePath = path.join(tmpDir, "sessions", "corrupt.json");
		fs.writeFileSync(filePath, "{{{not json");
		const state = loadSessionState(tmpDir, "corrupt");
		expect(state).toEqual(defaultState());
	});

	it("saveSessionState + loadSessionState round-trip", () => {
		const original: SessionState = {
			seenFiles: ["/a.ts", "/b.ts"],
			contradictionFailures: 2,
			contradictionDisabled: true,
			pendingContradictions: [
				{
					verdict: "DIRECT_CONTRADICTION",
					severity: "high",
					explanation: "test",
					recommendation: "fix",
				},
			],
			turnCount: 5,
			toolCallCount: 12,
		};
		saveSessionState(tmpDir, "roundtrip", original);
		const loaded = loadSessionState(tmpDir, "roundtrip");
		expect(loaded).toEqual(original);
	});

	it("saveSessionState creates sessions directory if missing", () => {
		const freshDir = makeTmpDir();
		try {
			saveSessionState(freshDir, "auto-create", defaultState());
			const state = loadSessionState(freshDir, "auto-create");
			expect(state).toEqual(defaultState());
		} finally {
			fs.rmSync(freshDir, { recursive: true, force: true });
		}
	});
});

// ── context-builder ─────────────────────────────────────────────

describe("context-builder", () => {
	const makeContradiction = (
		overrides?: Partial<ContradictionResult>,
	): ContradictionResult => ({
		verdict: "DIRECT_CONTRADICTION",
		severity: "high",
		explanation: "Test contradiction",
		recommendation: "Fix it",
		...overrides,
	});

	const makeAnnotation = (name: string, desc: string): Annotation => ({
		nodeId: "n1",
		name,
		description: desc,
		strength: 0.9,
	});

	const makeNode = (name: string, desc: string): GraphNode => ({
		id: "n1",
		name,
		nodeType: "concept",
		description: desc,
		affectedFiles: [],
		strength: 1.0,
		metadata: {},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});

	const makeNodeResult = (
		name: string,
		desc: string,
		activation: number,
	): NodeResult => ({
		node: makeNode(name, desc),
		activation,
	});

	const emptyTiered: TieredResults = { high: [], medium: [] };

	it("returns empty string with empty inputs", () => {
		expect(buildContext([], [], emptyTiered)).toBe("");
	});

	it("formats contradictions with warning prefix", () => {
		const result = buildContext([makeContradiction()], [], emptyTiered);
		expect(result).toContain("⚠️ CONTRADICTION");
		expect(result).toContain("high");
		expect(result).toContain("Test contradiction");
		expect(result).toContain("Fix it");
	});

	it("formats annotations with knowledge prefix", () => {
		const result = buildContext(
			[],
			[makeAnnotation("Auth", "Authentication module")],
			emptyTiered,
		);
		expect(result).toContain("📎 Related knowledge");
		expect(result).toContain("Auth: Authentication module");
	});

	it("respects D006 priority ordering", () => {
		const tiered: TieredResults = {
			high: [makeNodeResult("HighNode", "high desc", 0.9)],
			medium: [makeNodeResult("MedNode", "med desc", 0.5)],
		};
		const result = buildContext(
			[makeContradiction()],
			[makeAnnotation("Auth", "desc")],
			tiered,
		);

		const positions = [
			result.indexOf("CONTRADICTION"),
			result.indexOf("Related knowledge"),
			result.indexOf("HighNode"),
			result.indexOf("MedNode"),
		];
		for (let i = 0; i < positions.length - 1; i++) {
			expect(positions[i]).toBeLessThan(positions[i + 1]!);
		}
	});

	it("truncates activation results with small budget but preserves contradictions and annotations", () => {
		const contradiction = makeContradiction();
		const annotation = makeAnnotation("Auth", "desc");
		const tiered: TieredResults = {
			high: [makeNodeResult("VeryLongNodeName", "x".repeat(200), 0.9)],
			medium: [],
		};

		const baseResult = buildContext([contradiction], [annotation], emptyTiered);
		const tightBudget = baseResult.length + 10;

		const result = buildContext(
			[contradiction],
			[annotation],
			tiered,
			tightBudget,
		);
		expect(result).toContain("CONTRADICTION");
		expect(result).toContain("Related knowledge");
	});

	it("returns empty string with budget=0", () => {
		expect(
			buildContext(
				[makeContradiction()],
				[makeAnnotation("A", "b")],
				{ high: [makeNodeResult("N", "d", 0.9)], medium: [] },
				0,
			),
		).toBe("");
	});
});

// ── PostToolUse handler ─────────────────────────────────────────

describe("PostToolUse handler", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTmpDir();
		makeSessionDir(dir);
		vi.clearAllMocks();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("file_read event adds to seenFiles and returns annotations", () => {
		const event: FileReadEvent = {
			type: "file_read",
			filePath: "/src/foo.ts",
			sessionId: "sess-1",
			timestamp: new Date().toISOString(),
		};
		vi.mocked(classifyToolCall).mockReturnValueOnce(event);
		vi.mocked(getFileAnnotations).mockReturnValueOnce([
			{
				nodeId: "n1",
				name: "AuthModule",
				description: "Auth logic",
				strength: 0.9,
			},
		]);

		saveSessionState(dir, "sess-1", defaultState());

		const result = processPostToolUse(
			{
				tool_name: "Read",
				tool_input: { file_path: "/src/foo.ts" },
				session_id: "sess-1",
			},
			dir,
			path.join(dir, "engram.db"),
		);

		const state = loadSessionState(dir, "sess-1");
		expect(state.seenFiles).toContain("/src/foo.ts");
		expect(state.toolCallCount).toBe(1);

		const output = result as {
			hookSpecificOutput: { additionalContext: string };
		};
		expect(output.hookSpecificOutput.additionalContext).toContain("AuthModule");
	});

	it("file_write event triggers contradiction worker spawn", () => {
		const event: FileWriteEvent = {
			type: "file_write",
			filePath: "/src/bar.ts",
			linesChanged: 5,
			evidenceSnippet: "new code",
			sessionId: "sess-1",
			timestamp: new Date().toISOString(),
		};
		vi.mocked(classifyToolCall).mockReturnValueOnce(event);
		saveSessionState(dir, "sess-1", defaultState());

		const mockSpawn = vi.fn();
		processPostToolUse(
			{ tool_name: "Write", tool_input: {}, session_id: "sess-1" },
			dir,
			path.join(dir, "engram.db"),
			{ spawnCheck: mockSpawn },
		);

		expect(mockSpawn).toHaveBeenCalledWith(
			"sess-1",
			path.join(dir, "engram.db"),
			dir,
			"/src/bar.ts",
			"new code",
		);
	});

	it("pending contradictions consumed and cleared from state", () => {
		const event: FileReadEvent = {
			type: "file_read",
			filePath: "/src/foo.ts",
			sessionId: "sess-1",
			timestamp: new Date().toISOString(),
		};
		vi.mocked(classifyToolCall).mockReturnValueOnce(event);

		saveSessionState(dir, "sess-1", {
			...defaultState(),
			seenFiles: ["/src/foo.ts"],
			pendingContradictions: [
				{
					verdict: "DIRECT_CONTRADICTION",
					severity: "high",
					explanation: "Stale pattern",
					recommendation: "Update",
				},
			],
		});

		const result = processPostToolUse(
			{ tool_name: "Read", tool_input: {}, session_id: "sess-1" },
			dir,
			path.join(dir, "engram.db"),
		);

		const output = result as {
			hookSpecificOutput: { additionalContext: string };
		};
		expect(output.hookSpecificOutput.additionalContext).toContain(
			"CONTRADICTION",
		);
		expect(output.hookSpecificOutput.additionalContext).toContain(
			"Stale pattern",
		);

		const state = loadSessionState(dir, "sess-1");
		expect(state.pendingContradictions).toEqual([]);
	});

	it("logs metrics on 10th tool call", () => {
		const event: FileReadEvent = {
			type: "file_read",
			filePath: "/src/foo.ts",
			sessionId: "sess-metrics",
			timestamp: new Date().toISOString(),
		};
		vi.mocked(classifyToolCall).mockReturnValueOnce(event);
		vi.mocked(getSessionEvents).mockReturnValueOnce([
			{
				type: "file_read",
				filePath: "/src/a.ts",
				sessionId: "sess-metrics",
				timestamp: new Date().toISOString(),
			},
			{
				type: "file_write",
				filePath: "/src/b.ts",
				sessionId: "sess-metrics",
				timestamp: new Date().toISOString(),
				linesChanged: 5,
				evidenceSnippet: "",
			},
		] as any);

		saveSessionState(dir, "sess-metrics", {
			...defaultState(),
			toolCallCount: 9,
		});
		fs.mkdirSync(path.join(dir, "metrics"), { recursive: true });

		processPostToolUse(
			{
				tool_name: "Read",
				tool_input: { file_path: "/src/foo.ts" },
				session_id: "sess-metrics",
			},
			dir,
			path.join(dir, "engram.db"),
		);

		const metricsFile = path.join(dir, "metrics", "sess-metrics.metrics.jsonl");
		expect(fs.existsSync(metricsFile)).toBe(true);
		const line = fs.readFileSync(metricsFile, "utf-8").trim();
		const parsed = JSON.parse(line);
		expect(parsed.sessionId).toBe("sess-metrics");
		expect(parsed).toHaveProperty("progressVelocity");
		expect(parsed).toHaveProperty("searchToActRatio");
		expect(parsed).toHaveProperty("errorRepetition");
	});

	it("does not log metrics before 10th tool call", () => {
		const event: FileReadEvent = {
			type: "file_read",
			filePath: "/src/foo.ts",
			sessionId: "sess-early",
			timestamp: new Date().toISOString(),
		};
		vi.mocked(classifyToolCall).mockReturnValueOnce(event);

		saveSessionState(dir, "sess-early", {
			...defaultState(),
			toolCallCount: 7,
		});

		processPostToolUse(
			{
				tool_name: "Read",
				tool_input: { file_path: "/src/foo.ts" },
				session_id: "sess-early",
			},
			dir,
			path.join(dir, "engram.db"),
		);

		const metricsFile = path.join(dir, "metrics", "sess-early.metrics.jsonl");
		expect(fs.existsSync(metricsFile)).toBe(false);
	});

	it("metrics logging failure does not crash hook", () => {
		const event: FileReadEvent = {
			type: "file_read",
			filePath: "/src/foo.ts",
			sessionId: "sess-fail",
			timestamp: new Date().toISOString(),
		};
		vi.mocked(classifyToolCall).mockReturnValueOnce(event);
		vi.mocked(getSessionEvents).mockReturnValueOnce([]);

		saveSessionState(dir, "sess-fail", { ...defaultState(), toolCallCount: 9 });

		const origAppend = fs.appendFileSync;
		vi.spyOn(fs, "appendFileSync").mockImplementation((...args: any[]) => {
			const filePath = String(args[0]);
			if (filePath.includes(".metrics.jsonl")) {
				throw new Error("disk full");
			}
			return origAppend.apply(fs, args as any);
		});

		try {
			expect(() =>
				processPostToolUse(
					{
						tool_name: "Read",
						tool_input: { file_path: "/src/foo.ts" },
						session_id: "sess-fail",
					},
					dir,
					path.join(dir, "engram.db"),
				),
			).not.toThrow();
		} finally {
			vi.mocked(fs.appendFileSync).mockRestore();
		}
	});
});

// ── SessionStart handler ────────────────────────────────────────

describe("SessionStart handler", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTmpDir();
		makeSessionDir(dir);
		makeEventsDir(dir);
		vi.clearAllMocks();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("initializes session state with defaults", () => {
		processSessionStart("sess-new", dir, path.join(dir, "engram.db"));
		expect(loadSessionState(dir, "sess-new")).toEqual(defaultState());
	});

	it("calls findUnconsolidatedSessions and spawns consolidation", () => {
		vi.mocked(findUnconsolidatedSessions).mockReturnValueOnce([
			"old-1",
			"old-2",
		]);

		const dbPath = path.join(dir, "engram.db");
		processSessionStart("sess-new", dir, dbPath);

		expect(findUnconsolidatedSessions).toHaveBeenCalledWith(dir);
		expect(spawnConsolidation).toHaveBeenCalledTimes(2);
		expect(spawnConsolidation).toHaveBeenCalledWith("old-1", dbPath, dir);
		expect(spawnConsolidation).toHaveBeenCalledWith("old-2", dbPath, dir);
	});

	it("calls runMaintenance and surfaces summary when not skipped", () => {
		vi.mocked(runMaintenance).mockReturnValueOnce({
			nodesPruned: 3,
			patternsCreated: 0,
			filesSuperseded: 0,
			durationMs: 42,
			skipped: false,
		});

		const result = processSessionStart(
			"sess-maint",
			dir,
			path.join(dir, "engram.db"),
		);
		expect(runMaintenance).toHaveBeenCalled();
		const output = result as {
			hookSpecificOutput: { additionalContext: string };
		};
		expect(output.hookSpecificOutput.additionalContext).toContain(
			"[engram] Maintenance: pruned 3 stale nodes",
		);
		expect(output.hookSpecificOutput.additionalContext).toContain("42ms");
	});

	it("does not surface maintenance summary when skipped", () => {
		vi.mocked(runMaintenance).mockReturnValueOnce({
			nodesPruned: 0,
			patternsCreated: 0,
			filesSuperseded: 0,
			durationMs: 1,
			skipped: true,
		});

		const result = processSessionStart(
			"sess-skip",
			dir,
			path.join(dir, "engram.db"),
		);
		expect(result).toEqual({});
	});

	it("session start still works when runMaintenance throws", () => {
		vi.mocked(runMaintenance).mockImplementationOnce(() => {
			throw new Error("boom");
		});

		const result = processSessionStart(
			"sess-err",
			dir,
			path.join(dir, "engram.db"),
		);
		expect(result).toBeDefined();
	});
});

// ── UserPromptSubmit handler ────────────────────────────────────

describe("UserPromptSubmit handler", () => {
	it("extracts file paths from prompt text", () => {
		const result = extractEntryPoints(
			"look at ./src/foo.ts and src/bar/baz.ts",
		);
		expect(
			result.some((e) => e.type === "file" && e.value === "./src/foo.ts"),
		).toBe(true);
		expect(
			result.some((e) => e.type === "file" && e.value === "src/bar/baz.ts"),
		).toBe(true);
	});

	it("returns empty array when no entry points found", () => {
		expect(extractEntryPoints("just a simple question")).toEqual([]);
	});
});

// ── Stop handler ────────────────────────────────────────────────

describe("Stop handler", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTmpDir();
		makeSessionDir(dir);
		vi.clearAllMocks();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("increments turnCount and appends turn_complete event", () => {
		saveSessionState(dir, "sess-1", {
			...defaultState(),
			turnCount: 2,
			toolCallCount: 5,
		});

		processStop("sess-1", dir, path.join(dir, "engram.db"));

		const state = loadSessionState(dir, "sess-1");
		expect(state.turnCount).toBe(3);
		expect(state.toolCallCount).toBe(0);

		expect(buildTurnCompleteEvent).toHaveBeenCalledWith("sess-1", 5, 3, {});
		expect(appendEvent).toHaveBeenCalled();
	});

	it("does not call spawnConsolidation", () => {
		saveSessionState(dir, "sess-1", {
			...defaultState(),
			turnCount: 5,
			toolCallCount: 10,
		});

		processStop("sess-1", dir, path.join(dir, "engram.db"));

		expect(spawnConsolidation).not.toHaveBeenCalled();
	});
});
