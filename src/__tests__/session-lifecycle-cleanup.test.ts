import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/migrations.js", () => ({
	initializeSchema: vi.fn(() => ({
		close: vi.fn(),
		prepare: vi.fn(() => ({
			all: vi.fn(() => []),
			get: vi.fn(() => undefined),
			run: vi.fn(),
		})),
	})),
}));

vi.mock("../core/consolidation.js", () => ({
	findUnconsolidatedSessions: vi.fn(() => []),
	spawnConsolidation: vi.fn(),
	findFailedConsolidations: vi.fn(() => []),
}));

vi.mock("../core/maintenance.js", () => ({
	runMaintenance: vi.fn(() => ({
		nodesPruned: 0,
		patternsCreated: 0,
		filesSuperseded: 0,
		durationMs: 1,
		skipped: true,
	})),
}));

vi.mock("../core/config.js", () => ({
	loadConfig: vi.fn(() => ({
		llm: {},
		embedding: {},
		consolidation: {},
	})),
	getMaintenanceConfig: vi.fn(() => ({
		decayThreshold: 0.05,
		decayFactor: 0.9,
	})),
}));

function createTmpDir(): string {
	const tmp = fs.mkdtempSync(
		path.join(os.tmpdir(), "engram-lifecycle-cleanup-"),
	);
	fs.mkdirSync(path.join(tmp, "events"), { recursive: true });
	fs.mkdirSync(path.join(tmp, "sessions"), { recursive: true });
	fs.mkdirSync(path.join(tmp, "episodes"), { recursive: true });
	fs.mkdirSync(path.join(tmp, "logs"), { recursive: true });
	return tmp;
}

// ── SessionStart reset tests ──────────────────────────────────

describe("SessionStart injected.json reset", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTmpDir();
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates empty injected.json on fresh session", async () => {
		const { processSessionStart } = await import(
			"../adapters/claude-code/session-start.js"
		);
		const dbPath = path.join(tmpDir, "engram.db");

		processSessionStart("sess-fresh", tmpDir, dbPath);

		const injectedPath = path.join(
			tmpDir,
			"events",
			"sess-fresh.injected.json",
		);
		expect(fs.existsSync(injectedPath)).toBe(true);
		const content = JSON.parse(fs.readFileSync(injectedPath, "utf-8"));
		expect(content).toEqual([]);
	});

	it("resets injected.json from prior session data", async () => {
		const { processSessionStart } = await import(
			"../adapters/claude-code/session-start.js"
		);
		const dbPath = path.join(tmpDir, "engram.db");

		const injectedPath = path.join(
			tmpDir,
			"events",
			"sess-reset.injected.json",
		);
		fs.writeFileSync(injectedPath, JSON.stringify(["node-1", "node-2"]));

		processSessionStart("sess-reset", tmpDir, dbPath);

		const content = JSON.parse(fs.readFileSync(injectedPath, "utf-8"));
		expect(content).toEqual([]);
	});

	it("returns no retrieval context on fresh DB", async () => {
		const { processSessionStart } = await import(
			"../adapters/claude-code/session-start.js"
		);
		const dbPath = path.join(tmpDir, "engram.db");

		const result = processSessionStart("sess-no-retrieval", tmpDir, dbPath);

		const ctx =
			(result as { hookSpecificOutput?: { additionalContext?: string } })
				?.hookSpecificOutput?.additionalContext ?? "";
		expect(ctx).not.toContain("[Engram: Prior project knowledge]");
	});
});

// ── Dedup filtering tests ─────────────────────────────────────

