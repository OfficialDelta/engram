import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendEvent,
	buildTurnCompleteEvent,
	classifyToolCall,
	detectDerivedEvents,
	getSessionEvents,
} from "../core/event-stream.js";
import type {
	EngramEvent,
	FileReadEvent,
	FileWriteEvent,
	RawToolCall,
	TestRunEvent,
} from "../types.js";

function makeToolCall(
	overrides: Partial<RawToolCall> & { tool_name: string },
): RawToolCall {
	return {
		tool_input: {},
		session_id: "test-session",
		...overrides,
	};
}

describe("event-stream", () => {
	describe("classifyToolCall", () => {
		it("classifies Read as file_read with filePath", () => {
			const result = classifyToolCall(
				makeToolCall({
					tool_name: "Read",
					tool_input: { file_path: "/src/foo.ts" },
				}),
			);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("file_read");
			expect((result as FileReadEvent).filePath).toBe("/src/foo.ts");
		});

		it("classifies View as file_read", () => {
			const result = classifyToolCall(
				makeToolCall({
					tool_name: "View",
					tool_input: { file_path: "/bar.ts" },
				}),
			);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("file_read");
		});

		it("classifies Write as file_write with linesChanged and evidenceSnippet", () => {
			const result = classifyToolCall(
				makeToolCall({
					tool_name: "Write",
					tool_input: { file_path: "/new.ts", content: "line1\nline2\nline3" },
				}),
			);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("file_write");
			const fw = result as FileWriteEvent;
			expect(fw.linesChanged).toBe(2);
			expect(fw.evidenceSnippet).toContain("line1");
		});

		it("classifies Edit as file_write", () => {
			const result = classifyToolCall(
				makeToolCall({
					tool_name: "Edit",
					tool_input: {
						file_path: "/edit.ts",
						old_string: "old",
						new_string: "new\ncode",
					},
				}),
			);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("file_write");
			expect((result as FileWriteEvent).filePath).toBe("/edit.ts");
		});

		it("classifies MultiEdit as file_write", () => {
			const result = classifyToolCall(
				makeToolCall({
					tool_name: "MultiEdit",
					tool_input: { file_path: "/multi.ts", new_string: "x" },
				}),
			);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("file_write");
		});

		it("classifies Bash with npm test as test_run with passed true", () => {
			const result = classifyToolCall(
				makeToolCall({
					tool_name: "Bash",
					tool_input: { command: "npm test", exit_code: 0 },
				}),
			);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("test_run");
			expect((result as TestRunEvent).passed).toBe(true);
		});

		it("classifies Bash with vitest run as test_run with passed false on exit_code 1", () => {
			const result = classifyToolCall(
				makeToolCall({
					tool_name: "Bash",
					tool_input: { command: "vitest run", exit_code: 1 },
				}),
			);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("test_run");
			expect((result as TestRunEvent).passed).toBe(false);
		});

		it("classifies Bash with jest --coverage as test_run", () => {
			const result = classifyToolCall(
				makeToolCall({
					tool_name: "Bash",
					tool_input: { command: "jest --coverage", exit_code: 0 },
				}),
			);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("test_run");
		});

		it("classifies Bash with go test ./... as test_run", () => {
			const result = classifyToolCall(
				makeToolCall({
					tool_name: "Bash",
					tool_input: { command: "go test ./...", exit_code: 0 },
				}),
			);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("test_run");
		});

		it("classifies Bash with npm run build as build", () => {
			const result = classifyToolCall(
				makeToolCall({
					tool_name: "Bash",
					tool_input: { command: "npm run build", exit_code: 0 },
				}),
			);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("build");
		});

		it("classifies Bash with tsc as build with exitCode", () => {
			const result = classifyToolCall(
				makeToolCall({
					tool_name: "Bash",
					tool_input: { command: "tsc", exit_code: 1 },
				}),
			);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("build");
			expect((result as { exitCode: number }).exitCode).toBe(1);
		});

		it("returns null for generic Bash command", () => {
			const result = classifyToolCall(
				makeToolCall({
					tool_name: "Bash",
					tool_input: { command: "ls -la" },
				}),
			);
			expect(result).toBeNull();
		});

		it("classifies WebSearch as research", () => {
			const result = classifyToolCall(
				makeToolCall({
					tool_name: "WebSearch",
					tool_input: { query: "sqlite wal mode" },
				}),
			);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("research");
		});

		it("returns null for unknown tool", () => {
			const result = classifyToolCall(
				makeToolCall({
					tool_name: "UnknownTool",
					tool_input: {},
				}),
			);
			expect(result).toBeNull();
		});
	});

	describe("detectDerivedEvents", () => {
		const baseEvent = (
			type: string,
			extra: Record<string, unknown> = {},
		): EngramEvent =>
			({
				type,
				sessionId: "test-session",
				timestamp: new Date().toISOString(),
				...extra,
			}) as EngramEvent;

		it("returns exploration for file_read with no prior reads", () => {
			const event = baseEvent("file_read", {
				filePath: "/src/new.ts",
			}) as FileReadEvent;
			const result = detectDerivedEvents(event, []);
			expect(result.some((e) => e.type === "exploration")).toBe(true);
		});

		it("returns empty for file_read of already-read path", () => {
			const event = baseEvent("file_read", {
				filePath: "/src/old.ts",
			}) as FileReadEvent;
			const prior = [
				baseEvent("file_read", { filePath: "/src/old.ts" }) as FileReadEvent,
			];
			const result = detectDerivedEvents(event, prior);
			expect(result).toEqual([]);
		});

		it("returns fix_attempt for file_write after failed test", () => {
			const event = baseEvent("file_write", {
				filePath: "/src/fix.ts",
				linesChanged: 5,
				evidenceSnippet: "",
			}) as FileWriteEvent;
			const prior: EngramEvent[] = [
				baseEvent("test_run", {
					command: "npm test",
					exitCode: 1,
					passed: false,
				}) as TestRunEvent,
			];
			const result = detectDerivedEvents(event, prior);
			expect(result.some((e) => e.type === "fix_attempt")).toBe(true);
		});

		it("returns progression for file_write of new file after passed test", () => {
			const event = baseEvent("file_write", {
				filePath: "/src/brand-new.ts",
				linesChanged: 10,
				evidenceSnippet: "",
			}) as FileWriteEvent;
			const prior: EngramEvent[] = [
				baseEvent("test_run", {
					command: "npm test",
					exitCode: 0,
					passed: true,
				}) as TestRunEvent,
			];
			const result = detectDerivedEvents(event, prior);
			expect(result.some((e) => e.type === "progression")).toBe(true);
		});

		it("does not return progression for file_write of already-written file after passed test", () => {
			const event = baseEvent("file_write", {
				filePath: "/src/existing.ts",
				linesChanged: 2,
				evidenceSnippet: "",
			}) as FileWriteEvent;
			const prior: EngramEvent[] = [
				baseEvent("test_run", {
					command: "npm test",
					exitCode: 0,
					passed: true,
				}) as TestRunEvent,
				baseEvent("file_write", {
					filePath: "/src/existing.ts",
					linesChanged: 3,
					evidenceSnippet: "",
				}) as FileWriteEvent,
			];
			const result = detectDerivedEvents(event, prior);
			expect(result.some((e) => e.type === "progression")).toBe(false);
		});

		it("returns repeated_revision when 3rd write to same path", () => {
			const event = baseEvent("file_write", {
				filePath: "/src/churn.ts",
				linesChanged: 1,
				evidenceSnippet: "",
			}) as FileWriteEvent;
			const prior: EngramEvent[] = [
				baseEvent("file_write", {
					filePath: "/src/churn.ts",
					linesChanged: 1,
					evidenceSnippet: "",
				}) as FileWriteEvent,
				baseEvent("file_write", {
					filePath: "/src/churn.ts",
					linesChanged: 2,
					evidenceSnippet: "",
				}) as FileWriteEvent,
			];
			const result = detectDerivedEvents(event, prior);
			const rr = result.find((e) => e.type === "repeated_revision");
			expect(rr).toBeDefined();
			expect((rr as { count: number }).count).toBe(3);
		});

		it("does not return repeated_revision for 2nd write to same path", () => {
			const event = baseEvent("file_write", {
				filePath: "/src/churn.ts",
				linesChanged: 1,
				evidenceSnippet: "",
			}) as FileWriteEvent;
			const prior: EngramEvent[] = [
				baseEvent("file_write", {
					filePath: "/src/churn.ts",
					linesChanged: 1,
					evidenceSnippet: "",
				}) as FileWriteEvent,
			];
			const result = detectDerivedEvents(event, prior);
			expect(result.some((e) => e.type === "repeated_revision")).toBe(false);
		});

		it("returns expanding_search for 5 reads across distant directories", () => {
			const priorPaths = ["/a/b/c.ts", "/x/y/z.ts", "/m/n/o.ts", "/p/q/r.ts"];
			const prior: EngramEvent[] = priorPaths.map(
				(fp) => baseEvent("file_read", { filePath: fp }) as FileReadEvent,
			);
			const event = baseEvent("file_read", {
				filePath: "/d/e/f.ts",
			}) as FileReadEvent;
			const result = detectDerivedEvents(event, prior);
			expect(result.some((e) => e.type === "expanding_search")).toBe(true);
		});

		it("does not return expanding_search for 5 reads in same directory", () => {
			const priorPaths = ["/src/a.ts", "/src/b.ts", "/src/c.ts", "/src/d.ts"];
			const prior: EngramEvent[] = priorPaths.map(
				(fp) => baseEvent("file_read", { filePath: fp }) as FileReadEvent,
			);
			const event = baseEvent("file_read", {
				filePath: "/src/e.ts",
			}) as FileReadEvent;
			const result = detectDerivedEvents(event, prior);
			expect(result.some((e) => e.type === "expanding_search")).toBe(false);
		});
	});

	describe("appendEvent + getSessionEvents", () => {
		let tmpDir: string;

		afterEach(() => {
			if (tmpDir) {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		function makeTmpDir(): string {
			tmpDir = path.join(os.tmpdir(), `engram-test-${crypto.randomUUID()}`);
			return tmpDir;
		}

		it("round-trips a single event", () => {
			const dir = makeTmpDir();
			const event: EngramEvent = {
				type: "file_read",
				sessionId: "sess-1",
				timestamp: new Date().toISOString(),
				filePath: "/test.ts",
			};
			appendEvent("sess-1", event, dir);
			const events = getSessionEvents("sess-1", dir);
			expect(events).toHaveLength(1);
			expect(events[0]).toEqual(event);
		});

		it("round-trips 3 events in order", () => {
			const dir = makeTmpDir();
			const events: EngramEvent[] = [
				{
					type: "file_read",
					sessionId: "s",
					timestamp: "2024-01-01T00:00:00Z",
					filePath: "/a.ts",
				},
				{
					type: "file_read",
					sessionId: "s",
					timestamp: "2024-01-01T00:00:01Z",
					filePath: "/b.ts",
				},
				{
					type: "build",
					sessionId: "s",
					timestamp: "2024-01-01T00:00:02Z",
					command: "tsc",
					exitCode: 0,
				},
			];
			for (const e of events) {
				appendEvent("s", e, dir);
			}
			const result = getSessionEvents("s", dir);
			expect(result).toHaveLength(3);
			expect(result).toEqual(events);
		});

		it("returns empty array for non-existent session", () => {
			const dir = makeTmpDir();
			fs.mkdirSync(dir, { recursive: true });
			const result = getSessionEvents("nonexistent", dir);
			expect(result).toEqual([]);
		});

		it("auto-creates the events/ subdirectory", () => {
			const dir = makeTmpDir();
			const event: EngramEvent = {
				type: "file_read",
				sessionId: "auto",
				timestamp: new Date().toISOString(),
				filePath: "/auto.ts",
			};
			appendEvent("auto", event, dir);
			expect(fs.existsSync(path.join(dir, "events"))).toBe(true);
		});

		it("does not throw on read-only directory path", () => {
			const dir = path.join(
				os.tmpdir(),
				`engram-readonly-${crypto.randomUUID()}`,
			);
			fs.mkdirSync(dir, { recursive: true });
			fs.chmodSync(dir, 0o444);
			tmpDir = dir;

			const event: EngramEvent = {
				type: "file_read",
				sessionId: "readonly",
				timestamp: new Date().toISOString(),
				filePath: "/ro.ts",
			};
			expect(() => appendEvent("readonly", event, dir)).not.toThrow();
			fs.chmodSync(dir, 0o755);
		});
	});

	describe("buildTurnCompleteEvent", () => {
		it("returns event with correct type, toolCallCount, and turnNumber", () => {
			const result = buildTurnCompleteEvent("sess-1", 5, 3);
			expect(result.type).toBe("turn_complete");
			expect(result.sessionId).toBe("sess-1");
			expect(result.toolCallCount).toBe(5);
			expect(result.turnNumber).toBe(3);
		});

		it("has a valid ISO timestamp", () => {
			const result = buildTurnCompleteEvent("sess-1", 1, 1);
			const parsed = new Date(result.timestamp);
			expect(parsed.getTime()).not.toBeNaN();
		});
	});
});
