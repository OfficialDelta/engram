import {
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const STALE_LOCK_MS = 1000;
const MAX_RETRIES = 3;

function acquireLock(lockPath: string): boolean {
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		try {
			writeFileSync(
				lockPath,
				JSON.stringify({
					pid: process.pid,
					acquiredAt: new Date().toISOString(),
				}),
				{ flag: "wx" },
			);
			return true;
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") {
				try {
					const stat = statSync(lockPath);
					if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
						unlinkSync(lockPath);
						continue;
					}
				} catch {
					// stat/unlink failed — fall through
				}
				return false;
			}
			return false;
		}
	}
	return false;
}

function releaseLock(lockPath: string): void {
	try {
		unlinkSync(lockPath);
	} catch {
		// lock cleanup is best-effort
	}
}

function readInjectedIds(injectedPath: string): string[] {
	try {
		const data = JSON.parse(readFileSync(injectedPath, "utf-8"));
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

export function readModifyWriteInjected(
	injectedPath: string,
	newIds: string[],
): void {
	if (newIds.length === 0) return;

	const lockPath = `${injectedPath}.lock`;

	try {
		mkdirSync(dirname(injectedPath), { recursive: true });
	} catch {
		// directory may already exist
	}

	const locked = acquireLock(lockPath);
	if (locked) {
		try {
			const existing = readInjectedIds(injectedPath);
			writeFileSync(injectedPath, JSON.stringify([...existing, ...newIds]));
		} finally {
			releaseLock(lockPath);
		}
	} else {
		try {
			const existing = readInjectedIds(injectedPath);
			writeFileSync(injectedPath, JSON.stringify([...existing, ...newIds]));
		} catch {
			// P004: must never crash
		}
	}
}
