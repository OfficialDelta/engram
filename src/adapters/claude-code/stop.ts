#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	appendEvent,
	buildTurnCompleteEvent,
} from "../../core/event-stream.js";
import {
	ensureDataDirs,
	getDataDir,
	getDbPath,
} from "../../core/project-identity.js";
import {
	loadSessionState,
	saveSessionState,
} from "../../core/session-state.js";

function logError(dataDir: string, message: string): void {
	try {
		const logDir = join(dataDir, "logs");
		mkdirSync(logDir, { recursive: true });
		appendFileSync(
			join(logDir, "stop.log"),
			`[${new Date().toISOString()}] ${message}\n`,
		);
	} catch {
		// logging itself must never throw
	}
}

export function processStop(
	sessionId: string,
	dataDir: string,
	_dbPath: string,
	options?: { userMessage?: string; agentSummary?: string },
): Record<string, unknown> {
	const state = loadSessionState(dataDir, sessionId);
	state.turnCount++;

	const userMessage = options?.userMessage ?? state.lastUserPrompt;
	const turnEvent = buildTurnCompleteEvent(
		sessionId,
		state.toolCallCount,
		state.turnCount,
		{
			...(userMessage !== undefined ? { userMessage } : {}),
			...(options?.agentSummary !== undefined
				? { agentSummary: options.agentSummary }
				: {}),
		},
	);
	appendEvent(sessionId, turnEvent, dataDir);

	state.toolCallCount = 0;
	delete state.lastUserPrompt;
	saveSessionState(dataDir, sessionId, state);

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

		const conversation = (input.conversation ?? input.messages) as
			| Array<{ role: string; content: string }>
			| undefined;
		let agentSummary: string | undefined;
		if (Array.isArray(conversation)) {
			const lastAssistant = [...conversation]
				.reverse()
				.find((m) => m.role === "assistant");
			if (lastAssistant?.content) {
				agentSummary = lastAssistant.content.slice(0, 200);
			}
		}

		processStop(
			sessionId,
			dataDir,
			dbPath,
			agentSummary !== undefined ? { agentSummary } : undefined,
		);
		process.stdout.write("{}");
		process.exit(0);
	} catch (err) {
		try {
			const cwd = process.cwd();
			const dataDir = getDataDir(cwd);
			logError(
				dataDir,
				`Stop handler error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
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
