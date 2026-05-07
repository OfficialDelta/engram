import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireConsolidationLock,
	isEpisodeComplete,
	releaseConsolidationLock,
} from "../core/consolidation.js";

let tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-concurrency-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

describe("isEpisodeComplete", () => {
	it("returns false when no marker exists", () => {
		const dataDir = makeTempDir();
		fs.mkdirSync(path.join(dataDir, "episodes"), { recursive: true });
		expect(isEpisodeComplete(dataDir, "sess-1")).toBe(false);
	});

	it("returns true when episode marker exists", () => {
		const dataDir = makeTempDir();
		const episodesDir = path.join(dataDir, "episodes");
		fs.mkdirSync(episodesDir, { recursive: true });
		fs.writeFileSync(
			path.join(episodesDir, "sess-1.episode.json"),
			JSON.stringify({
				episodeId: "ep-1",
				completedAt: new Date().toISOString(),
			}),
		);
		expect(isEpisodeComplete(dataDir, "sess-1")).toBe(true);
	});
});

describe("acquireConsolidationLock", () => {
	it("succeeds on first call and creates lock file with pid and acquiredAt", () => {
		const dataDir = makeTempDir();
		const result = acquireConsolidationLock(dataDir, "sess-1");
		expect(result).toBe(true);

		const lockPath = path.join(
			dataDir,
			"episodes",
			"sess-1.consolidating.lock",
		);
		expect(fs.existsSync(lockPath)).toBe(true);

		const content = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as {
			pid: number;
			acquiredAt: string;
		};
		expect(content.pid).toBe(process.pid);
		expect(content.acquiredAt).toBeTruthy();
	});

	it("returns false when lock already exists and is recent", () => {
		const dataDir = makeTempDir();
		expect(acquireConsolidationLock(dataDir, "sess-1")).toBe(true);
		expect(acquireConsolidationLock(dataDir, "sess-1")).toBe(false);
	});

	it("succeeds when existing lock is stale (>30 min old)", () => {
		const dataDir = makeTempDir();
		expect(acquireConsolidationLock(dataDir, "sess-1")).toBe(true);

		const lockPath = path.join(
			dataDir,
			"episodes",
			"sess-1.consolidating.lock",
		);
		const staleTime = new Date(Date.now() - 31 * 60 * 1000);
		fs.utimesSync(lockPath, staleTime, staleTime);

		expect(acquireConsolidationLock(dataDir, "sess-1")).toBe(true);

		const content = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as {
			pid: number;
		};
		expect(content.pid).toBe(process.pid);
	});

	it("handles corrupted lock file by checking mtime for staleness", () => {
		const dataDir = makeTempDir();
		const episodesDir = path.join(dataDir, "episodes");
		fs.mkdirSync(episodesDir, { recursive: true });
		const lockPath = path.join(episodesDir, "sess-1.consolidating.lock");

		fs.writeFileSync(lockPath, "not-valid-json!!!");

		// Recent corrupted lock still blocks
		expect(acquireConsolidationLock(dataDir, "sess-1")).toBe(false);

		// Stale corrupted lock gets replaced
		const staleTime = new Date(Date.now() - 31 * 60 * 1000);
		fs.utimesSync(lockPath, staleTime, staleTime);
		expect(acquireConsolidationLock(dataDir, "sess-1")).toBe(true);
	});

	it("returns false when episodes directory cannot be created", () => {
		// Use a path that won't exist and can't be created
		const result = acquireConsolidationLock("/dev/null/impossible", "sess-1");
		expect(result).toBe(false);
	});
});

describe("releaseConsolidationLock", () => {
	it("removes the lock file", () => {
		const dataDir = makeTempDir();
		acquireConsolidationLock(dataDir, "sess-1");

		const lockPath = path.join(
			dataDir,
			"episodes",
			"sess-1.consolidating.lock",
		);
		expect(fs.existsSync(lockPath)).toBe(true);

		releaseConsolidationLock(dataDir, "sess-1");
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it("does not throw when lock file does not exist", () => {
		const dataDir = makeTempDir();
		fs.mkdirSync(path.join(dataDir, "episodes"), { recursive: true });
		expect(() => releaseConsolidationLock(dataDir, "sess-1")).not.toThrow();
	});
});