describe("Dedup filtering logic", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTmpDir();
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function readInjected(dir: string, sessionId: string): string[] {
		const p = path.join(dir, "events", `${sessionId}.injected.json`);
		try {
			const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
			return Array.isArray(raw) ? raw : [];
		} catch {
			return [];
		}
	}

	function writeInjected(dir: string, sessionId: string, ids: string[]): void {
		fs.writeFileSync(
			path.join(dir, "events", `${sessionId}.injected.json`),
			JSON.stringify(ids),
		);
	}

	function applyDedupFilter(
		tieredResults: {
			high: Array<{ node: { id: string } }>;
			medium: Array<{ node: { id: string } }>;
		},
		injectedIds: string[],
	): {
		filtered: {
			high: Array<{ node: { id: string } }>;
			medium: Array<{ node: { id: string } }>;
		};
		newIds: string[];
	} {
		const seen = new Set(injectedIds);
		const filtered = {
			high: tieredResults.high.filter((r) => !seen.has(r.node.id)),
			medium: tieredResults.medium.filter((r) => !seen.has(r.node.id)),
		};
		const newIds = [...filtered.high, ...filtered.medium].map((r) => r.node.id);
		return { filtered, newIds };
	}

	it("filters out previously-injected nodes from tieredResults", () => {
		const injectedIds = ["id-A"];
		const tieredResults = {
			high: [{ node: { id: "id-A" } }, { node: { id: "id-B" } }],
			medium: [],
		};

		const { filtered } = applyDedupFilter(tieredResults, injectedIds);

		expect(filtered.high).toHaveLength(1);
		expect(filtered.high[0]!.node.id).toBe("id-B");
	});

	it("writes newly-injected node IDs after filtering", () => {
		const sessionId = "sess-writeback";
		writeInjected(tmpDir, sessionId, []);

		const tieredResults = {
			high: [{ node: { id: "id-A" } }],
			medium: [{ node: { id: "id-B" } }],
		};

		const existing = readInjected(tmpDir, sessionId);
		const { newIds } = applyDedupFilter(tieredResults, existing);

		if (newIds.length > 0) {
			writeInjected(tmpDir, sessionId, [...existing, ...newIds]);
		}

		const updated = readInjected(tmpDir, sessionId);
		expect(updated).toEqual(["id-A", "id-B"]);
	});

	it("second filter excludes first filter nodes", () => {
		const sessionId = "sess-multi";
		writeInjected(tmpDir, sessionId, []);

		const firstResults = {
			high: [{ node: { id: "id-A" } }],
			medium: [{ node: { id: "id-B" } }],
		};
		const first = readInjected(tmpDir, sessionId);
		const { newIds: firstNewIds } = applyDedupFilter(firstResults, first);
		writeInjected(tmpDir, sessionId, [...first, ...firstNewIds]);

		const secondResults = {
			high: [
				{ node: { id: "id-A" } },
				{ node: { id: "id-B" } },
				{ node: { id: "id-C" } },
			],
			medium: [],
		};
		const second = readInjected(tmpDir, sessionId);
		const { filtered: secondFiltered } = applyDedupFilter(
			secondResults,
			second,
		);

		expect(secondFiltered.high).toHaveLength(1);
		expect(secondFiltered.high[0]!.node.id).toBe("id-C");
	});

	it("treats corrupt injected.json as empty set (no crash)", () => {
		const sessionId = "sess-corrupt";
		const p = path.join(tmpDir, "events", `${sessionId}.injected.json`);
		fs.writeFileSync(p, "not valid json{");

		const existing = readInjected(tmpDir, sessionId);
		expect(existing).toEqual([]);

		const tieredResults = {
			high: [{ node: { id: "id-X" } }],
			medium: [{ node: { id: "id-Y" } }],
		};
		const { filtered } = applyDedupFilter(tieredResults, existing);

		expect(filtered.high).toHaveLength(1);
		expect(filtered.medium).toHaveLength(1);
	});

	it("treats missing injected.json as empty set (no crash)", () => {
		const sessionId = "sess-missing";

		const existing = readInjected(tmpDir, sessionId);
		expect(existing).toEqual([]);

		const tieredResults = {
			high: [{ node: { id: "id-X" } }],
			medium: [{ node: { id: "id-Y" } }],
		};
		const { filtered } = applyDedupFilter(tieredResults, existing);

		expect(filtered.high).toHaveLength(1);
		expect(filtered.medium).toHaveLength(1);
	});
});
