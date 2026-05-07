import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	BuildEvent,
	DecisionEvent,
	EngramEvent,
	ExpandingSearchEvent,
	ExplorationEvent,
	FileReadEvent,
	FileWriteEvent,
	FixAttemptEvent,
	ProgressionEvent,
	RawToolCall,
	RepeatedRevisionEvent,
	ResearchEvent,
	TestRunEvent,
	TurnCompleteEvent,
} from "../types.js";

function truncateToLines(text: string, maxLines: number): string {
	const lines = text.split("\n");
	return lines.slice(0, maxLines).join("\n");
}

function formatEditSnippet(oldString: string, newString: string): string {
	return `--- before\n${truncateToLines(oldString, 5)}\n+++ after\n${truncateToLines(newString, 5)}`;
}

function countNewlines(text: string): number {
	let count = 0;
	for (const ch of text) {
		if (ch === "\n") count++;
	}
	return count;
}

const TEST_PATTERN =
	/\b(npm\s+test|vitest|jest|node\s+--test|pytest|go\s+test|cargo\s+test)\b/i;
const BUILD_PATTERN =
	/\b(npm\s+run\s+build|tsc|make\b|cargo\s+build|go\s+build|webpack)\b/i;

export function classifyToolCall(toolCall: RawToolCall): EngramEvent | null {
	const { tool_name, tool_input, session_id } = toolCall;
	const sessionId = session_id;
	const timestamp = new Date().toISOString();

	if (tool_name === "Read" || tool_name === "View") {
		return {
			type: "file_read",
			sessionId,
			timestamp,
			filePath: tool_input.file_path as string,
		} satisfies FileReadEvent;
	}

	if (tool_name === "Write") {
		const content = (tool_input.content as string) ?? "";
		return {
			type: "file_write",
			sessionId,
			timestamp,
			filePath: tool_input.file_path as string,
			linesChanged: countNewlines(content),
			evidenceSnippet: truncateToLines(content, 10),
		} satisfies FileWriteEvent;
	}

	if (tool_name === "Edit" || tool_name === "MultiEdit") {
		const oldString = (tool_input.old_string as string) ?? "";
		const newString = (tool_input.new_string as string) ?? "";
		return {
			type: "file_write",
			sessionId,
			timestamp,
			filePath: tool_input.file_path as string,
			linesChanged: countNewlines(newString),
			evidenceSnippet: formatEditSnippet(oldString, newString),
		} satisfies FileWriteEvent;
	}

	if (tool_name === "Bash") {
		const command = (tool_input.command as string) ?? "";
		const exitCode =
			typeof tool_input.exit_code === "number" ? tool_input.exit_code : 0;

		if (TEST_PATTERN.test(command)) {
			return {
				type: "test_run",
				sessionId,
				timestamp,
				command,
				exitCode,
				passed: exitCode === 0,
			} satisfies TestRunEvent;
		}

		if (BUILD_PATTERN.test(command)) {
			return {
				type: "build",
				sessionId,
				timestamp,
				command,
				exitCode,
			} satisfies BuildEvent;
		}

		return null;
	}

	if (tool_name === "WebSearch" || tool_name === "WebFetch") {
		return {
			type: "research",
			sessionId,
			timestamp,
			query:
				(tool_input.query as string) ?? (tool_input.command as string) ?? "",
		} satisfies ResearchEvent;
	}

	if (tool_name.toLowerCase().includes("decision")) {
		return {
			type: "decision",
			sessionId,
			timestamp,
			content: (tool_input.content as string) ?? "",
			rationale: (tool_input.rationale as string) ?? "",
			affectedFiles: (tool_input.affectedFiles as string[]) ?? [],
		} satisfies DecisionEvent;
	}

	return null;
}

