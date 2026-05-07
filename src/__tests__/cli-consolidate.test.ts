import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/project-identity.js", () => ({
	getDataDir: vi.fn((cwd: string) => `${cwd}/.engram`),
	getDbPath: vi.fn((cwd: string) => `${cwd}/.engram/memory.db`),
}));

vi.mock("../core/consolidation.js", () => ({
	findUnconsolidatedSessions: vi.fn(() => []),
	findFailedConsolidations: vi.fn(() => []),
	consolidateSession: vi.fn(async () => {}),
	readConsolidationTimestamp: vi.fn(() => null),
	writeConsolidationTimestamp: vi.fn(),
}));

vi.mock("../core/config.js", () => ({
	loadConfig: vi.fn(() => ({
		llm: { apiKey: "sk-test-key" },
		embedding: {},
		consolidation: {},
	})),
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		existsSync: vi.fn(() => true),
		unlinkSync: vi.fn(),
	};
});

const { loadConfig } = await import("../core/config.js");
const {
	findUnconsolidatedSessions,
	findFailedConsolidations,
	consolidateSession,
	writeConsolidationTimestamp,
} = await import("../core/consolidation.js");
const { existsSync, unlinkSync } = await import("node:fs");

describe("runConsolidate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(loadConfig).mockReturnValue({
			llm: { apiKey: "sk-test-key" },
			embedding: {},
			consolidation: {},
		});
	});

	it("returns early with message when data directory missing", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const { runConsolidate } = await import("../cli/consolidate.js");
		const result = await runConsolidate({ cwd: "/tmp/fake" });

		expect(result).toEqual({ processed: 0, failed: 0, skipped: 0 });
		expect(logSpy).toHaveBeenCalledWith(
			"No engram data found. Run engram install first.",
		);
		expect(consolidateSession).not.toHaveBeenCalled();
		logSpy.mockRestore();
	});

	it("dry-run lists sessions without calling consolidateSession", async () => {
		vi.mocked(findUnconsolidatedSessions).mockReturnValue(["sess-1", "sess-2"]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const { runConsolidate } = await import("../cli/consolidate.js");
		const result = await runConsolidate({ cwd: "/tmp/fake", dryRun: true });

		expect(result).toEqual({ processed: 0, failed: 0, skipped: 2 });
		expect(consolidateSession).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledWith("Would consolidate 2 session(s):");
		logSpy.mockRestore();
	});

	it("retry-failed includes failed session IDs in consolidation list", async () => {
		vi.mocked(findUnconsolidatedSessions).mockReturnValue(["sess-1"]);
		vi.mocked(findFailedConsolidations).mockReturnValue([
			{
				sessionId: "sess-fail-1",
				error: "timeout",
				timestamp: "2026-04-20T10:00:00Z",
			},
		]);
		vi.mocked(consolidateSession).mockResolvedValue(undefined);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const { runConsolidate } = await import("../cli/consolidate.js");
		const result = await runConsolidate({
			cwd: "/tmp/fake",
			retryFailed: true,
		});

		expect(consolidateSession).toHaveBeenCalledTimes(2);
		expect(result.processed).toBe(2);
		expect(unlinkSync).toHaveBeenCalled();
		logSpy.mockRestore();
	});

	it("returns early with clear message when no API key configured", async () => {
		vi.mocked(findUnconsolidatedSessions).mockReturnValue(["sess-1"]);
		vi.mocked(loadConfig).mockReturnValue({
			llm: {},
			embedding: {},
			consolidation: {},
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const { runConsolidate } = await import("../cli/consolidate.js");
		const result = await runConsolidate({ cwd: "/tmp/fake" });

		expect(result).toEqual({ processed: 0, failed: 0, skipped: 0 });
		expect(logSpy).toHaveBeenCalledWith(
			"No API key configured. Run engram config to set your Anthropic API key.",
		);
		expect(consolidateSession).not.toHaveBeenCalled();
		logSpy.mockRestore();
	});

	it("filters to specific sessionId when provided", async () => {
		vi.mocked(findUnconsolidatedSessions).mockReturnValue([
			"sess-1",
			"sess-2",
			"sess-3",
		]);
		vi.mocked(consolidateSession).mockResolvedValue(undefined);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const { runConsolidate } = await import("../cli/consolidate.js");
		const result = await runConsolidate({
			cwd: "/tmp/fake",
			sessionId: "sess-2",
		});

		expect(consolidateSession).toHaveBeenCalledTimes(1);
		expect(consolidateSession).toHaveBeenCalledWith(
			"sess-2",
			expect.any(String),
			expect.any(String),
			expect.any(Object),
		);
		expect(result.processed).toBe(1);
		logSpy.mockRestore();
	});

	it("error in one session does not stop processing of remaining sessions", async () => {
		vi.mocked(findUnconsolidatedSessions).mockReturnValue([
			"sess-1",
			"sess-2",
			"sess-3",
		]);
		vi.mocked(consolidateSession)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("API rate limit"))
			.mockResolvedValueOnce(undefined);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const { runConsolidate } = await import("../cli/consolidate.js");
		const result = await runConsolidate({ cwd: "/tmp/fake" });

		expect(consolidateSession).toHaveBeenCalledTimes(3);
		expect(result).toEqual({ processed: 2, failed: 1, skipped: 0 });
		logSpy.mockRestore();
		errSpy.mockRestore();
	});

	it("returns correct counts in result object", async () => {
		vi.mocked(findUnconsolidatedSessions).mockReturnValue(["sess-1", "sess-2"]);
		vi.mocked(consolidateSession).mockResolvedValue(undefined);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const { runConsolidate } = await import("../cli/consolidate.js");
		const result = await runConsolidate({ cwd: "/tmp/fake" });

		expect(result.processed).toBe(2);
		expect(result.failed).toBe(0);
		expect(result.skipped).toBe(0);
		expect(writeConsolidationTimestamp).toHaveBeenCalledTimes(2);
		logSpy.mockRestore();
	});

	it("does not deduplicate when retry-failed session is already in unconsolidated list", async () => {
		vi.mocked(findUnconsolidatedSessions).mockReturnValue(["sess-1"]);
		vi.mocked(findFailedConsolidations).mockReturnValue([
			{
				sessionId: "sess-1",
				error: "timeout",
				timestamp: "2026-04-20T10:00:00Z",
			},
		]);
		vi.mocked(consolidateSession).mockResolvedValue(undefined);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const { runConsolidate } = await import("../cli/consolidate.js");
		const result = await runConsolidate({
			cwd: "/tmp/fake",
			retryFailed: true,
		});

		expect(consolidateSession).toHaveBeenCalledTimes(1);
		expect(result.processed).toBe(1);
		logSpy.mockRestore();
	});
});
