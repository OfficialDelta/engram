import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/consolidation.js", () => ({
	spawnConsolidation: vi.fn(),
	readConsolidationTimestamp: vi.fn(() => null),
}));

vi.mock("../core/config.js", () => ({
	loadConfig: vi.fn(() => ({
		llm: {},
		embedding: {},
		consolidation: { turnThreshold: 5, eventThreshold: 50 },
	})),
}));

vi.mock("../core/event-stream.js", () => ({
	getSessionEvents: vi.fn(() => []),
	buildTurnCompleteEvent: vi.fn(),
	appendEvent: vi.fn(),
}));

vi.mock("../core/session-state.js", () => ({
	loadSessionState: vi.fn(() => ({ turnCount: 0, toolCallCount: 0 })),
	saveSessionState: vi.fn(),
}));

vi.mock("../db/migrations.js", () => ({
	initializeSchema: vi.fn(() => ({ close: vi.fn() })),
}));

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-hooks-"));
	fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
	fs.mkdirSync(path.join(tmpDir, "events"), { recursive: true });
	vi.clearAllMocks();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── processPostCompact ──────────────────────────────────────────

describe("processPostCompact", () => {
	const originalEnv = process.env.ANTHROPIC_API_KEY;

	beforeEach(() => {
		delete process.env.ANTHROPIC_API_KEY;
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.ANTHROPIC_API_KEY = originalEnv;
		} else {
			delete process.env.ANTHROPIC_API_KEY;
		}
	});

	it("calls spawnConsolidation when API key is present", async () => {
		const { loadConfig } = await import("../core/config.js");
		(loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
			llm: { apiKey: "sk-test" },
			embedding: {},
			consolidation: {},
		});

		const { spawnConsolidation } = await import("../core/consolidation.js");
		const { processPostCompact } = await import(
			"../adapters/claude-code/post-compact.js"
		);

		const result = processPostCompact(
			"sess-1",
			tmpDir,
			path.join(tmpDir, "engram.db"),
		);

		expect(spawnConsolidation).toHaveBeenCalledWith(
			"sess-1",
			path.join(tmpDir, "engram.db"),
			tmpDir,
		);
		expect(result).toEqual({});
	});

	it("skips consolidation when no API key and returns {}", async () => {
		const { loadConfig } = await import("../core/config.js");
		(loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
			llm: {},
			embedding: {},
			consolidation: {},
		});

		const { spawnConsolidation } = await import("../core/consolidation.js");
		const { processPostCompact } = await import(
			"../adapters/claude-code/post-compact.js"
		);

		const result = processPostCompact(
			"sess-1",
			tmpDir,
			path.join(tmpDir, "engram.db"),
		);

		expect(spawnConsolidation).not.toHaveBeenCalled();
		expect(result).toEqual({});
	});

	it("spawns consolidation when ANTHROPIC_API_KEY env var is set", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-env";

		const { loadConfig } = await import("../core/config.js");
		(loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
			llm: {},
			embedding: {},
			consolidation: {},
		});

		const { spawnConsolidation } = await import("../core/consolidation.js");
		const { processPostCompact } = await import(
			"../adapters/claude-code/post-compact.js"
		);

		const result = processPostCompact(
			"sess-1",
			tmpDir,
			path.join(tmpDir, "engram.db"),
		);

		expect(spawnConsolidation).toHaveBeenCalled();
		expect(result).toEqual({});
	});
});

// ── processSessionEnd ───────────────────────────────────────────

