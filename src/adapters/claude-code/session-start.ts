#!/usr/bin/env node
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getMaintenanceConfig, loadConfig } from "../../core/config.js";
import {
	findFailedConsolidations,
	findUnconsolidatedSessions,
	spawnConsolidation,
} from "../../core/consolidation.js";
import { runMaintenance } from "../../core/maintenance.js";
import {
	ensureDataDirs,
	getDataDir,
	getDbPath,
} from "../../core/project-identity.js";
import {
	type SessionState,
	saveSessionState,
} from "../../core/session-state.js";
import { initializeSchema } from "../../db/migrations.js";

function logError(dataDir: string, message: string): void {
	try {
		const logDir = join(dataDir, "logs");
		mkdirSync(logDir, { recursive: true });
		appendFileSync(
			join(logDir, "session-start.log"),
			`[${new Date().toISOString()}] ${message}\n`,
		);
	} catch {
		// logging itself must never throw
	}
}

export function processSessionStart(
	sessionId: string,
	dataDir: string,
	dbPath: string,
): Record<string, unknown> {
	const db = initializeSchema(dbPath);

	let maintenanceSummary = "";
	try {
		const config = loadConfig();
		const maintConfig = getMaintenanceConfig(config);
		const maintResult = runMaintenance(db, dataDir, maintConfig);
		if (!maintResult.skipped) {
			maintenanceSummary = `[engram] Maintenance: pruned ${maintResult.nodesPruned} stale nodes, ${maintResult.patternsCreated} patterns created, ${maintResult.filesSuperseded} files superseded (${maintResult.durationMs}ms)\n\n`;
		}
	} catch {
		// maintenance must never block session start
	}

	const unconsolidated = findUnconsolidatedSessions(dataDir);
	for (const oldSessionId of unconsolidated) {
		spawnConsolidation(oldSessionId, dbPath, dataDir);
	}

	const defaultState: SessionState = {
		seenFiles: [],
		contradictionFailures: 0,
		contradictionDisabled: false,
		pendingContradictions: [],
		turnCount: 0,
		toolCallCount: 0,
	};
	saveSessionState(dataDir, sessionId, defaultState);

	try {
		writeFileSync(join(dataDir, "events", `${sessionId}.injected.json`), "[]");
	} catch {
		// P004: injected.json reset must never throw
	}

	let additionalContext = "";
	try {
		const failures = findFailedConsolidations(dataDir);
		if (failures.length > 0) {
			const lastError = failures.reduce((a, b) =>
				a.timestamp > b.timestamp ? a : b,
			);
			additionalContext += `[engram] Warning: ${failures.length} previous consolidation(s) failed. Recent error: ${lastError.error}\nRun "engram status" for details or delete .engram/episodes/*.failed.json to retry.\n\n`;
		}
	} catch {
		// P004: failure marker reading must never throw
	}
	db.close();

	if (maintenanceSummary) {
		additionalContext = maintenanceSummary + additionalContext;
	}

	if (additionalContext) {
		return {
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext,
			},
		};
	}
	return {};
}

function main(): void {
	try {
		const stdin = readFileSync(0, "utf-8");
		const input = JSON.parse(stdin) as Record<string, unknown>;

		const cwd = (input.cwd as string) ?? process.cwd();
		const sessionId = input.session_id as string;

		const dataDir = ensureDataDirs(cwd);
		const dbPath = getDbPath(cwd);

		const result = processSessionStart(sessionId, dataDir, dbPath);
		process.stdout.write(JSON.stringify(result));
		process.exit(0);
	} catch (err) {
		try {
			const cwd = process.cwd();
			const dataDir = getDataDir(cwd);
			logError(
				dataDir,
				`SessionStart handler error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
			);
		} catch {
			// final fallback
		}
		process.stdout.write("{}");
		process.exit(0);
	}
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	main();
}
