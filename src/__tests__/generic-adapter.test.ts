import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/consolidation.js", () => ({
	findUnconsolidatedSessions: vi.fn(() => []),
	spawnConsolidation: vi.fn(),
}));

import {
	createSession,
	onPrompt,
	onSessionStart,
	onStop,
	onToolCall,
} from "../adapter.js";
import { createEdge, createNode } from "../db/graph.js";
import type { AdapterSession } from "../types.js";

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "engram-generic-adapter-"));
}

// ── Group 1: createSession ─────────────────────────────────────

describe("createSession", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates a session with explicit cwd", () => {
		const session = createSession({ cwd: tmpDir });
		try {
			expect(session.sessionId).toBeTruthy();
			expect(session.dataDir).toBeTruthy();
			expect(session.dbPath).toBeTruthy();
			expect(session.db).toBeTruthy();
			expect(typeof session.close).toBe("function");
		} finally {
			session.close();
			fs.rmSync(path.dirname(session.dataDir), {
				recursive: true,
				force: true,
			});
		}
	});

	it("initializes the DB schema (nodes table exists)", () => {
		const session = createSession({ cwd: tmpDir });
		try {
			const row = session.db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'",
				)
				.get() as { name: string } | undefined;
			expect(row?.name).toBe("nodes");
		} finally {
			session.close();
			fs.rmSync(path.dirname(session.dataDir), {
				recursive: true,
				force: true,
			});
		}
	});

	it("close() closes the DB without error", () => {
		const session = createSession({ cwd: tmpDir });
		try {
			expect(() => session.close()).not.toThrow();
			expect(() => session.db.prepare("SELECT 1").get()).toThrow();
		} finally {
			fs.rmSync(path.dirname(session.dataDir), {
				recursive: true,
				force: true,
			});
		}
	});

	it("uses process.cwd() when no config provided", () => {
		const session = createSession();
		try {
			expect(session.sessionId).toBeTruthy();
			expect(session.dataDir).toBeTruthy();
		} finally {
			session.close();
			fs.rmSync(path.dirname(session.dataDir), {
				recursive: true,
				force: true,
			});
		}
	});
});

// ── Group 2: onToolCall ────────────────────────────────────────

describe("onToolCall", () => {
	let tmpDir: string;
	let session: AdapterSession;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		session = createSession({ cwd: tmpDir });
	});
	afterEach(() => {
		session.close();
		fs.rmSync(path.dirname(session.dataDir), { recursive: true, force: true });
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("captures a file_read event from a Read tool call", () => {
		const result = onToolCall(session, {
			tool_name: "Read",
			tool_input: { file_path: "/tmp/foo.ts" },
			session_id: session.sessionId,
		});

		expect(result.events.length).toBeGreaterThan(0);
		expect(result.events.some((e) => e.type === "file_read")).toBe(true);
	});

	it("writes JSONL events file to dataDir/events/", () => {
		onToolCall(session, {
			tool_name: "Read",
			tool_input: { file_path: "/tmp/foo.ts" },
			session_id: session.sessionId,
		});

		const eventsDir = path.join(session.dataDir, "events");
		const files = fs.readdirSync(eventsDir).filter((f) => f.endsWith(".jsonl"));
		expect(files.length).toBeGreaterThan(0);

		const content = fs.readFileSync(path.join(eventsDir, files[0]!), "utf-8");
		expect(content.trim().length).toBeGreaterThan(0);
		const parsed = JSON.parse(content.trim().split("\n")[0]!);
		expect(parsed.type).toBe("file_read");
	});

	it("captures a file_write event from a Write tool call", () => {
		const result = onToolCall(session, {
			tool_name: "Write",
			tool_input: { file_path: "/tmp/bar.ts", content: "hello\nworld\n" },
			session_id: session.sessionId,
		});

		expect(result.events.some((e) => e.type === "file_write")).toBe(true);
	});

	it("returns empty result for an unknown tool", () => {
		const result = onToolCall(session, {
			tool_name: "SomeUnknownTool",
			tool_input: {},
			session_id: session.sessionId,
		});

		expect(result.events).toEqual([]);
		expect(result.context).toBe("");
	});
});

// ── Group 3: onSessionStart ────────────────────────────────────