describe("processSessionEnd", () => {
	const originalEnv = process.env.ANTHROPIC_API_KEY;

	beforeEach(() => {
		delete process.env.ANTHROPIC_API_KEY;
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.ANTHROPIC_API_KEY = originalEnv;
		} else {
			delete process.env.ANTHROPIC_API_KEY;
		}
	});

	it("spawns consolidation when unconsolidated events exist after timestamp", async () => {
		const { loadConfig } = await import("../core/config.js");
		(loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
			llm: { apiKey: "sk-test" },
			embedding: {},
			consolidation: {},
		});

		const { getSessionEvents } = await import("../core/event-stream.js");
		(getSessionEvents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				type: "file_read",
				timestamp: "2026-01-01T00:00:00Z",
				sessionId: "sess-1",
			},
			{
				type: "file_read",
				timestamp: "2026-01-02T00:00:00Z",
				sessionId: "sess-1",
			},
		]);

		const { readConsolidationTimestamp } = await import(
			"../core/consolidation.js"
		);
		(readConsolidationTimestamp as ReturnType<typeof vi.fn>).mockReturnValue(
			"2026-01-01T00:00:00Z",
		);

		const { spawnConsolidation } = await import("../core/consolidation.js");
		const { processSessionEnd } = await import(
			"../adapters/claude-code/session-end.js"
		);

		processSessionEnd("sess-1", tmpDir, path.join(tmpDir, "engram.db"));

		expect(spawnConsolidation).toHaveBeenCalledWith(
			"sess-1",
			path.join(tmpDir, "engram.db"),
			tmpDir,
		);
	});

	it("skips consolidation when no events exist", async () => {
		const { loadConfig } = await import("../core/config.js");
		(loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
			llm: { apiKey: "sk-test" },
			embedding: {},
			consolidation: {},
		});

		const { getSessionEvents } = await import("../core/event-stream.js");
		(getSessionEvents as ReturnType<typeof vi.fn>).mockReturnValue([]);

		const { spawnConsolidation } = await import("../core/consolidation.js");
		const { processSessionEnd } = await import(
			"../adapters/claude-code/session-end.js"
		);

		processSessionEnd("sess-1", tmpDir, path.join(tmpDir, "engram.db"));

		expect(spawnConsolidation).not.toHaveBeenCalled();
	});

	it("skips consolidation when all events are before timestamp", async () => {
		const { loadConfig } = await import("../core/config.js");
		(loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
			llm: { apiKey: "sk-test" },
			embedding: {},
			consolidation: {},
		});

		const { getSessionEvents } = await import("../core/event-stream.js");
		(getSessionEvents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				type: "file_read",
				timestamp: "2026-01-01T00:00:00Z",
				sessionId: "sess-1",
			},
		]);

		const { readConsolidationTimestamp } = await import(
			"../core/consolidation.js"
		);
		(readConsolidationTimestamp as ReturnType<typeof vi.fn>).mockReturnValue(
			"2026-01-02T00:00:00Z",
		);

		const { spawnConsolidation } = await import("../core/consolidation.js");
		const { processSessionEnd } = await import(
			"../adapters/claude-code/session-end.js"
		);

		processSessionEnd("sess-1", tmpDir, path.join(tmpDir, "engram.db"));

		expect(spawnConsolidation).not.toHaveBeenCalled();
	});

	it("skips consolidation when no API key", async () => {
		const { loadConfig } = await import("../core/config.js");
		(loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
			llm: {},
			embedding: {},
			consolidation: {},
		});

		const { getSessionEvents } = await import("../core/event-stream.js");
		(getSessionEvents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				type: "file_read",
				timestamp: "2026-01-02T00:00:00Z",
				sessionId: "sess-1",
			},
		]);

		const { spawnConsolidation } = await import("../core/consolidation.js");
		const { processSessionEnd } = await import(
			"../adapters/claude-code/session-end.js"
		);

		processSessionEnd("sess-1", tmpDir, path.join(tmpDir, "engram.db"));

		expect(spawnConsolidation).not.toHaveBeenCalled();
	});

	it("consolidates all events when no prior timestamp exists", async () => {
		const { loadConfig } = await import("../core/config.js");
		(loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
			llm: { apiKey: "sk-test" },
			embedding: {},
			consolidation: {},
		});

		const { getSessionEvents } = await import("../core/event-stream.js");
		(getSessionEvents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				type: "file_read",
				timestamp: "2026-01-01T00:00:00Z",
				sessionId: "sess-1",
			},
		]);

		const { readConsolidationTimestamp } = await import(
			"../core/consolidation.js"
		);
		(readConsolidationTimestamp as ReturnType<typeof vi.fn>).mockReturnValue(
			null,
		);

		const { spawnConsolidation } = await import("../core/consolidation.js");
		const { processSessionEnd } = await import(
			"../adapters/claude-code/session-end.js"
		);

		processSessionEnd("sess-1", tmpDir, path.join(tmpDir, "engram.db"));

		expect(spawnConsolidation).toHaveBeenCalled();
	});
});

