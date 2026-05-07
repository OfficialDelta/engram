import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	Database,
	getSchemaVersion,
	initializeSchema,
} from "../db/migrations.js";

let tmpDir: string;
const tmpDirs: string[] = [];

function makeTmpDb(): string {
	tmpDir = mkdtempSync(join(tmpdir(), "engram-test-"));
	tmpDirs.push(tmpDir);
	return join(tmpDir, "test.db");
}

afterEach(() => {
	for (const d of tmpDirs) {
		rmSync(d, { recursive: true, force: true });
	}
	tmpDirs.length = 0;
});

describe("schema initialization", () => {
	it("creates all tables and virtual tables", () => {
		const dbPath = makeTmpDb();
		const db = initializeSchema(dbPath);

		const tables = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all() as { name: string }[];
		const tableNames = tables.map((t) => t.name);

		expect(tableNames).toContain("nodes");
		expect(tableNames).toContain("edges");
		expect(tableNames).toContain("episodes");
		expect(tableNames).toContain("metadata");
		expect(tableNames).toContain("node_embeddings");

		db.close();
	});

	it("seeds metadata rows", () => {
		const dbPath = makeTmpDb();
		const db = initializeSchema(dbPath);

		const provider = db
			.prepare("SELECT value FROM metadata WHERE key = 'embedding_provider'")
			.get() as { value: string };
		const dimension = db
			.prepare("SELECT value FROM metadata WHERE key = 'embedding_dimension'")
			.get() as { value: string };
		const version = db
			.prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
			.get() as { value: string };

		expect(provider.value).toBe("voyage-3-lite");
		expect(dimension.value).toBe("512");
		expect(version.value).toBe("1");

		db.close();
	});

	it("enables WAL journal mode on file databases", () => {
		const dbPath = makeTmpDb();
		const db = initializeSchema(dbPath);

		const mode = db.pragma("journal_mode", { simple: true });
		expect(mode).toBe("wal");

		db.close();
	});

	it("supports concurrent WAL read/write access", () => {
		const dbPath = makeTmpDb();
		const writer = initializeSchema(dbPath);

		writer
			.prepare(
				"INSERT INTO nodes (id, name, node_type, description) VALUES (?, ?, ?, ?)",
			)
			.run("n1", "test-node", "concept", "a test node");

		const reader = new Database(dbPath, { readonly: true });
		const row = reader
			.prepare("SELECT id, name FROM nodes WHERE id = ?")
			.get("n1") as { id: string; name: string };

		expect(row.id).toBe("n1");
		expect(row.name).toBe("test-node");

		reader.close();
		writer.close();
	});

	it("rolls back transaction on error — no partial data committed", () => {
		const dbPath = makeTmpDb();
		const db = initializeSchema(dbPath);

		expect(() => {
			db.transaction(() => {
				db.prepare(
					"INSERT INTO nodes (id, name, node_type, description) VALUES (?, ?, ?, ?)",
				).run("n-partial", "partial-node", "concept", "should not persist");
				throw new Error("deliberate mid-transaction failure");
			})();
		}).toThrow("deliberate mid-transaction failure");

		const row = db
			.prepare("SELECT id FROM nodes WHERE id = ?")
			.get("n-partial");
		expect(row).toBeUndefined();

		db.close();
	});

	it("getSchemaVersion returns 1 after initialization", () => {
		const dbPath = makeTmpDb();
		const db = initializeSchema(dbPath);

		expect(getSchemaVersion(db)).toBe(1);

		db.close();
	});
});
