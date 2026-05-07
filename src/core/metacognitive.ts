import { appendFileSync, mkdirSync } from "node:fs";
import path, { join } from "node:path";
import type {
	EngramEvent,
	ErrorRepetition,
	MetricResults,
	ProgressVelocity,
	SearchToActRatio,
} from "../types.js";

export function progressVelocity(events: EngramEvent[]): ProgressVelocity {
	if (events.length === 0) {
		return {
			currentVelocity: 0,
			trend: "stable",
			uniqueFilesWritten: 0,
			windowSize: 0,
		};
	}

	const window = events.slice(-20);
	const windowSize = window.length;

	const writtenFiles = new Set<string>();
	for (const event of window) {
		if (event.type === "file_write") {
			writtenFiles.add(event.filePath);
		}
	}
	const uniqueFilesWritten = writtenFiles.size;

	const mid = Math.floor(windowSize / 2);
	const firstHalf = window.slice(0, mid);
	const secondHalf = window.slice(mid);

	const firstHalfFiles = new Set<string>();
	for (const event of firstHalf) {
		if (event.type === "file_write") firstHalfFiles.add(event.filePath);
	}

	const secondHalfFiles = new Set<string>();
	for (const event of secondHalf) {
		if (event.type === "file_write") secondHalfFiles.add(event.filePath);
	}

	let trend: "increasing" | "stable" | "declining";
	if (secondHalfFiles.size < firstHalfFiles.size) {
		trend = "declining";
	} else if (secondHalfFiles.size > firstHalfFiles.size) {
		trend = "increasing";
	} else {
		trend = "stable";
	}

	const currentVelocity = uniqueFilesWritten / windowSize;

	return { currentVelocity, trend, uniqueFilesWritten, windowSize };
}

export function searchToActRatio(events: EngramEvent[]): SearchToActRatio {
	let reads = 0;
	let writes = 0;

	for (const event of events) {
		if (
			event.type === "file_read" ||
			event.type === "research" ||
			event.type === "exploration"
		) {
			reads++;
		} else if (event.type === "file_write") {
			writes++;
		}
	}

	const ratio = reads / (writes || 1);
	const progressFraction = Math.min(events.length, 20) / 20;

	const mid = Math.floor(events.length / 2);
	const secondHalf = events.slice(mid);
	const dirs = new Set<string>();
	for (const event of secondHalf) {
		if (event.type === "file_read") {
			dirs.add(path.dirname(event.filePath));
		}
	}
	const directorySpread = dirs.size;

	const isConcerning =
		ratio > 5.0 && progressFraction > 0.5 && directorySpread > 3;

	return {
		ratio,
		isConcerning,
		reads,
		writes,
		progressFraction,
		directorySpread,
	};
}

export function errorRepetition(events: EngramEvent[]): ErrorRepetition {
	const cycleCounts = new Map<string, number>();
	const pendingFixes = new Set<string>();

	for (const event of events) {
		if (event.type === "fix_attempt") {
			pendingFixes.add(event.filePath);
		} else if (event.type === "test_run") {
			if (!event.passed) {
				for (const file of pendingFixes) {
					cycleCounts.set(file, (cycleCounts.get(file) ?? 0) + 1);
				}
			} else {
				for (const file of pendingFixes) {
					cycleCounts.delete(file);
				}
			}
			pendingFixes.clear();
		}
	}

	const repeatedErrors: Array<{
		file: string;
		errorType: string;
		count: number;
	}> = [];
	for (const [file, count] of cycleCounts) {
		if (count >= 2) {
			repeatedErrors.push({ file, errorType: "test_failure", count });
		}
	}

	const hasConcerningRepetitions = repeatedErrors.some((e) => e.count >= 3);

	return { repeatedErrors, hasConcerningRepetitions };
}

export function computeMetrics(events: EngramEvent[]): MetricResults {
	return {
		progressVelocity: progressVelocity(events),
		searchToActRatio: searchToActRatio(events),
		errorRepetition: errorRepetition(events),
	};
}

export function appendMetrics(
	sessionId: string,
	metrics: MetricResults,
	dataDir: string,
): void {
	try {
		const dir = join(dataDir, "metrics");
		mkdirSync(dir, { recursive: true });
		const entry = {
			timestamp: new Date().toISOString(),
			sessionId,
			...metrics,
		};
		appendFileSync(
			join(dir, `${sessionId}.metrics.jsonl`),
			`${JSON.stringify(entry)}\n`,
		);
	} catch {
		// metrics logging must never throw
	}
}
