import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CLI_PATH = resolve(import.meta.dirname, "..", "cli", "index.ts");

function run(...args: string[]): {
	stdout: string;
	stderr: string;
	exitCode: number;
} {
	try {
		const stdout = execFileSync("npx", ["tsx", CLI_PATH, ...args], {
			encoding: "utf-8",
			timeout: 15_000,
			env: { ...process.env, NODE_NO_WARNINGS: "1" },
		});
		return { stdout, stderr: "", exitCode: 0 };
	} catch (err: unknown) {
		const e = err as { stdout?: string; stderr?: string; status?: number };
		return {
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? "",
			exitCode: e.status ?? 1,
		};
	}
}

describe("engram mcp --help", () => {
	it("prints usage text describing the MCP server and its tools", () => {
		const { stdout, exitCode } = run("mcp", "--help");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Usage: engram mcp");
		expect(stdout).toContain("query_knowledge");
		expect(stdout).toContain("save_decision");
		expect(stdout).toContain("mcpServers");
	});
});

describe("engram consolidate --help", () => {
	it("prints usage text for consolidate", () => {
		const { stdout, exitCode } = run("consolidate", "--help");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Usage: engram consolidate");
	});
});

describe("engram inspect --help", () => {
	it("prints usage text for inspect", () => {
		const { stdout, exitCode } = run("inspect", "--help");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Usage: engram inspect");
	});
});

describe("engram re-embed --help", () => {
	it("prints usage text for re-embed", () => {
		const { stdout, exitCode } = run("re-embed", "--help");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Usage: engram re-embed");
	});
});

describe("engram ingest --help", () => {
	it("prints usage text for ingest", () => {
		const { stdout, exitCode } = run("ingest", "--help");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Usage: engram ingest");
	});
});

describe("unknown command suggests alternatives", () => {
	it("prints suggestion and exits with code 1", () => {
		const { stderr, exitCode } = run("boguscmd");
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Unknown command: boguscmd");
		expect(stderr).toContain("Run 'engram --help' for available commands.");
		expect(stderr).toContain("Did you mean:");
		expect(stderr).toContain("consolidate");
		expect(stderr).toContain("inspect");
		expect(stderr).toContain("re-embed");
		expect(stderr).toContain("ingest");
	});
});

describe("main help includes getting started workflow", () => {
	it("prints getting started section", () => {
		const { stdout, exitCode } = run("--help");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Getting started:");
		expect(stdout).toContain("engram install");
		expect(stdout).toContain("engram config");
		expect(stdout).toContain("engram status");
	});

	it("lists consolidate and inspect commands", () => {
		const { stdout, exitCode } = run("--help");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("consolidate");
		expect(stdout).toContain("inspect");
	});
});
