import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/project-identity.js", () => ({
	getDataDir: vi.fn((cwd: string) => path.join(cwd, ".engram-data")),
}));

vi.mock("../db/migrations.js", () => ({
	initializeSchema: vi.fn(() => ({ close: vi.fn() })),
}));

import { runUninstall } from "../cli/uninstall.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-uninstall-test-"));
	vi.clearAllMocks();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSettings(
	hooks: Record<string, unknown>,
	extra?: Record<string, unknown>,
): string {
	return JSON.stringify({ ...extra, hooks }, null, 2);
}

function engramMatcher(handler: string): {
	matcher: string;
	hooks: { type: string; command: string; timeout: number }[];
} {
	return {
		matcher: "",
		hooks: [
			{
				type: "command",
				command: `node /path/to/engram/${handler}.js`,
				timeout: 10,
			},
		],
	};
}

function otherMatcher(name: string): {
	matcher: string;
	hooks: { type: string; command: string }[];
} {
	return {
		matcher: "",
		hooks: [{ type: "command", command: `node /path/to/${name}/handler.js` }],
	};
}

describe("uninstall CLI", () => {
	it("removes engram hooks from settings.json, leaves other top-level keys intact", () => {
		const claudeDir = path.join(tmpDir, ".claude");
		fs.mkdirSync(claudeDir, { recursive: true });
		fs.writeFileSync(
			path.join(claudeDir, "settings.json"),
			makeSettings(
				{
					PostToolUse: [engramMatcher("post-tool-use")],
					SessionStart: [engramMatcher("session-start")],
					UserPromptSubmit: [engramMatcher("user-prompt-submit")],
					Stop: [engramMatcher("stop")],
				},
				{ theme: "dark", custom: { nested: true } },
			),
		);

		const result = runUninstall({ claudeConfigDir: claudeDir, cwd: tmpDir });

		expect(result.hooksRemoved).toBe(4);
		const settings = JSON.parse(
			fs.readFileSync(path.join(claudeDir, "settings.json"), "utf-8"),
		);
		expect(settings.theme).toBe("dark");
		expect(settings.custom).toEqual({ nested: true });
		expect(settings.hooks).toBeUndefined();
	});

	it("leaves non-engram hooks in the same event block untouched", () => {
		const claudeDir = path.join(tmpDir, ".claude");
		fs.mkdirSync(claudeDir, { recursive: true });
		fs.writeFileSync(
			path.join(claudeDir, "settings.json"),
			makeSettings({
				PostToolUse: [
					engramMatcher("post-tool-use"),
					otherMatcher("another-tool"),
				],
				SessionStart: [engramMatcher("session-start")],
			}),
		);

		const result = runUninstall({ claudeConfigDir: claudeDir, cwd: tmpDir });

		expect(result.hooksRemoved).toBe(2);
		const settings = JSON.parse(
			fs.readFileSync(path.join(claudeDir, "settings.json"), "utf-8"),
		);
		expect(settings.hooks.PostToolUse).toHaveLength(1);
		expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain(
			"another-tool",
		);
		expect(settings.hooks.SessionStart).toBeUndefined();
	});

	it("idempotent: running uninstall when no engram hooks present reports 0 removed", () => {
		const claudeDir = path.join(tmpDir, ".claude");
		fs.mkdirSync(claudeDir, { recursive: true });
		fs.writeFileSync(
			path.join(claudeDir, "settings.json"),
			makeSettings({ PostToolUse: [otherMatcher("some-tool")] }),
		);

		const result = runUninstall({ claudeConfigDir: claudeDir, cwd: tmpDir });

		expect(result.hooksRemoved).toBe(0);
	});

	it("no-op when settings.json does not exist: reports 0 removed", () => {
		const claudeDir = path.join(tmpDir, ".claude-nonexistent");

		const result = runUninstall({ claudeConfigDir: claudeDir, cwd: tmpDir });

		expect(result.hooksRemoved).toBe(0);
		expect(result.dataDirRemoved).toBe(false);
	});

	it("purge: true removes data directory when it exists", () => {
		const claudeDir = path.join(tmpDir, ".claude");
		fs.mkdirSync(claudeDir, { recursive: true });
		fs.writeFileSync(path.join(claudeDir, "settings.json"), "{}");

		const dataDir = path.join(tmpDir, ".engram-data");
		fs.mkdirSync(dataDir, { recursive: true });
		fs.writeFileSync(path.join(dataDir, "engram.db"), "fake-db");

		const result = runUninstall({
			claudeConfigDir: claudeDir,
			cwd: tmpDir,
			purge: true,
		});

		expect(result.dataDirRemoved).toBe(true);
		expect(fs.existsSync(dataDir)).toBe(false);
	});

	it("purge: true is a no-op when data directory does not exist", () => {
		const claudeDir = path.join(tmpDir, ".claude");
		fs.mkdirSync(claudeDir, { recursive: true });
		fs.writeFileSync(path.join(claudeDir, "settings.json"), "{}");

		const result = runUninstall({
			claudeConfigDir: claudeDir,
			cwd: tmpDir,
			purge: true,
		});

		expect(result.dataDirRemoved).toBe(false);
	});
});
