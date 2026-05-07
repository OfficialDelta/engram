import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function getProjectHash(cwd: string): string {
	let root = cwd;
	try {
		root = execSync("git rev-parse --show-toplevel", {
			cwd,
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		// non-git directory — hash cwd instead
	}
	return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

export function getDataDir(cwd: string): string {
	return join(homedir(), ".engram", "projects", getProjectHash(cwd));
}

export function getDbPath(cwd: string): string {
	return join(getDataDir(cwd), "engram.db");
}

export function ensureDataDirs(cwd: string): string {
	const dataDir = getDataDir(cwd);
	for (const sub of ["events", "sessions", "episodes", "logs", "metrics"]) {
		mkdirSync(join(dataDir, sub), { recursive: true });
	}
	return dataDir;
}
