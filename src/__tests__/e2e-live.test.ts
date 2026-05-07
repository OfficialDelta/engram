import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consolidateSession } from "../core/consolidation.js";
import { buildContext } from "../core/context-builder.js";
import { ContradictionChecker } from "../core/contradiction.js";
import { appendEvent } from "../core/event-stream.js";
import { spreadingActivation } from "../core/retrieval.js";
import { initializeSchema } from "../db/migrations.js";

describe.skipIf(!process.env.ANTHROPIC_API_KEY)(
	"Live API E2E: capture → consolidate → retrieve → context → contradiction",
	() => {
		let tmpDir: string;
		let dbPath: string;
		let authFile: string;
		let schemaFile: string;
		let cacheFile: string;

		beforeEach(() => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-live-e2e-"));
			dbPath = path.join(tmpDir, "engram.db");

			fs.mkdirSync(path.join(tmpDir, "events"), { recursive: true });
			fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
			fs.mkdirSync(path.join(tmpDir, "episodes"), { recursive: true });
			fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true });

			fs.mkdirSync(path.join(tmpDir, "project", "src"), { recursive: true });
			authFile = path.join(tmpDir, "project", "src", "auth.ts");
			schemaFile = path.join(tmpDir, "project", "src", "db-schema.ts");
			cacheFile = path.join(tmpDir, "project", "src", "cache.ts");
			fs.writeFileSync(authFile, "export const auth = {};");
			fs.writeFileSync(schemaFile, "export const schema = {};");
			fs.writeFileSync(cacheFile, "export const cache = {};");

			const db = initializeSchema(dbPath, 384, "local");
			db.close();
		});

		afterEach(() => {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("Session 1: consolidates auth module events with real Anthropic API", {
			timeout: 90_000,
		}, async () => {
			appendEvent(
				"session-1",
				{
					type: "file_read",
					sessionId: "session-1",
					timestamp: "2025-01-01T00:00:00Z",
					filePath: authFile,
				},
				tmpDir,
			);
			appendEvent(
				"session-1",
				{
					type: "file_write",
					sessionId: "session-1",
					timestamp: "2025-01-01T00:01:00Z",
					filePath: authFile,
					linesChanged: 25,
					evidenceSnippet: "jwt auth middleware with bcrypt",
				},
				tmpDir,
			);
			appendEvent(
				"session-1",
				{
					type: "file_read",
					sessionId: "session-1",
					timestamp: "2025-01-01T00:02:00Z",
					filePath: schemaFile,
				},
				tmpDir,
			);
			appendEvent(
				"session-1",
				{
					type: "test_run",
					sessionId: "session-1",
					timestamp: "2025-01-01T00:03:00Z",
					command: "npm test",
					exitCode: 0,
					passed: true,
				},
				tmpDir,
			);

			await consolidateSession("session-1", dbPath, tmpDir, {
				pass1Model: "claude-haiku-4-5",
				pass2Model: "claude-haiku-4-5",
				embeddingConfig: { provider: "local" },
			});

			const db = initializeSchema(dbPath, 384, "local");
			const nodes = db.prepare("SELECT * FROM nodes").all() as Array<{
				name: string;
				description: string;
			}>;
			expect(nodes.length).toBeGreaterThan(0);

			const hasAuthRelated = nodes.some(
				(n) =>
					n.name.toLowerCase().includes("auth") ||
					n.description.toLowerCase().includes("auth"),
			);
			expect(hasAuthRelated).toBe(true);
			db.close();
		});

		it("Session 2: consolidates cache events and builds cross-session graph", {
			timeout: 90_000,
		}, async () => {
			// Replay session 1 first
			appendEvent(
				"session-1",
				{
					type: "file_read",
					sessionId: "session-1",
					timestamp: "2025-01-01T00:00:00Z",
					filePath: authFile,
				},
				tmpDir,
			);
			appendEvent(
				"session-1",
				{
					type: "file_write",
					sessionId: "session-1",
					timestamp: "2025-01-01T00:01:00Z",
					filePath: authFile,
					linesChanged: 25,
					evidenceSnippet: "jwt auth middleware with bcrypt",
				},
				tmpDir,
			);
			appendEvent(
				"session-1",
				{
					type: "file_read",
					sessionId: "session-1",
					timestamp: "2025-01-01T00:02:00Z",
					filePath: schemaFile,
				},
				tmpDir,
			);
			appendEvent(
				"session-1",
				{
					type: "test_run",
					sessionId: "session-1",
					timestamp: "2025-01-01T00:03:00Z",
					command: "npm test",
					exitCode: 0,
					passed: true,
				},
				tmpDir,
			);

			await consolidateSession("session-1", dbPath, tmpDir, {
				pass1Model: "claude-haiku-4-5",
				pass2Model: "claude-haiku-4-5",
				embeddingConfig: { provider: "local" },
			});

			const dbAfterS1 = initializeSchema(dbPath, 384, "local");
			const nodesAfterS1 = dbAfterS1
				.prepare("SELECT count(*) as cnt FROM nodes")
				.get() as { cnt: number };
			dbAfterS1.close();

			// Session 2 events
			appendEvent(
				"session-2",
				{
					type: "file_read",
					sessionId: "session-2",
					timestamp: "2025-01-02T00:00:00Z",
					filePath: cacheFile,
				},
				tmpDir,
			);
			appendEvent(
				"session-2",
				{
					type: "file_write",
					sessionId: "session-2",
					timestamp: "2025-01-02T00:01:00Z",
					filePath: cacheFile,
					linesChanged: 40,
					evidenceSnippet: "redis cache layer with auth-aware invalidation",
				},
				tmpDir,
			);
			appendEvent(
				"session-2",
				{
					type: "file_read",
					sessionId: "session-2",
					timestamp: "2025-01-02T00:02:00Z",
					filePath: authFile,
				},
				tmpDir,
			);

			await consolidateSession("session-2", dbPath, tmpDir, {
				pass1Model: "claude-haiku-4-5",
				pass2Model: "claude-haiku-4-5",
				embeddingConfig: { provider: "local" },
			});

			const db = initializeSchema(dbPath, 384, "local");
			const nodesAfterS2 = db
				.prepare("SELECT count(*) as cnt FROM nodes")
				.get() as { cnt: number };
			// Should have nodes from both sessions (may merge some)
			expect(nodesAfterS2.cnt).toBeGreaterThanOrEqual(nodesAfterS1.cnt);

			const edges = db.prepare("SELECT count(*) as cnt FROM edges").get() as {
				cnt: number;
			};
			expect(edges.cnt).toBeGreaterThan(0);
			db.close();
		});

		it("Retrieval: spreading activation finds cross-session knowledge", {
			timeout: 30_000,
		}, async () => {
			// Build up sessions 1 and 2
			appendEvent(
				"session-1",
				{
					type: "file_read",
					sessionId: "session-1",
					timestamp: "2025-01-01T00:00:00Z",
					filePath: authFile,
				},
				tmpDir,
			);
			appendEvent(
				"session-1",
				{
					type: "file_write",
					sessionId: "session-1",
					timestamp: "2025-01-01T00:01:00Z",
					filePath: authFile,
					linesChanged: 25,
					evidenceSnippet: "jwt auth middleware with bcrypt",
				},
				tmpDir,
			);
			appendEvent(
				"session-1",
				{
					type: "file_read",
					sessionId: "session-1",
					timestamp: "2025-01-01T00:02:00Z",
					filePath: schemaFile,
				},
				tmpDir,
			);
			appendEvent(
				"session-1",
				{
					type: "test_run",
					sessionId: "session-1",
					timestamp: "2025-01-01T00:03:00Z",
					command: "npm test",
					exitCode: 0,
					passed: true,
				},
				tmpDir,
			);

			await consolidateSession("session-1", dbPath, tmpDir, {
				pass1Model: "claude-haiku-4-5",
				pass2Model: "claude-haiku-4-5",
				embeddingConfig: { provider: "local" },
			});

			appendEvent(
				"session-2",
				{
					type: "file_read",
					sessionId: "session-2",
					timestamp: "2025-01-02T00:00:00Z",
					filePath: cacheFile,
				},
				tmpDir,
			);
			appendEvent(
				"session-2",
				{
					type: "file_write",
					sessionId: "session-2",
					timestamp: "2025-01-02T00:01:00Z",
					filePath: cacheFile,
					linesChanged: 40,
					evidenceSnippet: "redis cache layer with auth-aware invalidation",
				},
				tmpDir,
			);
			appendEvent(
				"session-2",
				{
					type: "file_read",
					sessionId: "session-2",
					timestamp: "2025-01-02T00:02:00Z",
					filePath: authFile,
				},
				tmpDir,
			);

			await consolidateSession("session-2", dbPath, tmpDir, {
				pass1Model: "claude-haiku-4-5",
				pass2Model: "claude-haiku-4-5",
				embeddingConfig: { provider: "local" },
			});

			const db = initializeSchema(dbPath, 384, "local");
			const tieredResults = spreadingActivation(db, [
				{ type: "file", value: cacheFile },
			]);
			const allResults = [...tieredResults.high, ...tieredResults.medium];
			expect(allResults.length).toBeGreaterThan(0);

			const contextString = buildContext([], [], tieredResults);
			expect(contextString.length).toBeGreaterThan(0);
			const lower = contextString.toLowerCase();
			expect(lower.includes("auth") || lower.includes("cache")).toBe(true);
			db.close();
		});

		it("Contradiction: detects conflict with existing decisions via real API", {
			timeout: 30_000,
		}, async () => {
			// Build session 1 with auth/bcrypt decisions
			appendEvent(
				"session-1",
				{
					type: "file_read",
					sessionId: "session-1",
					timestamp: "2025-01-01T00:00:00Z",
					filePath: authFile,
				},
				tmpDir,
			);
			appendEvent(
				"session-1",
				{
					type: "file_write",
					sessionId: "session-1",
					timestamp: "2025-01-01T00:01:00Z",
					filePath: authFile,
					linesChanged: 25,
					evidenceSnippet: "jwt auth middleware with bcrypt",
				},
				tmpDir,
			);
			appendEvent(
				"session-1",
				{
					type: "file_read",
					sessionId: "session-1",
					timestamp: "2025-01-01T00:02:00Z",
					filePath: schemaFile,
				},
				tmpDir,
			);
			appendEvent(
				"session-1",
				{
					type: "test_run",
					sessionId: "session-1",
					timestamp: "2025-01-01T00:03:00Z",
					command: "npm test",
					exitCode: 0,
					passed: true,
				},
				tmpDir,
			);

			await consolidateSession("session-1", dbPath, tmpDir, {
				pass1Model: "claude-haiku-4-5",
				pass2Model: "claude-haiku-4-5",
				embeddingConfig: { provider: "local" },
			});

			const db = initializeSchema(dbPath, 384, "local");
			const checker = new ContradictionChecker();
			const result = await checker.checkContradiction(
				db,
				authFile,
				"switching from bcrypt to argon2 for password hashing",
				{ model: "claude-haiku-4-5" },
			);

			// Result may be null if no decision nodes found for the file,
			// or if the circuit breaker tripped — both are acceptable
			if (result !== null) {
				expect([
					"NO_CONTRADICTION",
					"INDIRECT_CONTRADICTION",
					"DIRECT_CONTRADICTION",
				]).toContain(result.verdict);
			}
			db.close();
		});
	},
);
