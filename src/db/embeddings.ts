import type BetterSqlite3 from "better-sqlite3";
import type { EmbeddingSearchResult } from "../types.js";

type Database = BetterSqlite3.Database;

export function storeEmbedding(
	db: Database,
	nodeId: string,
	vector: number[],
): void {
	const f32 = new Float32Array(vector);
	const buf = Buffer.from(f32.buffer);
	db.prepare("DELETE FROM node_embeddings WHERE node_id = ?").run(nodeId);
	db.prepare(
		"INSERT INTO node_embeddings(node_id, embedding) VALUES (?, ?)",
	).run(nodeId, buf);
}

export function findSimilar(
	db: Database,
	vector: number[],
	threshold: number,
	limit: number,
): EmbeddingSearchResult[] {
	const maxDistance = 1 - threshold;
	const f32 = new Float32Array(vector);
	const queryBuf = Buffer.from(f32.buffer);

	const rows = db
		.prepare(
			"SELECT node_id, distance FROM node_embeddings WHERE embedding MATCH ? AND distance <= ? ORDER BY distance LIMIT ?",
		)
		.all(queryBuf, maxDistance, limit) as Array<{
		node_id: string;
		distance: number;
	}>;

	return rows.map((row) => ({
		nodeId: row.node_id,
		distance: row.distance,
		similarity: 1 - row.distance,
	}));
}
