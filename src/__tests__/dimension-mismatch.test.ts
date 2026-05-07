import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateEmbeddingDimension } from "../core/embed.js";
import { initializeSchema } from "../db/migrations.js";

let tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-dim-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

describe("validateEmbeddingDimension", () => {
	it("returns null when dimensions match", () => {
		const tmpDir = makeTempDir();
		const dbPath = path.join(tmpDir, "test.db");
		const db = initializeSchema(dbPath, 512, "voyage-3-lite");
		try {
			const result = validateEmbeddingDimension(db, "voyage-3-lite");
			expect(result).toBeNull();
		} finally {
			db.close();
		}
	});

	it("returns error object when dimensions differ", () => {
		const tmpDir = makeTempDir();
		const dbPath = path.join(tmpDir, "test.db");
		const db = initializeSchema(dbPath, 512, "voyage-3-lite");
		try {
			const result = validateEmbeddingDimension(db, "voyage-3");
			expect(result).not.toBeNull();
			expect(result!.existing).toBe(512);
			expect(result!.expected).toBe(1024);
			expect(result!.existingProvider).toBe("voyage-3-lite");
			expect(result!.currentProvider).toBe("voyage-3");
		} finally {
			db.close();
		}
	});

	it("returns null when no metadata rows exist", () => {
		const tmpDir = makeTempDir();
		const dbPath = path.join(tmpDir, "empty.db");
		const db = initializeSchema(dbPath, 512, "voyage-3-lite");
		try {
			// Remove the dimension metadata to simulate empty state
			db.prepare(
				"DELETE FROM metadata WHERE key = 'embedding_dimension'",
			).run();
			const result = validateEmbeddingDimension(db, "voyage-3");
			expect(result).toBeNull();
		} finally {
			db.close();
		}
	});

	it("error object contains correct existing, expected, existingProvider, currentProvider fields", () => {
		const tmpDir = makeTempDir();
		const dbPath = path.join(tmpDir, "test.db");
		const db = initializeSchema(dbPath, 1536, "openai");
		try {
			const result = validateEmbeddingDimension(db, "local");
			expect(result).not.toBeNull();
			expect(result).toEqual({
				existing: 1536,
				expected: 384,
				existingProvider: "openai",
				currentProvider: "local",
			});
		} finally {
			db.close();
		}
	});
});

describe("initializeSchema dimension mismatch", () => {
	it("throws on dimension mismatch when allowRebuild is false (default)", () => {
		const tmpDir = makeTempDir();
		const dbPath = path.join(tmpDir, "test.db");

		// First init with 512 dimensions
		const db1 = initializeSchema(dbPath, 512, "voyage-3-lite");
		db1.close();

		// Second init with different dimensions — should throw
		expect(() => initializeSchema(dbPath, 1024, "voyage-3")).toThrow(
			/Embedding dimension mismatch.*512.*1024/,
		);
	});

	it("succeeds with rebuild when allowRebuild is true", () => {
		const tmpDir = makeTempDir();
		const dbPath = path.join(tmpDir, "test.db");

		const db1 = initializeSchema(dbPath, 512, "voyage-3-lite");
		db1.close();

		const db2 = initializeSchema(dbPath, 1024, "voyage-3", true);
		try {
			const dimRow = db2
				.prepare("SELECT value FROM metadata WHERE key = 'embedding_dimension'")
				.get() as { value: string };
			expect(Number(dimRow.value)).toBe(1024);

			const provRow = db2
				.prepare("SELECT value FROM metadata WHERE key = 'embedding_provider'")
				.get() as { value: string };
			expect(provRow.value).toBe("voyage-3");
		} finally {
			db2.close();
		}
	});

	it("works on first init with fresh DB", () => {
		const tmpDir = makeTempDir();
		const dbPath = path.join(tmpDir, "fresh.db");

		const db = initializeSchema(dbPath, 512, "voyage-3-lite");
		try {
			const dimRow = db
				.prepare("SELECT value FROM metadata WHERE key = 'embedding_dimension'")
				.get() as { value: string };
			expect(Number(dimRow.value)).toBe(512);

			const provRow = db
				.prepare("SELECT value FROM metadata WHERE key = 'embedding_provider'")
				.get() as { value: string };
			expect(provRow.value).toBe("voyage-3-lite");

			const verRow = db
				.prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
				.get() as { value: string };
			expect(verRow.value).toBe("1");
		} finally {
			db.close();
		}
	});
});
