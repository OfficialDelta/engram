import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "engram-stdin-test-"));
}

describe("hook main() stdin reading via fd 0", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs) {
			fs.rmSync(d, { recursive: true, force: true });
		}
		dirs.length = 0;
	});

	const hooks = [
		{
			name: "session-start",
			input: (cwd: string) => ({ session_id: "test-sess", cwd }),
		},
		{
			name: "user-prompt-submit",
			input: (cwd: string) => ({ prompt: "hello world", cwd }),
		},
		{
			name: "post-tool-use",
			input: () => ({
				session_id: "test-sess",
				tool_name: "Read",
				tool_input: { file_path: "/tmp/x.ts" },
			}),
		},
		{
			name: "stop",
			input: (cwd: string) => ({ session_id: "test-sess", cwd }),
		},
	] as const;

	for (const hook of hooks) {
		it(`${hook.name} reads piped stdin without ENXIO`, () => {
			const tmpDir = makeTmpDir();
			dirs.push(tmpDir);

			const scriptPath = path.resolve(
				__dirname,
				`../../dist/adapters/claude-code/${hook.name}.js`,
			);
			const input = JSON.stringify(hook.input(tmpDir));

			const stdout = execFileSync(process.execPath, [scriptPath], {
				input,
				cwd: tmpDir,
				timeout: 10_000,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});

			const result = JSON.parse(stdout);
			expect(result).toBeDefined();
			expect(typeof result).toBe("object");
		});
	}
});
