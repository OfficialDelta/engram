import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EngramConfig, saveConfig } from "../core/config.js";

const isWindows = process.platform === "win32";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-perm-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("config file permissions", () => {
	it.skipIf(isWindows)("saveConfig sets file permissions to 0o600", () => {
		const configPath = path.join(tmpDir, "config.json");
		const config: EngramConfig = { llm: {}, embedding: {}, consolidation: {} };
		saveConfig(config, configPath);

		const stat = fs.statSync(configPath);
		const mode = stat.mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it.skipIf(isWindows)("saveConfig preserves 0o600 on overwrite", () => {
		const configPath = path.join(tmpDir, "config.json");
		const config: EngramConfig = { llm: {}, embedding: {}, consolidation: {} };
		saveConfig(config, configPath);
		saveConfig({ ...config, llm: { pass1Model: "updated" } }, configPath);

		const stat = fs.statSync(configPath);
		const mode = stat.mode & 0o777;
		expect(mode).toBe(0o600);
	});
});
