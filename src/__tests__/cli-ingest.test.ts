import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/config.js", () => ({
	loadConfig: vi.fn(() => ({
		llm: {},
		embedding: { provider: "voyage-3-lite" },
		consolidation: {},
	})),
}));

vi.mock("../core/embed.js", () => ({
	getEmbedding: vi.fn(async (texts: string[]) =>
		texts.map(() => Array.from({ length: 512 }, (_, i) => (i + 1) / 512)),
	),
	getDimensions: vi.fn().mockReturnValue(512),
}));

vi.mock("../core/project-identity.js", async () => {
	const actual = await vi.importActual<
		typeof import("../core/project-identity.js")
	>("../core/project-identity.js");
	return {
		...actual,
		getDbPath: vi.fn(),
	};
});

describe("runIngest", () => {
	let runIngest: typeof import("../cli/ingest.js").runIngest;
	let initializeSchema: typeof import("../db/migrations.js").initializeSchema;
	let getEmbedding: typeof import("../core/embed.js").getEmbedding;
	let getDbPath: typeof import("../core/project-identity.js").getDbPath;

	let tmpDir: string;

	function createFakeCodebase(root: string): void {
		const srcDir = path.join(root, "src");
		const utilsDir = path.join(srcDir, "utils");
		fs.mkdirSync(utilsDir, { recursive: true });

		fs.writeFileSync(
			path.join(srcDir, "index.ts"),
			"import { helper } from './helper';\n// TODO: refactor this\nconsole.log('hello');\n",
		);
		fs.writeFileSync(
			path.join(srcDir, "helper.ts"),
			"export function helper() { return 1; }\n// FIXME: handle edge case\n",
		);
		fs.writeFileSync(
			path.join(utilsDir, "math.ts"),
			"import { helper } from '../helper';\nexport const add = (a: number, b: number) => a + b;\n",
		);
		fs.writeFileSync(
			path.join(root, "README.md"),
			"# Test Project\nA test project for ingest testing.\n",
		);
		fs.writeFileSync(
			path.join(root, "package.json"),
			'{"name": "test-project"}\n',
		);
	}

	function initGit(dir: string): void {
		execSync('git init && git add -A && git commit -m "initial commit"', {
			cwd: dir,
			stdio: "pipe",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "test",
				GIT_AUTHOR_EMAIL: "test@test.com",
				GIT_COMMITTER_NAME: "test",
				GIT_COMMITTER_EMAIL: "test@test.com",
			},
		});
	}

	beforeEach(async () => {
		vi.clearAllMocks();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-ingest-"));

		const ingest = await import("../cli/ingest.js");
		runIngest = ingest.runIngest;
		const migrations = await import("../db/migrations.js");
		initializeSchema = migrations.initializeSchema;
		const embed = await import("../core/embed.js");
		getEmbedding = embed.getEmbedding;
		const projectIdentity = await import("../core/project-identity.js");
		getDbPath = projectIdentity.getDbPath;
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates file nodes for source files", async () => {
		createFakeCodebase(tmpDir);
		initGit(tmpDir);

		const dbPath = path.join(tmpDir, "engram.db");
		initializeSchema(dbPath, 512, "voyage-3-lite").close();
		vi.mocked(getDbPath).mockReturnValue(dbPath);

		await runIngest({ cwd: tmpDir });

		const { Database } = await import("../db/migrations.js");
		const sqliteVec = await import("sqlite-vec");
		const db = new Database(dbPath, { readonly: true });
		sqliteVec.load(db);
		try {
			const rows = db
				.prepare("SELECT * FROM nodes WHERE node_type = 'file'")
				.all() as Array<{ name: string }>;
			const names = rows.map((r) => r.name).sort();
			expect(names).toContain("src/index.ts");
			expect(names).toContain("src/helper.ts");
			expect(names).toContain("src/utils/math.ts");
			expect(rows.length).toBeGreaterThanOrEqual(3);
		} finally {
			db.close();
		}
	});

	it("creates import edges between files", async () => {
		createFakeCodebase(tmpDir);
		initGit(tmpDir);

		const dbPath = path.join(tmpDir, "engram.db");
		initializeSchema(dbPath, 512, "voyage-3-lite").close();
		vi.mocked(getDbPath).mockReturnValue(dbPath);

		await runIngest({ cwd: tmpDir });

		const { Database } = await import("../db/migrations.js");
		const sqliteVec = await import("sqlite-vec");
		const db = new Database(dbPath, { readonly: true });
		sqliteVec.load(db);
		try {
			const edges = db
				.prepare("SELECT * FROM edges WHERE relationship_type = 'imports'")
				.all() as Array<{ source_node_id: string; target_node_id: string }>;
			expect(edges.length).toBe(2);
		} finally {
			db.close();
		}
	});

	it("extracts TODO/FIXME as concept nodes", async () => {
		createFakeCodebase(tmpDir);
		initGit(tmpDir);

		const dbPath = path.join(tmpDir, "engram.db");
		initializeSchema(dbPath, 512, "voyage-3-lite").close();
		vi.mocked(getDbPath).mockReturnValue(dbPath);

		await runIngest({ cwd: tmpDir });

		const { Database } = await import("../db/migrations.js");
		const sqliteVec = await import("sqlite-vec");
		const db = new Database(dbPath, { readonly: true });
		sqliteVec.load(db);
		try {
			const rows = db
				.prepare(
					"SELECT * FROM nodes WHERE node_type = 'concept' AND (name LIKE 'TODO:%' OR name LIKE 'FIXME:%')",
				)
				.all() as Array<{ name: string; strength: number }>;
			expect(rows.length).toBe(2);
			expect(rows.some((r) => r.name.startsWith("TODO:"))).toBe(true);
			expect(rows.some((r) => r.name.startsWith("FIXME:"))).toBe(true);
			for (const row of rows) {
				expect(row.strength).toBe(0.3);
			}
		} finally {
			db.close();
		}
	});

	it("creates documentation concept node for README", async () => {
		createFakeCodebase(tmpDir);
		initGit(tmpDir);

		const dbPath = path.join(tmpDir, "engram.db");
		initializeSchema(dbPath, 512, "voyage-3-lite").close();
		vi.mocked(getDbPath).mockReturnValue(dbPath);

		await runIngest({ cwd: tmpDir });

		const { Database } = await import("../db/migrations.js");
		const sqliteVec = await import("sqlite-vec");
		const db = new Database(dbPath, { readonly: true });
		sqliteVec.load(db);
		try {
			const rows = db
				.prepare(
					"SELECT * FROM nodes WHERE node_type = 'concept' AND name = 'README.md'",
				)
				.all() as Array<{
				name: string;
				strength: number;
				description: string;
			}>;
			expect(rows.length).toBe(1);
			expect(rows[0]!.strength).toBe(0.8);
			expect(rows[0]!.description).toContain("Test Project");
		} finally {
			db.close();
		}
	});

	it("creates git commit episodes", async () => {
		createFakeCodebase(tmpDir);
		initGit(tmpDir);

		const dbPath = path.join(tmpDir, "engram.db");
		initializeSchema(dbPath, 512, "voyage-3-lite").close();
		vi.mocked(getDbPath).mockReturnValue(dbPath);

		await runIngest({ cwd: tmpDir });

		const { Database } = await import("../db/migrations.js");
		const sqliteVec = await import("sqlite-vec");
		const db = new Database(dbPath, { readonly: true });
		sqliteVec.load(db);
		try {
			const rows = db
				.prepare("SELECT * FROM episodes WHERE session_id LIKE 'ingest-git-%'")
				.all();
			expect(rows.length).toBeGreaterThanOrEqual(1);
		} finally {
			db.close();
		}
	});

	it("calls getEmbedding with node texts when API key is available", async () => {
		createFakeCodebase(tmpDir);
		initGit(tmpDir);

		const { loadConfig } = await import("../core/config.js");
		vi.mocked(loadConfig).mockReturnValue({
			llm: {},
			embedding: { provider: "voyage-3-lite", apiKey: "test-key" },
			consolidation: {},
		} as ReturnType<typeof loadConfig>);

		const dbPath = path.join(tmpDir, "engram.db");
		initializeSchema(dbPath, 512, "voyage-3-lite").close();
		vi.mocked(getDbPath).mockReturnValue(dbPath);

		await runIngest({ cwd: tmpDir });

		const mock = vi.mocked(getEmbedding);
		expect(mock).toHaveBeenCalled();
		const firstCallTexts = mock.mock.calls[0]![0] as string[];
		for (const text of firstCallTexts) {
			expect(typeof text).toBe("string");
			expect(text.length).toBeGreaterThan(0);
		}
	});

	it("dry-run does not modify database", async () => {
		createFakeCodebase(tmpDir);
		initGit(tmpDir);

		const dbPath = path.join(tmpDir, "engram.db");
		initializeSchema(dbPath, 512, "voyage-3-lite").close();
		vi.mocked(getDbPath).mockReturnValue(dbPath);

		const result = await runIngest({ cwd: tmpDir, dryRun: true });

		expect(result.nodesCreated).toBe(0);
		expect(result.edgesCreated).toBe(0);
		expect(result.episodesCreated).toBe(0);
		expect(result.filesFound).toBeGreaterThan(0);

		const { Database } = await import("../db/migrations.js");
		const sqliteVec = await import("sqlite-vec");
		const db = new Database(dbPath, { readonly: true });
		sqliteVec.load(db);
		try {
			const count = db.prepare("SELECT COUNT(*) as c FROM nodes").get() as {
				c: number;
			};
			expect(count.c).toBe(0);
		} finally {
			db.close();
		}
	});

	it("returns zeros when DB does not exist", async () => {
		vi.mocked(getDbPath).mockReturnValue(
			path.join(tmpDir, "nonexistent", "engram.db"),
		);

		const result = await runIngest({ cwd: tmpDir });

		expect(result.filesFound).toBe(0);
		expect(result.nodesCreated).toBe(0);
		expect(result.edgesCreated).toBe(0);
		expect(result.episodesCreated).toBe(0);
		expect(vi.mocked(getEmbedding)).not.toHaveBeenCalled();
	});

	it("skips node_modules and .git directories", async () => {
		createFakeCodebase(tmpDir);
		initGit(tmpDir);

		fs.mkdirSync(path.join(tmpDir, "node_modules", "foo"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, "node_modules", "foo", "index.js"),
			"module.exports = 1;",
		);

		const dbPath = path.join(tmpDir, "engram.db");
		initializeSchema(dbPath, 512, "voyage-3-lite").close();
		vi.mocked(getDbPath).mockReturnValue(dbPath);

		await runIngest({ cwd: tmpDir });

		const { Database } = await import("../db/migrations.js");
		const sqliteVec = await import("sqlite-vec");
		const db = new Database(dbPath, { readonly: true });
		sqliteVec.load(db);
		try {
			const rows = db
				.prepare("SELECT name FROM nodes WHERE node_type = 'file'")
				.all() as Array<{ name: string }>;
			for (const row of rows) {
				expect(row.name).not.toContain("node_modules");
				expect(row.name).not.toMatch(/^\.git\//);
			}
		} finally {
			db.close();
		}
	});

	it("handles non-git directory gracefully", async () => {
		createFakeCodebase(tmpDir);

		const dbPath = path.join(tmpDir, "engram.db");
		initializeSchema(dbPath, 512, "voyage-3-lite").close();
		vi.mocked(getDbPath).mockReturnValue(dbPath);

		const result = await runIngest({ cwd: tmpDir });

		expect(result.episodesCreated).toBe(0);
		expect(result.nodesCreated).toBeGreaterThan(0);

		const { Database } = await import("../db/migrations.js");
		const sqliteVec = await import("sqlite-vec");
		const db = new Database(dbPath, { readonly: true });
		sqliteVec.load(db);
		try {
			const fileNodes = db
				.prepare("SELECT COUNT(*) as c FROM nodes WHERE node_type = 'file'")
				.get() as { c: number };
			expect(fileNodes.c).toBeGreaterThanOrEqual(3);
			const episodes = db
				.prepare("SELECT COUNT(*) as c FROM episodes")
				.get() as { c: number };
			expect(episodes.c).toBe(0);
		} finally {
			db.close();
		}
	});
});
