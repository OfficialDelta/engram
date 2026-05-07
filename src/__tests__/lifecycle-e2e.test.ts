import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphChangeRequest, StructuredEpisode } from "../types.js";

vi.mock("../core/embed.js", () => ({
	getEmbedding: vi.fn(async (texts: string[]) => {
		return texts.map((text: string) => {
			let h = 0;
			for (const ch of text) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
			return Array.from({ length: 512 }, (_, i) => Math.sin(h + i * 0.37));
		});
	}),
	getDimensions: vi.fn().mockReturnValue(512),
}));

vi.mock("../core/consolidation.js", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../core/consolidation.js")>();
	return { ...mod, spawnConsolidation: vi.fn() };
});

vi.mock("../core/config.js", () => ({
	loadConfig: vi.fn(() => ({
		llm: { apiKey: "test-key" },
		consolidation: {},
		embedding: {},
	})),
	getMaintenanceConfig: vi.fn(() => ({
		decayIntervalMs: 0,
		patternThreshold: 3,
	})),
}));

vi.mock("../core/maintenance.js", () => ({
	runMaintenance: vi.fn(() => ({
		skipped: true,
		nodesPruned: 0,
		patternsCreated: 0,
		filesSuperseded: 0,
		durationMs: 0,
	})),
}));

function createTmpDataDir(): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-lifecycle-"));
	for (const sub of ["events", "sessions", "episodes", "logs", "metrics"]) {
		fs.mkdirSync(path.join(tmpDir, sub), { recursive: true });
	}
	return tmpDir;
}

function createMockClient(
	pass1JSON: string,
	pass2ToolInput: { episode: StructuredEpisode; changes: GraphChangeRequest },
) {
	return {
		messages: {
			create: vi
				.fn()
				.mockImplementation(async (params: Record<string, unknown>) => {
					if (params.tools) {
						return {
							content: [
								{
									type: "tool_use",
									id: "call_1",
									name: "extract_episode",
									input: pass2ToolInput,
								},
							],
						};
					}
					return { content: [{ type: "text", text: pass1JSON }] };
				}),
		},
	};
}

const batch1Pass1JSON = JSON.stringify({
	summary: "Agent modified auth middleware and crypto utilities",
	filesModified: ["src/auth.ts", "src/utils/crypto.ts"],
	decisionsIdentified: ["Use JWT for authentication", "Use bcrypt for hashing"],
	outcome: "progress",
});

const batch1Pass2Input: {
	episode: StructuredEpisode;
	changes: GraphChangeRequest;
} = {
	episode: {
		goal: "Implement authentication",
		approach: "Added JWT middleware and bcrypt hashing",
		outcome: "success",
		discoveries: [
			{
				content: "JWT works well",
				evidence: "src/auth.ts:15",
				confidence: 0.9,
			},
		],
		decisions: [
			{
				content: "Use bcrypt",
				rationale: "Industry standard",
				isImplicit: false,
			},
		],
		errors: [],
	},
	changes: {
		nodesToCreate: [
			{
				name: "auth-middleware",
				nodeType: "pattern",
				description: "JWT-based authentication middleware",
				affectedFiles: ["src/auth.ts"],
				causallyImportant: true,
			},
			{
				name: "bcrypt-hashing",
				nodeType: "decision",
				description: "Use bcrypt for password hashing",
				affectedFiles: ["src/utils/crypto.ts"],
				causallyImportant: false,
			},
		],
		nodesToUpdate: [],
		edgesToCreate: [
			{
				sourceNodeName: "auth-middleware",
				targetNodeName: "bcrypt-hashing",
				relationshipType: "depends_on",
				weight: 0.9,
			},
		],
	},
};

const batch2Pass1JSON = JSON.stringify({
	summary: "Agent configured logging and error handling",
	filesModified: ["src/config.ts", "src/errors.ts"],
	decisionsIdentified: [
		"Structured logging format",
		"Centralized error handler",
	],
	outcome: "progress",
});

const batch2Pass2Input: {
	episode: StructuredEpisode;
	changes: GraphChangeRequest;
} = {
	episode: {
		goal: "Configure logging",
		approach: "Set up structured logging and centralized error handling",
		outcome: "success",
		discoveries: [
			{
				content: "Structured logs improve debugging",
				evidence: "src/config.ts:30",
				confidence: 0.85,
			},
		],
		decisions: [
			{
				content: "Use centralized error handler",
				rationale: "Reduces duplication",
				isImplicit: false,
			},
		],
		errors: [],
	},
	changes: {
		nodesToCreate: [
			{
				name: "logging-config",
				nodeType: "concept",
				description: "Structured logging configuration",
				affectedFiles: ["src/config.ts"],
				causallyImportant: true,
			},
			{
				name: "error-handling",
				nodeType: "pattern",
				description: "Centralized error handling pattern",
				affectedFiles: ["src/errors.ts"],
				causallyImportant: false,
			},
		],
		nodesToUpdate: [],
		edgesToCreate: [
			{
				sourceNodeName: "logging-config",
				targetNodeName: "error-handling",
				relationshipType: "depends_on",
				weight: 0.8,
			},
		],
	},
};

