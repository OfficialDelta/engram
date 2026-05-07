import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConfig } from "../cli/config.js";
import { type EngramConfig, loadConfig } from "../core/config.js";

let tmpDir: string;
let configPath: string;
let consoleLogs: string[];
let consoleErrors: string[];

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-cli-config-test-"));
	configPath = path.join(tmpDir, "config.json");
	consoleLogs = [];
	consoleErrors = [];
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		consoleLogs.push(args.map(String).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		consoleErrors.push(args.map(String).join(" "));
	});
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("config show", () => {
	it("outputs config with masked keys", async () => {
		const config: EngramConfig = {
			llm: {
				apiKey: "sk-1234567890abcdef",
				pass1Model: "claude-sonnet-4-20250514",
			},
			embedding: { provider: "voyage-3-lite", apiKey: "va-secret-key-1234" },
			consolidation: { windowSize: 10 },
		};
		fs.writeFileSync(configPath, JSON.stringify(config));

		await runConfig(["show"], configPath);

		const output = consoleLogs.join("\n");
		expect(output).toContain("llm.apiKey = ****cdef");
		expect(output).toContain("llm.pass1Model = claude-sonnet-4-20250514");
		expect(output).toContain("embedding.provider = voyage-3-lite");
		expect(output).toContain("embedding.apiKey = ****1234");
		expect(output).toContain("consolidation.windowSize = 10");
		expect(output).not.toContain("sk-1234567890abcdef");
		expect(output).not.toContain("va-secret-key-1234");
	});

	it("shows (no configuration set) for empty config", async () => {
		fs.writeFileSync(configPath, "{}");
		await runConfig(["show"], configPath);
		expect(consoleLogs.join("\n")).toContain("(no configuration set)");
	});
});

describe("config set", () => {
	it("writes llm.apiKey to config file", async () => {
		fs.writeFileSync(configPath, "{}");

		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("exit");
		});
		await runConfig(["set", "llm.apiKey", "sk-test-123"], configPath);

		const saved = loadConfig(configPath);
		expect(saved.llm.apiKey).toBe("sk-test-123");
		exitSpy.mockRestore();
	});

	it("rejects unknown key paths", async () => {
		fs.writeFileSync(configPath, "{}");

		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("exit");
		});

		await expect(
			runConfig(["set", "foo.bar", "baz"], configPath),
		).rejects.toThrow("exit");
		expect(consoleErrors.some((s) => s.includes("Unknown config key"))).toBe(
			true,
		);
		exitSpy.mockRestore();
	});

	it("stores consolidation.turnThreshold as number", async () => {
		fs.writeFileSync(configPath, "{}");

		await runConfig(["set", "consolidation.turnThreshold", "10"], configPath);

		const saved = loadConfig(configPath);
		expect(saved.consolidation.turnThreshold).toBe(10);
		expect(typeof saved.consolidation.turnThreshold).toBe("number");
	});
});

describe("config get", () => {
	it("returns masked value for api key fields", async () => {
		const config: EngramConfig = {
			llm: { apiKey: "sk-1234567890abcdef" },
			embedding: {},
			consolidation: {},
		};
		fs.writeFileSync(configPath, JSON.stringify(config));

		await runConfig(["get", "llm.apiKey"], configPath);

		expect(consoleLogs.join("\n")).toContain("****cdef");
		expect(consoleLogs.join("\n")).not.toContain("sk-1234567890abcdef");
	});

	it("returns plain value for non-key fields", async () => {
		const config: EngramConfig = {
			llm: { pass1Model: "my-model" },
			embedding: {},
			consolidation: {},
		};
		fs.writeFileSync(configPath, JSON.stringify(config));

		await runConfig(["get", "llm.pass1Model"], configPath);
		expect(consoleLogs.join("\n")).toContain("my-model");
	});

	it("shows (not set) for undefined values", async () => {
		fs.writeFileSync(configPath, "{}");
		await runConfig(["get", "llm.apiKey"], configPath);
		expect(consoleLogs.join("\n")).toContain("(not set)");
	});
});

describe("config wizard (non-TTY)", () => {
	it("detects non-TTY and skips gracefully", async () => {
		await runConfig([], configPath);
		expect(
			consoleLogs.some((s) => s.includes("Non-interactive environment")),
		).toBe(true);
	});
});

describe("config --help", () => {
	it("prints usage information", async () => {
		await runConfig(["--help"], configPath);
		const output = consoleLogs.join("\n");
		expect(output).toContain("Usage: engram config");
		expect(output).toContain("show");
		expect(output).toContain("get");
		expect(output).toContain("set");
	});
});