// ── readConsolidationTimestamp (real implementation) ─────────────

describe("readConsolidationTimestamp (real implementation)", () => {
	it("returns null when no marker file exists", async () => {
		const mod = await vi.importActual<
			typeof import("../core/consolidation.js")
		>("../core/consolidation.js");
		const result = mod.readConsolidationTimestamp(tmpDir, "nonexistent");
		expect(result).toBeNull();
	});

	it("returns timestamp when valid marker file exists", async () => {
		const mod = await vi.importActual<
			typeof import("../core/consolidation.js")
		>("../core/consolidation.js");
		const markerPath = path.join(
			tmpDir,
			"sessions",
			"sess-1.last-consolidated-at.json",
		);
		fs.writeFileSync(
			markerPath,
			JSON.stringify({ timestamp: "2026-01-15T12:00:00Z" }),
		);

		const result = mod.readConsolidationTimestamp(tmpDir, "sess-1");
		expect(result).toBe("2026-01-15T12:00:00Z");
	});

	it("returns null on malformed JSON", async () => {
		const mod = await vi.importActual<
			typeof import("../core/consolidation.js")
		>("../core/consolidation.js");
		const markerPath = path.join(
			tmpDir,
			"sessions",
			"sess-bad.last-consolidated-at.json",
		);
		fs.writeFileSync(markerPath, "{{{not valid json");

		const result = mod.readConsolidationTimestamp(tmpDir, "sess-bad");
		expect(result).toBeNull();
	});
});

// ── writeConsolidationTimestamp (real implementation) ────────────

describe("writeConsolidationTimestamp (real implementation)", () => {
	it("writes correct JSON to the right path", async () => {
		const mod = await vi.importActual<
			typeof import("../core/consolidation.js")
		>("../core/consolidation.js");
		mod.writeConsolidationTimestamp(tmpDir, "sess-1", "2026-02-01T10:30:00Z");

		const markerPath = path.join(
			tmpDir,
			"sessions",
			"sess-1.last-consolidated-at.json",
		);
		expect(fs.existsSync(markerPath)).toBe(true);

		const content = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as {
			timestamp: string;
		};
		expect(content.timestamp).toBe("2026-02-01T10:30:00Z");
	});

	it("creates sessions directory if missing", async () => {
		const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-write-"));
		try {
			const mod = await vi.importActual<
				typeof import("../core/consolidation.js")
			>("../core/consolidation.js");
			mod.writeConsolidationTimestamp(
				freshDir,
				"sess-1",
				"2026-03-01T00:00:00Z",
			);

			const markerPath = path.join(
				freshDir,
				"sessions",
				"sess-1.last-consolidated-at.json",
			);
			expect(fs.existsSync(markerPath)).toBe(true);
		} finally {
			fs.rmSync(freshDir, { recursive: true, force: true });
		}
	});
});

// ── HOOK_EVENTS count ───────────────────────────────────────────

describe("HOOK_EVENTS registration", () => {
	it("has exactly 6 hook events registered", async () => {
		const installSource = fs.readFileSync(
			path.resolve(import.meta.dirname ?? ".", "..", "cli", "install.ts"),
			"utf-8",
		);
		const hookBlock = installSource.match(
			/const HOOK_EVENTS\s*=\s*\{([\s\S]+?)\}\s*as\s+const/,
		);
		expect(hookBlock).not.toBeNull();

		const entries = hookBlock![1]!
			.split("\n")
			.filter((line) => line.includes("handler:"));
		expect(entries).toHaveLength(6);
	});
});
