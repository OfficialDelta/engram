import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngramEvent, WindowSummary } from "../types.js";

const { mockExecFileAsync } = vi.hoisted(() => ({
	mockExecFileAsync:
		vi.fn<
			(
				cmd: string,
				args: string[],
			) => Promise<{ stdout: string; stderr: string }>
		>(),
}));

vi.mock("node:child_process", () => {
	const fn = Object.assign(vi.fn(), {
		[Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
	});
	return { execFile: fn };
});

vi.mock("../core/consolidation.js", () => ({
	spawnConsolidation: vi.fn(),
	readConsolidationTimestamp: vi.fn(() => null),
}));

vi.mock("../core/config.js", () => ({
	loadConfig: vi.fn(() => ({
		llm: {},
		embedding: {},
		consolidation: {},
	})),
}));

vi.mock("../core/event-stream.js", () => ({
	getSessionEvents: vi.fn(() => []),
}));

vi.mock("../core/session-state.js", () => ({
	loadSessionState: vi.fn(() => ({
		seenFiles: [],
		contradictionFailures: 0,
		contradictionDisabled: false,
		pendingContradictions: [],
		turnCount: 0,
		toolCallCount: 0,
	})),
	saveSessionState: vi.fn(),
}));

// ── mapModelToCli ──────────────────────────────────────────────

describe("mapModelToCli", () => {
	let mapModelToCli: typeof import("../core/cli-consolidation.js").mapModelToCli;

	beforeEach(async () => {
		const mod = await import("../core/cli-consolidation.js");
		mapModelToCli = mod.mapModelToCli;
	});

	it("maps 'claude-sonnet-4-6' to 'sonnet'", () => {
		expect(mapModelToCli("claude-sonnet-4-6")).toBe("sonnet");
	});

	it("maps 'claude-opus-4-6' to 'opus'", () => {
		expect(mapModelToCli("claude-opus-4-6")).toBe("opus");
	});

	it("maps 'claude-haiku-4-5' to 'haiku'", () => {
		expect(mapModelToCli("claude-haiku-4-5")).toBe("haiku");
	});

	it("passes through unknown model names unchanged", () => {
		expect(mapModelToCli("custom-model")).toBe("custom-model");
	});
});

// ── parseCliResponse ───────────────────────────────────────────

describe("parseCliResponse", () => {
	let parseCliResponse: typeof import("../core/cli-consolidation.js").parseCliResponse;

	beforeEach(async () => {
		const mod = await import("../core/cli-consolidation.js");
		parseCliResponse = mod.parseCliResponse;
	});

	it("parses valid JSON envelope and returns result", () => {
		expect(parseCliResponse('{"type":"result","result":"hello"}')).toBe(
			"hello",
		);
	});

	it("handles nested JSON in result field", () => {
		expect(
			parseCliResponse('{"type":"result","result":"{\\"key\\":\\"value\\"}"}'),
		).toBe('{"key":"value"}');
	});

	it("returns raw text on malformed JSON", () => {
		expect(parseCliResponse("not json")).toBe("not json");
	});

	it("returns trimmed raw text when result field is missing", () => {
		expect(parseCliResponse('{"type":"result"}')).toBe('{"type":"result"}');
	});
});

// ── invokeClaude ───────────────────────────────────────────────

describe("invokeClaude", () => {
	let invokeClaude: typeof import("../core/cli-consolidation.js").invokeClaude;

	beforeEach(async () => {
		vi.clearAllMocks();
		const mod = await import("../core/cli-consolidation.js");
		invokeClaude = mod.invokeClaude;
	});

	it("calls claude with correct flags in exact order", async () => {
		mockExecFileAsync.mockResolvedValueOnce({
			stdout: '{"type":"result","result":"ok"}',
			stderr: "",
		});

		await invokeClaude("test prompt", "claude-sonnet-4-6");

		expect(mockExecFileAsync).toHaveBeenCalledWith("claude", [
			"-p",
			"test prompt",
			"--model",
			"sonnet",
			"--bare",
			"--output-format",
			"json",
		]);
	});

	it("passes prompt as -p argument value", async () => {
		mockExecFileAsync.mockResolvedValueOnce({
			stdout: '{"type":"result","result":"ok"}',
			stderr: "",
		});

		await invokeClaude("my special prompt", "claude-sonnet-4-6");

		const args = mockExecFileAsync.mock.calls[0]![1];
		expect(args[0]).toBe("-p");
		expect(args[1]).toBe("my special prompt");
	});

	it("maps model name via mapModelToCli before passing to --model", async () => {
		mockExecFileAsync.mockResolvedValueOnce({
			stdout: '{"type":"result","result":"ok"}',
			stderr: "",
		});

		await invokeClaude("prompt", "claude-opus-4-6");

		const args = mockExecFileAsync.mock.calls[0]![1];
		expect(args[2]).toBe("--model");
		expect(args[3]).toBe("opus");
	});

	it("throws on non-zero exit code with stderr in error message", async () => {
		mockExecFileAsync.mockRejectedValueOnce({
			code: 1,
			stderr: "something went wrong",
		});

		await expect(invokeClaude("prompt", "claude-sonnet-4-6")).rejects.toThrow(
			/Claude CLI failed.*something went wrong/,
		);
	});

	it("throws helpful message on ENOENT (claude not found)", async () => {
		mockExecFileAsync.mockRejectedValueOnce({ code: "ENOENT" });

		await expect(invokeClaude("prompt", "claude-sonnet-4-6")).rejects.toThrow(
			/Claude CLI not found in PATH/,
		);
	});
});

// ── cliPass1Summarize ──────────────────────────────────────────

describe("cliPass1Summarize", () => {
	let cliPass1Summarize: typeof import("../core/cli-consolidation.js").cliPass1Summarize;

	beforeEach(async () => {
		vi.clearAllMocks();
		const mod = await import("../core/cli-consolidation.js");
		cliPass1Summarize = mod.cliPass1Summarize;
	});

	function cliEnvelope(inner: string): string {
		return `{"type":"result","result":${JSON.stringify(inner)}}`;
	}

	it("produces WindowSummary array from JSON response", async () => {
		const json = JSON.stringify({
			summary: "Agent modified files",
			filesModified: ["/src/a.ts"],
			decisionsIdentified: ["Used X"],
			outcome: "progress",
		});
		mockExecFileAsync.mockResolvedValueOnce({
			stdout: cliEnvelope(json),
			stderr: "",
		});

		const events: EngramEvent[] = [
			{
				type: "file_read",
				sessionId: "s1",
				timestamp: "2026-01-01T00:00:00Z",
				filePath: "/src/a.ts",
			},
		];
		const result = await cliPass1Summarize([[...events]], "claude-sonnet-4-6");

		expect(result).toHaveLength(1);
		expect(result[0]!.summary).toBe("Agent modified files");
		expect(result[0]!.filesModified).toEqual(["/src/a.ts"]);
		expect(result[0]!.decisionsIdentified).toEqual(["Used X"]);
		expect(result[0]!.outcome).toBe("progress");
	});

	it("handles JSON parse failure gracefully (raw text as summary)", async () => {
		mockExecFileAsync.mockResolvedValueOnce({
			stdout: "not json at all",
			stderr: "",
		});

		const events: EngramEvent[] = [
			{
				type: "file_read",
				sessionId: "s1",
				timestamp: "2026-01-01T00:00:00Z",
				filePath: "/src/a.ts",
			},
		];
		const result = await cliPass1Summarize([[...events]], "claude-sonnet-4-6");

		expect(result).toHaveLength(1);
		expect(result[0]!.summary).toBe("not json at all");
		expect(result[0]!.filesModified).toEqual([]);
	});

	it("processes windows sequentially (invokeClaude called N times for N windows)", async () => {
		const json = JSON.stringify({
			summary: "s",
			filesModified: [],
			decisionsIdentified: [],
			outcome: "progress",
		});
		mockExecFileAsync.mockResolvedValue({
			stdout: cliEnvelope(json),
			stderr: "",
		});

		const events: EngramEvent[] = [
			{
				type: "file_read",
				sessionId: "s1",
				timestamp: "2026-01-01T00:00:00Z",
				filePath: "/src/a.ts",
			},
		];
		await cliPass1Summarize(
			[[...events], [...events], [...events]],
			"claude-sonnet-4-6",
		);

		expect(mockExecFileAsync).toHaveBeenCalledTimes(3);
	});
});

// ── cliPass2Extract ────────────────────────────────────────────

describe("cliPass2Extract", () => {
	let cliPass2Extract: typeof import("../core/cli-consolidation.js").cliPass2Extract;

	beforeEach(async () => {
		vi.clearAllMocks();
		const mod = await import("../core/cli-consolidation.js");
		cliPass2Extract = mod.cliPass2Extract;
	});

	const sampleSummaries: WindowSummary[] = [
		{
			windowIndex: 0,
			eventRange: { start: 0, end: 1 },
			summary: "Agent worked",
			filesModified: ["/src/a.ts"],
			decisionsIdentified: [],
			outcome: "progress",
		},
	];

	it("produces episode + changes from JSON response", async () => {
		const pass2 = {
			episode: {
				goal: "Implement feature",
				approach: "Read and write files",
				outcome: "success",
				discoveries: [],
				decisions: [],
				errors: [],
			},
			changes: {
				nodesToCreate: [
					{
						name: "Feature",
						nodeType: "concept",
						description: "desc",
						affectedFiles: [],
						causallyImportant: true,
					},
				],
				nodesToUpdate: [],
				edgesToCreate: [],
			},
		};
		mockExecFileAsync.mockResolvedValueOnce({
			stdout: `{"type":"result","result":${JSON.stringify(JSON.stringify(pass2))}}`,
			stderr: "",
		});

		const result = await cliPass2Extract(sampleSummaries, "claude-opus-4-6");

		expect(result.episode.goal).toBe("Implement feature");
		expect(result.episode.outcome).toBe("success");
		expect(result.changes.nodesToCreate).toHaveLength(1);
		expect(result.changes.nodesToCreate[0]!.name).toBe("Feature");
	});

	it("filters nodesToCreate through VALID_NODE_TYPES", async () => {
		const pass2 = {
			episode: {
				goal: "G",
				approach: "A",
				outcome: "success",
				discoveries: [],
				decisions: [],
				errors: [],
			},
			changes: {
				nodesToCreate: [
					{
						name: "Valid",
						nodeType: "concept",
						description: "d",
						affectedFiles: [],
						causallyImportant: false,
					},
					{
						name: "Invalid",
						nodeType: "unknown_type",
						description: "d",
						affectedFiles: [],
						causallyImportant: false,
					},
				],
				nodesToUpdate: [],
				edgesToCreate: [],
			},
		};
		mockExecFileAsync.mockResolvedValueOnce({
			stdout: `{"type":"result","result":${JSON.stringify(JSON.stringify(pass2))}}`,
			stderr: "",
		});

		const result = await cliPass2Extract(sampleSummaries, "claude-opus-4-6");

		expect(result.changes.nodesToCreate).toHaveLength(1);
		expect(result.changes.nodesToCreate[0]!.name).toBe("Valid");
	});

	it("throws on JSON parse failure (no graceful degradation for Pass 2)", async () => {
		mockExecFileAsync.mockResolvedValueOnce({
			stdout: "not valid json",
			stderr: "",
		});

		await expect(
			cliPass2Extract(sampleSummaries, "claude-opus-4-6"),
		).rejects.toThrow();
	});
});

// ── cliDiscussionConsolidate ───────────────────────────────────

describe("cliDiscussionConsolidate", () => {
	let cliDiscussionConsolidate: typeof import("../core/cli-consolidation.js").cliDiscussionConsolidate;

	beforeEach(async () => {
		vi.clearAllMocks();
		const mod = await import("../core/cli-consolidation.js");
		cliDiscussionConsolidate = mod.cliDiscussionConsolidate;
	});

	it("produces topics/decisions/constraints from JSON response", async () => {
		const disc = {
			topics: ["testing", "deployment"],
			decisions: ["use vitest"],
			constraints: ["must run in CI"],
		};
		mockExecFileAsync.mockResolvedValueOnce({
			stdout: `{"type":"result","result":${JSON.stringify(JSON.stringify(disc))}}`,
			stderr: "",
		});

		const events: EngramEvent[] = [
			{
				type: "turn_complete",
				sessionId: "s1",
				timestamp: "2026-01-01T00:00:00Z",
				toolCallCount: 0,
				turnNumber: 1,
				userMessage: "hello",
				agentSummary: "hi",
			},
		];

		const result = await cliDiscussionConsolidate(events, "claude-haiku-4-5");

		expect(result.topics).toEqual(["testing", "deployment"]);
		expect(result.decisions).toEqual(["use vitest"]);
		expect(result.constraints).toEqual(["must run in CI"]);
	});

	it("returns empty arrays on error (error-swallowing per P004)", async () => {
		mockExecFileAsync.mockRejectedValueOnce(new Error("network error"));

		const events: EngramEvent[] = [
			{
				type: "turn_complete",
				sessionId: "s1",
				timestamp: "2026-01-01T00:00:00Z",
				toolCallCount: 0,
				turnNumber: 1,
			},
		];

		const result = await cliDiscussionConsolidate(events, "claude-haiku-4-5");

		expect(result).toEqual({ topics: [], decisions: [], constraints: [] });
	});
});

// ── hook gating with CLI provider ──────────────────────────────

describe("hook gating with CLI provider", () => {
	const originalEnv = process.env.ANTHROPIC_API_KEY;

	beforeEach(() => {
		delete process.env.ANTHROPIC_API_KEY;
		vi.clearAllMocks();
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.ANTHROPIC_API_KEY = originalEnv;
		} else {
			delete process.env.ANTHROPIC_API_KEY;
		}
	});

	it("PostCompact with CLI provider and no API key: should NOT skip consolidation", async () => {
		const { loadConfig } = await import("../core/config.js");
		vi.mocked(loadConfig).mockReturnValue({
			llm: {},
			embedding: {},
			consolidation: { provider: "claude-cli" },
		});

		const { spawnConsolidation } = await import("../core/consolidation.js");
		const { processPostCompact } = await import(
			"../adapters/claude-code/post-compact.js"
		);

		processPostCompact("sess-1", "/tmp/test", "/tmp/test/engram.db");

		expect(spawnConsolidation).toHaveBeenCalled();
	});

	it("SessionEnd with CLI provider and no API key: should NOT skip consolidation", async () => {
		const { loadConfig } = await import("../core/config.js");
		vi.mocked(loadConfig).mockReturnValue({
			llm: {},
			embedding: {},
			consolidation: { provider: "claude-cli" },
		});

		const { getSessionEvents } = await import("../core/event-stream.js");
		vi.mocked(getSessionEvents).mockReturnValue([
			{
				type: "file_read",
				timestamp: "2026-01-02T00:00:00Z",
				sessionId: "sess-1",
				filePath: "/f",
			},
		]);

		const { spawnConsolidation } = await import("../core/consolidation.js");
		const { processSessionEnd } = await import(
			"../adapters/claude-code/session-end.js"
		);

		processSessionEnd("sess-1", "/tmp/test", "/tmp/test/engram.db");

		expect(spawnConsolidation).toHaveBeenCalled();
	});

	it("PostCompact with API provider and no API key: should skip", async () => {
		const { loadConfig } = await import("../core/config.js");
		vi.mocked(loadConfig).mockReturnValue({
			llm: {},
			embedding: {},
			consolidation: { provider: "api" },
		});

		const { spawnConsolidation } = await import("../core/consolidation.js");
		const { processPostCompact } = await import(
			"../adapters/claude-code/post-compact.js"
		);

		processPostCompact("sess-1", "/tmp/test", "/tmp/test/engram.db");

		expect(spawnConsolidation).not.toHaveBeenCalled();
	});
});

// ── config validation ──────────────────────────────────────────

describe("config validation", () => {
	let validateConfig: typeof import("../core/config.js").validateConfig;

	beforeEach(async () => {
		const mod =
			await vi.importActual<typeof import("../core/config.js")>(
				"../core/config.js",
			);
		validateConfig = mod.validateConfig;
	});

	it("accepts provider: 'api'", () => {
		const result = validateConfig({ consolidation: { provider: "api" } });
		expect(result.valid).toBe(true);
	});

	it("accepts provider: 'claude-cli'", () => {
		const result = validateConfig({
			consolidation: { provider: "claude-cli" },
		});
		expect(result.valid).toBe(true);
	});

	it("accepts no provider (undefined)", () => {
		const result = validateConfig({ consolidation: {} });
		expect(result.valid).toBe(true);
	});

	it("rejects provider: 'invalid'", () => {
		const result = validateConfig({ consolidation: { provider: "invalid" } });
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatch(/consolidation\.provider/);
	});

	it("rejects provider: 'openai'", () => {
		const result = validateConfig({ consolidation: { provider: "openai" } });
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatch(/consolidation\.provider/);
	});
});