describe("onSessionStart", () => {
	let tmpDir: string;
	let session: AdapterSession;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		session = createSession({ cwd: tmpDir });
	});
	afterEach(() => {
		session.close();
		fs.rmSync(path.dirname(session.dataDir), { recursive: true, force: true });
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns { context: string } on a fresh DB", () => {
		const result = onSessionStart(session);
		expect(result).toHaveProperty("context");
		expect(typeof result.context).toBe("string");
	});

	it("does not return retrieval context even when DB has connected nodes (retrieval removed)", () => {
		const srcDir = path.join(tmpDir, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(path.join(srcDir, "auth.ts"), "");
		fs.writeFileSync(path.join(srcDir, "token.ts"), "");

		const absAuth = path.join(srcDir, "auth.ts");
		const absToken = path.join(srcDir, "token.ts");

		const entryNode = createNode(session.db, {
			name: "AuthModule",
			nodeType: "concept",
			description: "Authentication module",
			affectedFiles: [absAuth],
			strength: 1.0,
			metadata: {},
		});
		const connectedNode = createNode(session.db, {
			name: "TokenStore",
			nodeType: "pattern",
			description: "Token storage pattern",
			affectedFiles: [absToken],
			strength: 1.0,
			metadata: {},
		});
		createEdge(session.db, {
			sourceNodeId: entryNode.id,
			targetNodeId: connectedNode.id,
			relationshipType: "uses",
			weight: 0.9,
			metadata: {},
		});

		const eventsDir = path.join(session.dataDir, "events");
		fs.mkdirSync(eventsDir, { recursive: true });
		const fakeSessionId = "prior-session-001";
		const event = {
			type: "file_write",
			sessionId: fakeSessionId,
			timestamp: new Date().toISOString(),
			filePath: absAuth,
			linesChanged: 10,
			evidenceSnippet: "const auth = ...",
		};
		fs.writeFileSync(
			path.join(eventsDir, `${fakeSessionId}.jsonl`),
			`${JSON.stringify(event)}\n`,
		);

		const newSession = createSession({ cwd: tmpDir });
		try {
			const result = onSessionStart(newSession);
			expect(result.context).not.toContain("TokenStore");
		} finally {
			newSession.close();
		}
	});
});

// ── Group 4: onPrompt ──────────────────────────────────────────

describe("onPrompt", () => {
	let tmpDir: string;
	let session: AdapterSession;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		session = createSession({ cwd: tmpDir });
	});
	afterEach(() => {
		session.close();
		fs.rmSync(path.dirname(session.dataDir), { recursive: true, force: true });
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty context when no entry points found in prompt", () => {
		const result = onPrompt(session, "just a simple question");
		expect(result.context).toBe("");
	});

	it("returns context referencing connected nodes when prompt mentions entry file", () => {
		const entryNode = createNode(session.db, {
			name: "FooModule",
			nodeType: "concept",
			description: "The Foo module handles foo logic",
			affectedFiles: ["src/foo.ts"],
			strength: 1.0,
			metadata: {},
		});
		const connectedNode = createNode(session.db, {
			name: "FooHelper",
			nodeType: "pattern",
			description: "Helper utilities for Foo",
			affectedFiles: ["src/foo-helper.ts"],
			strength: 1.0,
			metadata: {},
		});
		createEdge(session.db, {
			sourceNodeId: entryNode.id,
			targetNodeId: connectedNode.id,
			relationshipType: "uses",
			weight: 0.9,
			metadata: {},
		});

		const result = onPrompt(session, "look at src/foo.ts");
		expect(result.context.length).toBeGreaterThan(0);
		expect(result.context).toContain("FooHelper");
	});

	it("returns context for connected nodes via spreading activation", () => {
		const nodeA = createNode(session.db, {
			name: "NodeA",
			nodeType: "concept",
			description: "Primary node A",
			affectedFiles: ["src/a.ts"],
			strength: 1.0,
			metadata: {},
		});
		const nodeB = createNode(session.db, {
			name: "NodeB",
			nodeType: "pattern",
			description: "Connected node B",
			affectedFiles: ["src/b.ts"],
			strength: 0.9,
			metadata: {},
		});
		createEdge(session.db, {
			sourceNodeId: nodeA.id,
			targetNodeId: nodeB.id,
			relationshipType: "relates_to",
			weight: 0.8,
			metadata: {},
		});

		const result = onPrompt(session, "look at src/a.ts");
		expect(result.context.length).toBeGreaterThan(0);
		expect(result.context).toContain("NodeB");
	});
});

// ── Group 5: onStop ────────────────────────────────────────────

describe("onStop", () => {
	let tmpDir: string;
	let session: AdapterSession;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		session = createSession({ cwd: tmpDir });
	});
	afterEach(() => {
		session.close();
		fs.rmSync(path.dirname(session.dataDir), { recursive: true, force: true });
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("completes without error after tool calls", () => {
		onToolCall(session, {
			tool_name: "Read",
			tool_input: { file_path: "/tmp/a.ts" },
			session_id: session.sessionId,
		});
		onToolCall(session, {
			tool_name: "Write",
			tool_input: { file_path: "/tmp/b.ts", content: "x" },
			session_id: session.sessionId,
		});

		expect(() => onStop(session)).not.toThrow();
	});

	it("appends a turn_complete event to the JSONL file", () => {
		onToolCall(session, {
			tool_name: "Read",
			tool_input: { file_path: "/tmp/a.ts" },
			session_id: session.sessionId,
		});

		onStop(session);

		const eventsDir = path.join(session.dataDir, "events");
		const jsonlFile = path.join(eventsDir, `${session.sessionId}.jsonl`);
		const content = fs.readFileSync(jsonlFile, "utf-8");
		const lines = content.trim().split("\n");
		const events = lines.map((l) => JSON.parse(l));
		expect(
			events.some((e: { type: string }) => e.type === "turn_complete"),
		).toBe(true);
	});
});

// ── Group 6: No Claude Code imports ────────────────────────────

describe("no Claude Code imports in this test file", () => {
	it("does not import from src/adapters/claude-code/", () => {
		const thisFile = fs.readFileSync(
			new URL(import.meta.url).pathname,
			"utf-8",
		);
		const lines = thisFile.split("\n").filter((l) => l.startsWith("import "));
		for (const line of lines) {
			expect(line).not.toContain("adapters/claude-code");
		}
	});
});
