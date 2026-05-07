import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeSchema } from "../db/migrations.js";

let tmpDirs: string[] = [];

function makeTmpDb(): string {
	const dir = mkdtempSync(join(tmpdir(), "engram-dim-test-"));
	tmpDirs.push(dir);
	return join(dir, "test.db");
}

afterEach(() => {
	for (const d of tmpDirs) {
		rmSync(d, { recursive: true, force: true });
	}
	tmpDirs = [];
});

describe("dynamic embedding dimensions", () => {
	it("creates vec0 table with default 512 dimensions", () => {
		const dbPath = makeTmpDb();
		const db = initializeSchema(dbPath);

		const dim = db
			.prepare("SELECT value FROM metadata WHERE key = 'embedding_dimension'")
			.get() as { value: string };
		expect(dim.value).toBe("512");

		const embedding = new Float32Array(512).fill(0.1);
		db.prepare(
			"INSERT INTO node_embeddings (node_id, embedding) VALUES (?, ?)",
		).run("n1", Buffer.from(embedding.buffer));
		const row = db
			.prepare("SELECT node_id FROM node_embeddings WHERE node_id = ?")
			.get("n1") as { node_id: string };
		expect(row.node_id).toBe("n1");

		db.close();
	});

	it("creates vec0 table with custom 384 dimensions", () => {
		const dbPath = makeTmpDb();
		const db = initializeSchema(dbPath, 384, "local");

		const dim = db
			.prepare("SELECT value FROM metadata WHERE key = 'embedding_dimension'")
			.get() as { value: string };
		expect(dim.value).toBe("384");

		const provider = db
			.prepare("SELECT value FROM metadata WHERE key = 'embedding_provider'")
			.get() as { value: string };
		expect(provider.value).toBe("local");

		const embedding = new Float32Array(384).fill(0.1);
		db.prepare(
			"INSERT INTO node_embeddings (node_id, embedding) VALUES (?, ?)",
		).run("n1", Buffer.from(embedding.buffer));
		const row = db
			.prepare("SELECT node_id FROM node_embeddings WHERE node_id = ?")
			.get("n1") as { node_id: string };
		expect(row.node_id).toBe("n1");

		db.close();
	});

	it("rebuilds vec0 table when dimension changes from 512 to 384", () => {
		const dbPath = makeTmpDb();

		const db1 = initializeSchema(dbPath, 512, "voyage-3-lite");
		const emb512 = new Float32Array(512).fill(0.2);
		db1
			.prepare("INSERT INTO node_embeddings (node_id, embedding) VALUES (?, ?)")
			.run("old-node", Buffer.from(emb512.buffer));
		db1.close();

		const db2 = initializeSchema(dbPath, 384, "local", true);

		const dim = db2
			.prepare("SELECT value FROM metadata WHERE key = 'embedding_dimension'")
			.get() as { value: string };
		expect(dim.value).toBe("384");

		const provider = db2
			.prepare("SELECT value FROM metadata WHERE key = 'embedding_provider'")
			.get() as { value: string };
		expect(provider.value).toBe("local");

		const oldRow = db2
			.prepare("SELECT node_id FROM node_embeddings WHERE node_id = ?")
			.get("old-node");
		expect(oldRow).toBeUndefined();

		const emb384 = new Float32Array(384).fill(0.3);
		db2
			.prepare("INSERT INTO node_embeddings (node_id, embedding) VALUES (?, ?)")
			.run("new-node", Buffer.from(emb384.buffer));
		const newRow = db2
			.prepare("SELECT node_id FROM node_embeddings WHERE node_id = ?")
			.get("new-node") as { node_id: string };
		expect(newRow.node_id).toBe("new-node");

		db2.close();
	});

	it("does not rebuild when dimension stays the same", () => {
		const dbPath = makeTmpDb();

		const db1 = initializeSchema(dbPath, 512, "voyage-3-lite");
		const emb = new Float32Array(512).fill(0.5);
		db1
			.prepare("INSERT INTO node_embeddings (node_id, embedding) VALUES (?, ?)")
			.run("keep-me", Buffer.from(emb.buffer));
		db1.close();

		const db2 = initializeSchema(dbPath, 512, "voyage-3-lite");
		const row = db2
			.prepare("SELECT node_id FROM node_embeddings WHERE node_id = ?")
			.get("keep-me") as { node_id: string };
		expect(row.node_id).toBe("keep-me");

		db2.close();
	});

	it("stores and retrieves embeddings at provider-specific dimensions (384 local, 768 ollama)", () => {
		const dbPath = makeTmpDb();

		const db384 = initializeSchema(dbPath, 384, "local");
		const emb384 = new Float32Array(384);
		for (let i = 0; i < 384; i++) emb384[i] = Math.sin(i * 0.01);
		db384
			.prepare("INSERT INTO node_embeddings (node_id, embedding) VALUES (?, ?)")
			.run("local-node", Buffer.from(emb384.buffer));
		const row384 = db384
			.prepare("SELECT node_id FROM node_embeddings WHERE node_id = ?")
			.get("local-node") as { node_id: string };
		expect(row384.node_id).toBe("local-node");
		db384.close();

		const db768 = initializeSchema(dbPath, 768, "ollama", true);
		const dim = db768
			.prepare("SELECT value FROM metadata WHERE key = 'embedding_dimension'")
			.get() as { value: string };
		expect(dim.value).toBe("768");

		const oldRow = db768
			.prepare("SELECT node_id FROM node_embeddings WHERE node_id = ?")
			.get("local-node");
		expect(oldRow).toBeUndefined();

		const emb768 = new Float32Array(768);
		for (let i = 0; i < 768; i++) emb768[i] = Math.cos(i * 0.01);
		db768
			.prepare("INSERT INTO node_embeddings (node_id, embedding) VALUES (?, ?)")
			.run("ollama-node", Buffer.from(emb768.buffer));
		const row768 = db768
			.prepare("SELECT node_id FROM node_embeddings WHERE node_id = ?")
			.get("ollama-node") as { node_id: string };
		expect(row768.node_id).toBe("ollama-node");

		db768.close();
	});

	it("preserves non-embedding tables during rebuild", () => {
		const dbPath = makeTmpDb();

		const db1 = initializeSchema(dbPath, 512, "voyage-3-lite");
		db1
			.prepare(
				"INSERT INTO nodes (id, name, node_type, description) VALUES (?, ?, ?, ?)",
			)
			.run("n1", "test-node", "concept", "survives rebuild");
		db1.close();

		const db2 = initializeSchema(dbPath, 384, "local", true);
		const node = db2
			.prepare("SELECT id, name FROM nodes WHERE id = ?")
			.get("n1") as { id: string; name: string };
		expect(node.id).toBe("n1");
		expect(node.name).toBe("test-node");

		db2.close();
	});

	it("throws on dimension mismatch when allowRebuild is false (default)", () => {
		const dbPath = makeTmpDb();

		const db1 = initializeSchema(dbPath, 512, "voyage-3-lite");
		db1.close();

		expect(() => initializeSchema(dbPath, 384, "local")).toThrow(
			/Embedding dimension mismatch.*npx engram re-embed/,
		);
	});
});
