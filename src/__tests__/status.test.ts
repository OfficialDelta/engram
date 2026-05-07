import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

vi.mock("../core/project-identity.js", () => ({
	getDataDir: vi.fn(),
	getDbPath: vi.fn(),
}));

import { runStatus } from "../cli/status.js";
import { getDataDir, getDbPath } from "../core/project-identity.js";
import { initializeSchema } from "../db/migrations.js";

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-status-test-"));
	vi.mocked(getDataDir).mockReturnValue(path.join(tmpDir, "data"));
	vi.mocked(getDbPath).mockReturnValue(path.join(tmpDir, "data", "engram.db"));
	vi.clearAllMocks();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSettings(hooks: Record<string, unknown>): string {
	return JSON.stringify({ hooks }, null, 2);
}

function engramHook(handler: string): {
	type: string;
	command: string;
	timeout: number;
} {
	return {
		type: "command",
		command: `node /path/to/engram/${handler}.js`,
		timeout: 10,
	};
}

function statusOpts(claudeDir: string) {
	return { claudeConfigDir: claudeDir, cwd: tmpDir };
}

describe("status CLI", () => {
	it("returns null counts and dbExists=false when DB file does not exist", () => {
		const claudeDir = path.join(tmpDir, ".claude");
		fs.mkdirSync(claudeDir, { recursive: true });
		fs.writeFileSync(path.join(claudeDir, "settings.json"), "{}");

		const result = runStatus(statusOpts(claudeDir));

		expect(result.dbExists).toBe(false);
		expect(result.nodes).toBeNull();
		expect(result.edges).toBeNull();
		expect(result.episodes).toBeNull();
		expect(result.lastConsolidation).toBeNull();
		expect(result.dbError).toBeUndefined();
	});

	it("returns correct counts from a real DB", () => {
		const dataDir = path.join(tmpDir, "data");
		fs.mkdirSync(dataDir, { recursive: true });
		const dbPath = path.join(dataDir, "engram.db");

		const db = initializeSchema(dbPath);
		const insertNode = db.prepare(
			"INSERT INTO nodes (id, name, node_type, description, strength, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		insertNode.run(
			"n1",
			"Node1",
			"concept",
			"desc",
			1.0,
			"2026-04-19T10:00:00Z",
			"2026-04-19T10:00:00Z",
		);
		insertNode.run(
			"n2",
			"Node2",
			"decision",
			"desc",
			1.0,
			"2026-04-19T10:00:00Z",
			"2026-04-19T10:00:00Z",
		);
		insertNode.run(
			"n3",
			"Node3",
			"pattern",
			"desc",
			1.0,
			"2026-04-19T10:00:00Z",
			"2026-04-19T10:00:00Z",
		);

		db.prepare(
			"INSERT INTO edges (id, source_node_id, target_node_id, relationship_type, weight) VALUES (?, ?, ?, ?, ?)",
		).run("e1", "n1", "n2", "relates_to", 1.0);
		db.prepare(
			"INSERT INTO edges (id, source_node_id, target_node_id, relationship_type, weight) VALUES (?, ?, ?, ?, ?)",
		).run("e2", "n2", "n3", "depends_on", 1.0);

		db.prepare(
			"INSERT INTO episodes (id, session_id, summary, timestamp) VALUES (?, ?, ?, ?)",
		).run("ep1", "sess1", "Test episode", "2026-04-19T14:23:11Z");
		db.close();

		vi.mocked(getDataDir).mockReturnValue(dataDir);
		vi.mocked(getDbPath).mockReturnValue(dbPath);

		const claudeDir = path.join(tmpDir, ".claude");
		fs.mkdirSync(claudeDir, { recursive: true });
		fs.writeFileSync(path.join(claudeDir, "settings.json"), "{}");

		const result = runStatus(statusOpts(claudeDir));

		expect(result.dbExists).toBe(true);
		expect(result.nodes).toBe(3);
		expect(result.edges).toBe(2);
		expect(result.episodes).toBe(1);
		expect(result.lastConsolidation).toBe("2026-04-19T14:23:11Z");
	});

	it("reports all hooks missing when settings.json does not exist", () => {
		const claudeDir = path.join(tmpDir, ".claude-nonexistent");

		const result = runStatus(statusOpts(claudeDir));

		expect(result.hooksMissing).toEqual([
			"PostToolUse",
			"SessionStart",
			"UserPromptSubmit",
			"Stop",
			"PostCompact",
			"SessionEnd",
		]);
		expect(result.hooksRegistered).toEqual([]);
	});

	it("reports all 6 hooks registered when settings.json has engram hooks", () => {
		const claudeDir = path.join(tmpDir, ".claude");
		fs.mkdirSync(claudeDir, { recursive: true });
		fs.writeFileSync(
			path.join(claudeDir, "settings.json"),
			makeSettings({
				PostToolUse: { hooks: [engramHook("post-tool-use")] },
				SessionStart: { hooks: [engramHook("session-start")] },
				UserPromptSubmit: { hooks: [engramHook("user-prompt-submit")] },
				Stop: { hooks: [engramHook("stop")] },
				PostCompact: { hooks: [engramHook("post-compact")] },
				SessionEnd: { hooks: [engramHook("session-end")] },
			}),
		);

		const result = runStatus(statusOpts(claudeDir));

		expect(result.hooksRegistered).toEqual([
			"PostToolUse",
			"SessionStart",
			"UserPromptSubmit",
			"Stop",
			"PostCompact",
			"SessionEnd",
		]);
		expect(result.hooksMissing).toEqual([]);
	});

	it("reports partial hook registration", () => {
		const claudeDir = path.join(tmpDir, ".claude");
		fs.mkdirSync(claudeDir, { recursive: true });
		fs.writeFileSync(
			path.join(claudeDir, "settings.json"),
			makeSettings({
				PostToolUse: { hooks: [engramHook("post-tool-use")] },
				Stop: { hooks: [engramHook("stop")] },
			}),
		);

		const result = runStatus(statusOpts(claudeDir));

		expect(result.hooksRegistered).toEqual(["PostToolUse", "Stop"]);
		expect(result.hooksMissing).toEqual([
			"SessionStart",
			"UserPromptSubmit",
			"PostCompact",
			"SessionEnd",
		]);
	});

	it("returns dbError string when DB file exists but is corrupt", () => {
		const dataDir = path.join(tmpDir, "data");
		fs.mkdirSync(dataDir, { recursive: true });
		const dbPath = path.join(dataDir, "engram.db");
		fs.writeFileSync(dbPath, "this is not a valid sqlite database");

		vi.mocked(getDataDir).mockReturnValue(dataDir);
		vi.mocked(getDbPath).mockReturnValue(dbPath);

		const claudeDir = path.join(tmpDir, ".claude");
		fs.mkdirSync(claudeDir, { recursive: true });
		fs.writeFileSync(path.join(claudeDir, "settings.json"), "{}");

		const result = runStatus(statusOpts(claudeDir));

		expect(result.dbExists).toBe(true);
		expect(result.dbError).toBeDefined();
		expect(typeof result.dbError).toBe("string");
		expect(result.nodes).toBeNull();
		expect(result.edges).toBeNull();
		expect(result.episodes).toBeNull();
	});
});