describe("Full Lifecycle with PostCompact Consolidation Cycle", () => {
	let tmpDir: string;
	let dbPath: string;
	const sessionId = "sess-lifecycle-1";

	beforeEach(async () => {
		tmpDir = createTmpDataDir();
		dbPath = path.join(tmpDir, "engram.db");
		const { initializeSchema } = await import("../db/migrations.js");
		const db = initializeSchema(dbPath);
		db.close();

		const { spawnConsolidation } = await import("../core/consolidation.js");
		vi.mocked(spawnConsolidation).mockReset();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("full lifecycle: SessionStart through SessionEnd with two consolidation cycles", async () => {
		const { processSessionStart } = await import(
			"../adapters/claude-code/session-start.js"
		);
		const { processPostToolUse } = await import(
			"../adapters/claude-code/post-tool-use.js"
		);
		const { processStop } = await import("../adapters/claude-code/stop.js");
		const { processPostCompact } = await import(
			"../adapters/claude-code/post-compact.js"
		);
		const { processSessionEnd } = await import(
			"../adapters/claude-code/session-end.js"
		);
		const {
			consolidateSession,
			readConsolidationTimestamp,
			writeConsolidationTimestamp,
			spawnConsolidation,
		} = await import("../core/consolidation.js");
		const { getSessionEvents } = await import("../core/event-stream.js");
		const { loadSessionState, saveSessionState } = await import(
			"../core/session-state.js"
		);
		const { initializeSchema } = await import("../db/migrations.js");

		// a. SessionStart — initializes session state
		processSessionStart(sessionId, tmpDir, dbPath);
		const initialState = loadSessionState(tmpDir, sessionId);
		expect(initialState.turnCount).toBe(0);
		expect(initialState.toolCallCount).toBe(0);

		// b. Simulate UserPromptSubmit — set lastUserPrompt on session state
		const state = loadSessionState(tmpDir, sessionId);
		state.lastUserPrompt = "Working on auth";
		saveSessionState(tmpDir, sessionId, state);

		// c. PostToolUse — Read src/auth.ts
		processPostToolUse(
			{
				tool_name: "Read",
				tool_input: { file_path: "src/auth.ts" },
				session_id: sessionId,
			},
			tmpDir,
			dbPath,
			{ spawnCheck: vi.fn() },
		);

		// d. PostToolUse — Write src/auth.ts
		processPostToolUse(
			{
				tool_name: "Write",
				tool_input: {
					file_path: "src/auth.ts",
					content: "jwt middleware code",
				},
				session_id: sessionId,
			},
			tmpDir,
			dbPath,
			{ spawnCheck: vi.fn() },
		);

		// e. Stop — ends the turn, appends turn_complete event
		processStop(sessionId, tmpDir, dbPath, { userMessage: "Working on auth" });
		const eventsAfterStop = getSessionEvents(sessionId, tmpDir);
		expect(eventsAfterStop.length).toBeGreaterThanOrEqual(3);
		const lastEvent = eventsAfterStop[eventsAfterStop.length - 1]!;
		expect(lastEvent.type).toBe("turn_complete");

		// f. PostCompact — triggers consolidation spawn
		processPostCompact(sessionId, tmpDir, dbPath);
		expect(spawnConsolidation).toHaveBeenCalled();

		// g. Simulate consolidation worker — batch 1
		const mockClient1 = createMockClient(batch1Pass1JSON, batch1Pass2Input);
		await consolidateSession(sessionId, dbPath, tmpDir, {
			client: mockClient1,
		});
		writeConsolidationTimestamp(tmpDir, sessionId, new Date().toISOString());
		// Reset spawn flag (real worker does this after successful consolidation)
		const postConsolidateState = loadSessionState(tmpDir, sessionId);
		postConsolidateState.consolidationSpawned = false;
		saveSessionState(tmpDir, sessionId, postConsolidateState);

		// Verify batch 1 nodes in DB
		const db1 = initializeSchema(dbPath);
		const rows1 = db1.prepare("SELECT name FROM nodes").all() as Array<{
			name: string;
		}>;
		const names1 = rows1.map((r) => r.name);
		expect(names1).toContain("auth-middleware");
		expect(names1).toContain("bcrypt-hashing");
		db1.close();

		expect(readConsolidationTimestamp(tmpDir, sessionId)).not.toBeNull();

		// Small delay so post-compaction event timestamps are strictly after the consolidation marker
		await new Promise((r) => setTimeout(r, 20));

		// h. Post-compaction phase: more tool calls
		processPostToolUse(
			{
				tool_name: "Read",
				tool_input: { file_path: "src/config.ts" },
				session_id: sessionId,
			},
			tmpDir,
			dbPath,
			{ spawnCheck: vi.fn() },
		);

		processPostToolUse(
			{
				tool_name: "Write",
				tool_input: { file_path: "src/config.ts", content: "logging config" },
				session_id: sessionId,
			},
			tmpDir,
			dbPath,
			{ spawnCheck: vi.fn() },
		);

		// i. Stop — second turn
		processStop(sessionId, tmpDir, dbPath);

		// j. SessionEnd — triggers consolidation for unconsolidated events
		const spawnCallsBefore = vi.mocked(spawnConsolidation).mock.calls.length;
		processSessionEnd(sessionId, tmpDir, dbPath);
		expect(vi.mocked(spawnConsolidation).mock.calls.length).toBeGreaterThan(
			spawnCallsBefore,
		);

		// k. Simulate consolidation worker — batch 2 (with sinceTimestamp)
		const ts = readConsolidationTimestamp(tmpDir, sessionId);
		expect(ts).not.toBeNull();
		const mockClient2 = createMockClient(batch2Pass1JSON, batch2Pass2Input);
		await consolidateSession(sessionId, dbPath, tmpDir, {
			client: mockClient2,
			sinceTimestamp: ts!,
		});
		writeConsolidationTimestamp(tmpDir, sessionId, new Date().toISOString());

		// Verify all 4 nodes exist in DB
		const db2 = initializeSchema(dbPath);
		const rows2 = db2.prepare("SELECT name FROM nodes").all() as Array<{
			name: string;
		}>;
		const names2 = rows2.map((r) => r.name);
		expect(names2).toContain("auth-middleware");
		expect(names2).toContain("bcrypt-hashing");
		expect(names2).toContain("logging-config");
		expect(names2).toContain("error-handling");
		expect(names2.length).toBeGreaterThanOrEqual(4);
		db2.close();
	});

	it("SessionEnd skips when no unconsolidated events remain", async () => {
		const { processSessionStart } = await import(
			"../adapters/claude-code/session-start.js"
		);
		const { processPostToolUse } = await import(
			"../adapters/claude-code/post-tool-use.js"
		);
		const { processStop } = await import("../adapters/claude-code/stop.js");
		const { processSessionEnd } = await import(
			"../adapters/claude-code/session-end.js"
		);
		const {
			consolidateSession,
			writeConsolidationTimestamp,
			spawnConsolidation,
		} = await import("../core/consolidation.js");

		processSessionStart(sessionId, tmpDir, dbPath);

		processPostToolUse(
			{
				tool_name: "Read",
				tool_input: { file_path: "src/auth.ts" },
				session_id: sessionId,
			},
			tmpDir,
			dbPath,
			{ spawnCheck: vi.fn() },
		);

		processStop(sessionId, tmpDir, dbPath);

		// Consolidate everything and write timestamp after all events
		const mockClient = createMockClient(batch1Pass1JSON, batch1Pass2Input);
		await consolidateSession(sessionId, dbPath, tmpDir, { client: mockClient });
		writeConsolidationTimestamp(tmpDir, sessionId, new Date().toISOString());

		// Now call SessionEnd — should skip since timestamp is after all events
		const callCountBefore = vi.mocked(spawnConsolidation).mock.calls.length;
		processSessionEnd(sessionId, tmpDir, dbPath);
		expect(vi.mocked(spawnConsolidation).mock.calls.length).toBe(
			callCountBefore,
		);
	});

	it("PostCompact skips consolidation when no API key configured", async () => {
		const { loadConfig } = await import("../core/config.js");
		const { processPostCompact } = await import(
			"../adapters/claude-code/post-compact.js"
		);
		const { spawnConsolidation } = await import("../core/consolidation.js");

		vi.mocked(loadConfig).mockReturnValueOnce({
			llm: {},
			consolidation: {},
			embedding: {},
		} as ReturnType<typeof loadConfig>);

		const callCountBefore = vi.mocked(spawnConsolidation).mock.calls.length;
		processPostCompact(sessionId, tmpDir, dbPath);
		expect(vi.mocked(spawnConsolidation).mock.calls.length).toBe(
			callCountBefore,
		);
	});
});
