import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContradictionResult } from "../types.js";

export type SessionState = {
	seenFiles: string[];
	contradictionFailures: number;
	contradictionDisabled: boolean;
	pendingContradictions: ContradictionResult[];
	turnCount: number;
	toolCallCount: number;
	lastUserPrompt?: string;
	consolidationSpawned?: boolean;
};

function defaultState(): SessionState {
	return {
		seenFiles: [],
		contradictionFailures: 0,
		contradictionDisabled: false,
		pendingContradictions: [],
		turnCount: 0,
		toolCallCount: 0,
	};
}

export function loadSessionState(
	dataDir: string,
	sessionId: string,
): SessionState {
	try {
		const filePath = join(dataDir, "sessions", `${sessionId}.json`);
		const raw = readFileSync(filePath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed)
		) {
			return defaultState();
		}
		const obj = parsed as Record<string, unknown>;
		const defaults = defaultState();
		const state: SessionState = {
			seenFiles: Array.isArray(obj.seenFiles)
				? (obj.seenFiles as string[])
				: defaults.seenFiles,
			contradictionFailures:
				typeof obj.contradictionFailures === "number"
					? obj.contradictionFailures
					: defaults.contradictionFailures,
			contradictionDisabled:
				typeof obj.contradictionDisabled === "boolean"
					? obj.contradictionDisabled
					: defaults.contradictionDisabled,
			pendingContradictions: Array.isArray(obj.pendingContradictions)
				? (obj.pendingContradictions as ContradictionResult[])
				: defaults.pendingContradictions,
			turnCount:
				typeof obj.turnCount === "number" ? obj.turnCount : defaults.turnCount,
			toolCallCount:
				typeof obj.toolCallCount === "number"
					? obj.toolCallCount
					: defaults.toolCallCount,
		};
		if (typeof obj.lastUserPrompt === "string")
			state.lastUserPrompt = obj.lastUserPrompt;
		if (typeof obj.consolidationSpawned === "boolean")
			state.consolidationSpawned = obj.consolidationSpawned;
		return state;
	} catch {
		return defaultState();
	}
}

export function saveSessionState(
	dataDir: string,
	sessionId: string,
	state: SessionState,
): void {
	try {
		const filePath = join(dataDir, "sessions", `${sessionId}.json`);
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, JSON.stringify(state, null, 2));
	} catch {
		// never throw — file write failures are swallowed
	}
}