export function detectDerivedEvents(
	primaryEvent: EngramEvent,
	priorEvents: EngramEvent[],
): EngramEvent[] {
	const derived: EngramEvent[] = [];
	const { sessionId, timestamp } = primaryEvent;

	if (primaryEvent.type === "file_read") {
		const priorReadPaths = new Set(
			priorEvents
				.filter(
					(e): e is Extract<EngramEvent, { type: "file_read" }> =>
						e.type === "file_read",
				)
				.map((e) => e.filePath),
		);
		if (!priorReadPaths.has(primaryEvent.filePath)) {
			derived.push({
				type: "exploration",
				sessionId,
				timestamp,
				filePath: primaryEvent.filePath,
			} satisfies ExplorationEvent);
		}

		const priorReadFilePaths = priorEvents
			.filter(
				(e): e is Extract<EngramEvent, { type: "file_read" }> =>
					e.type === "file_read",
			)
			.map((e) => e.filePath);
		const allReadPaths = [...priorReadFilePaths, primaryEvent.filePath];
		if (allReadPaths.length >= 5) {
			const last5 = allReadPaths.slice(-5);
			if (maxDirectoryDistance(last5) > 2) {
				derived.push({
					type: "expanding_search",
					sessionId,
					timestamp,
					filePaths: last5,
				} satisfies ExpandingSearchEvent);
			}
		}
	}

	if (primaryEvent.type === "file_write") {
		const mostRecentTestRun = findLastOfType(priorEvents, "test_run") as
			| TestRunEvent
			| undefined;

		if (mostRecentTestRun && !mostRecentTestRun.passed) {
			derived.push({
				type: "fix_attempt",
				sessionId,
				timestamp,
				filePath: primaryEvent.filePath,
			} satisfies FixAttemptEvent);
		}

		const priorWritePaths = priorEvents
			.filter(
				(e): e is Extract<EngramEvent, { type: "file_write" }> =>
					e.type === "file_write",
			)
			.map((e) => e.filePath);

		if (
			!priorWritePaths.includes(primaryEvent.filePath) &&
			mostRecentTestRun?.passed
		) {
			derived.push({
				type: "progression",
				sessionId,
				timestamp,
				filePath: primaryEvent.filePath,
			} satisfies ProgressionEvent);
		}

		const priorWriteCount = priorEvents.filter(
			(e): e is Extract<EngramEvent, { type: "file_write" }> =>
				e.type === "file_write" && e.filePath === primaryEvent.filePath,
		).length;
		if (priorWriteCount >= 2) {
			derived.push({
				type: "repeated_revision",
				sessionId,
				timestamp,
				filePath: primaryEvent.filePath,
				count: priorWriteCount + 1,
			} satisfies RepeatedRevisionEvent);
		}
	}

	return derived;
}

function findLastOfType(
	events: EngramEvent[],
	type: string,
): EngramEvent | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i]!.type === type) return events[i];
	}
	return undefined;
}

function maxDirectoryDistance(filePaths: string[]): number {
	let max = 0;
	const segmentSets = filePaths.map((p) => p.split("/").slice(0, -1));
	for (let i = 0; i < segmentSets.length; i++) {
		for (let j = i + 1; j < segmentSets.length; j++) {
			const a = segmentSets[i]!;
			const b = segmentSets[j]!;
			let commonLen = 0;
			while (
				commonLen < a.length &&
				commonLen < b.length &&
				a[commonLen] === b[commonLen]
			) {
				commonLen++;
			}
			const uniqueA = a.length - commonLen;
			const uniqueB = b.length - commonLen;
			const dist = uniqueA + uniqueB;
			if (dist > max) max = dist;
		}
	}
	return max;
}

export function appendEvent(
	sessionId: string,
	event: EngramEvent,
	dataDir?: string,
): void {
	try {
		const base = dataDir ?? path.join(os.homedir(), ".engram");
		const dir = path.join(base, "events");
		fs.mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, `${sessionId}.jsonl`);
		fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`);
	} catch (err) {
		console.error("engram: appendEvent failed:", err);
	}
}

export function getSessionEvents(
	sessionId: string,
	dataDir?: string,
): EngramEvent[] {
	const base = dataDir ?? path.join(os.homedir(), ".engram");
	const filePath = path.join(base, "events", `${sessionId}.jsonl`);
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch (err: unknown) {
		if (
			err instanceof Error &&
			"code" in err &&
			(err as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return [];
		}
		throw err;
	}
	const events: EngramEvent[] = [];
	for (const line of content.split("\n")) {
		if (line.trim() === "") continue;
		try {
			events.push(JSON.parse(line) as EngramEvent);
		} catch {
			console.warn("engram: skipping malformed JSONL line");
		}
	}
	return events;
}

export function buildTurnCompleteEvent(
	sessionId: string,
	toolCallCount: number,
	turnNumber: number,
	options?: { userMessage?: string; agentSummary?: string },
): TurnCompleteEvent {
	const event: TurnCompleteEvent = {
		type: "turn_complete",
		sessionId,
		timestamp: new Date().toISOString(),
		toolCallCount,
		turnNumber,
	};
	if (options?.userMessage !== undefined)
		event.userMessage = options.userMessage;
	if (options?.agentSummary !== undefined)
		event.agentSummary = options.agentSummary;
	return event;
}
