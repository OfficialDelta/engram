#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { invokeClaude } from "../core/cli-consolidation.js";
import { loadConfig } from "../core/config.js";
import { getDimensions, getEmbedding } from "../core/embed.js";
import { getDbPath } from "../core/project-identity.js";
import { storeEmbedding } from "../db/embeddings.js";
import { createEdge, createEpisode, createNode } from "../db/graph.js";
import { initializeSchema } from "../db/migrations.js";

export interface IngestOptions {
	cwd: string;
	depth?: "shallow";
	dryRun?: boolean;
}

export interface IngestResult {
	filesFound: number;
	nodesCreated: number;
	edgesCreated: number;
	episodesCreated: number;
	nodesEmbedded: number;
}

const BATCH_SIZE = 100;
const MAX_FILES = 5000;

const IGNORE_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	".git",
	".gsd",
	".next",
	"__pycache__",
	".venv",
	"venv",
	"target",
	"vendor",
	"coverage",
	".cache",
	"tmp",
	".idea",
	".vscode",
]);

const CODE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
]);

const DOC_EXTENSIONS = new Set([".md"]);

const DOC_NAMES = new Set([
	"README.md",
	"CLAUDE.md",
	"DECISIONS.md",
	"readme.md",
	"Readme.md",
]);

const ES_IMPORT = /import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
const CJS_REQUIRE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_IMPORT = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const TODO_PATTERN = /\/\/\s*(TODO|FIXME|HACK|NOTE)[:\s](.+)/gi;

const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const INDEX_SUFFIXES = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

function walkFiles(root: string): string[] {
	const results: string[] = [];

	function walk(dir: string): void {
		if (results.length >= MAX_FILES) return;

		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			process.stderr.write(`Warning: cannot read directory ${dir}, skipping\n`);
			return;
		}

		for (const entry of entries) {
			if (results.length >= MAX_FILES) break;

			if (entry.isDirectory()) {
				if (!IGNORE_DIRS.has(entry.name)) {
					walk(join(dir, entry.name));
				}
			} else if (entry.isFile()) {
				const ext = extname(entry.name);
				const name = entry.name;
				if (
					CODE_EXTENSIONS.has(ext) ||
					DOC_EXTENSIONS.has(ext) ||
					name === "package.json"
				) {
					results.push(relative(root, join(dir, name)));
				}
			}
		}
	}

	walk(root);

	if (results.length >= MAX_FILES) {
		process.stderr.write(
			`Warning: file limit (${MAX_FILES}) reached, some files skipped\n`,
		);
	}

	return results;
}

function parseImports(content: string, filePath: string): string[] {
	const fromDir = dirname(filePath);
	const imports: string[] = [];

	for (const pattern of [ES_IMPORT, CJS_REQUIRE, DYNAMIC_IMPORT]) {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null = pattern.exec(content);
		while (match !== null) {
			const specifier = match[1]!;
			if (specifier.startsWith("./") || specifier.startsWith("../")) {
				const resolved = relative(".", resolve(fromDir, specifier));
				imports.push(resolved);
			}
			match = pattern.exec(content);
		}
	}

	return imports;
}

function resolveImport(
	importPath: string,
	fileSet: Set<string>,
): string | null {
	for (const ext of RESOLVE_EXTENSIONS) {
		const candidate = importPath + ext;
		if (fileSet.has(candidate)) return candidate;
	}

	for (const suffix of INDEX_SUFFIXES) {
		const candidate = importPath + suffix;
		if (fileSet.has(candidate)) return candidate;
	}

	return null;
}

function extractTodos(content: string): Array<{ tag: string; text: string }> {
	TODO_PATTERN.lastIndex = 0;
	const results: Array<{ tag: string; text: string }> = [];
	let match: RegExpExecArray | null = TODO_PATTERN.exec(content);
	while (match !== null) {
		results.push({ tag: match[1]!, text: match[2]!.trim() });
		match = TODO_PATTERN.exec(content);
	}
	return results;
}

function readGitCommits(
	cwd: string,
	limit: number,
): Array<{ hash: string; message: string }> {
	try {
		const output = execSync(
			`git log --oneline --no-decorate -${String(limit)}`,
			{
				cwd,
				encoding: "utf-8",
				timeout: 10000,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		return output
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const spaceIdx = line.indexOf(" ");
				if (spaceIdx === -1) return { hash: line, message: "" };
				return {
					hash: line.slice(0, spaceIdx),
					message: line.slice(spaceIdx + 1),
				};
			});
	} catch {
		process.stderr.write(
			"Warning: git not available, skipping commit episodes\n",
		);
		return [];
	}
}

function needsApiKey(provider: string): boolean {
	return provider !== "local" && provider !== "ollama";
}

export async function runIngest(options: IngestOptions): Promise<IngestResult> {
	const dbPath = getDbPath(options.cwd);

	if (!existsSync(dbPath)) {
		console.log("No engram database found. Run engram install first.");
		return {
			filesFound: 0,
			nodesCreated: 0,
			edgesCreated: 0,
			episodesCreated: 0,
			nodesEmbedded: 0,
		};
	}

	const config = loadConfig();
	const provider = config.embedding.provider ?? "voyage-3-lite";
	const dimension = getDimensions(provider);

	const files = walkFiles(options.cwd);
	const fileSet = new Set(files);

	console.log(`Found ${files.length} files to ingest`);

	if (options.dryRun) {
		const codeFiles = files.filter((f) => CODE_EXTENSIONS.has(extname(f)));
		const docFiles = files.filter((f) => DOC_NAMES.has(basename(f)));
		const commits = readGitCommits(options.cwd, 50);
		console.log(
			`Dry run: would create ~${files.length} file nodes, ~${docFiles.length} doc nodes, ${commits.length} episodes`,
		);
		console.log(
			`Code files: ${codeFiles.length}, Doc files: ${docFiles.length}`,
		);
		return {
			filesFound: files.length,
			nodesCreated: 0,
			edgesCreated: 0,
			episodesCreated: 0,
			nodesEmbedded: 0,
		};
	}

	const db = initializeSchema(dbPath, dimension, provider);

	let nodesCreated = 0;
	let edgesCreated = 0;
	let episodesCreated = 0;

	const fileNodeIds = new Map<string, string>();
	const allNodeIds: Array<{ id: string; text: string }> = [];

	db.transaction(() => {
		for (const filePath of files) {
			const ext = extname(filePath);
			if (!CODE_EXTENSIONS.has(ext) && ext !== ".json") continue;

			const node = createNode(db, {
				name: filePath,
				nodeType: "file",
				description: "",
				affectedFiles: [filePath],
				strength: 0.5,
				metadata: { source: "ingest" },
			});
			fileNodeIds.set(filePath, node.id);
			allNodeIds.push({
				id: node.id,
				text: `${node.name} ${node.description}`,
			});
			nodesCreated++;
		}
	})();

	console.log(`Created ${nodesCreated} file nodes`);

	let docsCreated = 0;
	db.transaction(() => {
		for (const filePath of files) {
			if (!DOC_NAMES.has(basename(filePath))) continue;

			let content = "";
			try {
				content = readFileSync(resolve(options.cwd, filePath), "utf-8");
			} catch {
				continue;
			}
			const first200 = content.slice(0, 200);

			const node = createNode(db, {
				name: basename(filePath),
				nodeType: "concept",
				description: first200,
				affectedFiles: [filePath],
				strength: 0.8,
				metadata: { source: "ingest", docType: true },
			});
			allNodeIds.push({
				id: node.id,
				text: `${node.name} ${node.description}`,
			});
			nodesCreated++;
			docsCreated++;
		}
	})();

	console.log(`Created ${docsCreated} documentation nodes`);

	let todosCreated = 0;
	db.transaction(() => {
		for (const filePath of files) {
			if (!CODE_EXTENSIONS.has(extname(filePath))) continue;

			let content: string;
			try {
				content = readFileSync(resolve(options.cwd, filePath), "utf-8");
			} catch {
				continue;
			}

			const todos = extractTodos(content);
			for (const todo of todos) {
				const node = createNode(db, {
					name: `${todo.tag}: ${todo.text.slice(0, 80)}`,
					nodeType: "concept",
					description: todo.text,
					affectedFiles: [filePath],
					strength: 0.3,
					metadata: { source: "ingest", todoType: todo.tag },
				});
				allNodeIds.push({
					id: node.id,
					text: `${node.name} ${node.description}`,
				});
				nodesCreated++;
				todosCreated++;
			}
		}
	})();

	console.log(`Created ${todosCreated} TODO/FIXME nodes`);

	db.transaction(() => {
		for (const filePath of files) {
			if (!CODE_EXTENSIONS.has(extname(filePath))) continue;

			const sourceNodeId = fileNodeIds.get(filePath);
			if (!sourceNodeId) continue;

			let content: string;
			try {
				content = readFileSync(resolve(options.cwd, filePath), "utf-8");
			} catch {
				continue;
			}

			const imports = parseImports(content, filePath);
			for (const imp of imports) {
				const resolved = resolveImport(imp, fileSet);
				if (!resolved) continue;

				const targetNodeId = fileNodeIds.get(resolved);
				if (!targetNodeId) continue;

				createEdge(db, {
					sourceNodeId,
					targetNodeId,
					relationshipType: "imports",
					weight: 1.0,
					metadata: { source: "ingest" },
				});
				edgesCreated++;
			}
		}
	})();

	console.log(`Created ${edgesCreated} import edges`);

	const commits = readGitCommits(options.cwd, 50);
	if (commits.length > 0) {
		db.transaction(() => {
			for (const commit of commits) {
				createEpisode(db, {
					sessionId: `ingest-git-${commit.hash}`,
					summary: commit.message,
					nodesInvolved: [],
					timestamp: new Date().toISOString(),
					metadata: { source: "git", commitHash: commit.hash },
				});
				episodesCreated++;
			}
		})();
	}

	console.log(`Created ${episodesCreated} git commit episodes`);

	let nodesEmbedded = 0;
	const canEmbed = !needsApiKey(provider) || Boolean(config.embedding.apiKey);

	if (canEmbed && allNodeIds.length > 0) {
		const embeddingConfig = {
			provider,
			...(config.embedding.apiKey ? { apiKey: config.embedding.apiKey } : {}),
			...(config.embedding.ollamaUrl
				? { ollamaUrl: config.embedding.ollamaUrl }
				: {}),
		};

		try {
			const allEmbeddings: Array<[string, number[]]> = [];

			for (let i = 0; i < allNodeIds.length; i += BATCH_SIZE) {
				const batchItems = allNodeIds.slice(i, i + BATCH_SIZE);
				const batchTexts = batchItems.map((item) => item.text);
				const batchEnd = Math.min(i + BATCH_SIZE, allNodeIds.length);
				console.log(`Embedding ${batchEnd}/${allNodeIds.length} nodes...`);

				const vectors = await getEmbedding(batchTexts, embeddingConfig);
				for (let j = 0; j < batchItems.length; j++) {
					allEmbeddings.push([batchItems[j]!.id, vectors[j]!]);
				}
			}

			db.transaction(() => {
				for (const [nodeId, vector] of allEmbeddings) {
					storeEmbedding(db, nodeId, vector);
				}
			})();

			nodesEmbedded = allEmbeddings.length;
		} catch (err) {
			process.stderr.write(
				`Warning: embedding failed (${err instanceof Error ? err.message : String(err)}), skipping embedding pass\n`,
			);
		}
	} else if (allNodeIds.length > 0) {
		console.log("Skipping embedding pass (no API key configured)");
	}

	const summaryProvider = config.consolidation.provider ?? "api";
	const canSummarize =
		summaryProvider === "claude-cli" || Boolean(config.llm.apiKey);

	if (canSummarize) {
		try {
			const docDescriptions = allNodeIds
				.filter((n) => n.text.length > 10)
				.slice(0, 20)
				.map((n) => n.text)
				.join("\n");

			const summaryPrompt = `Summarize this software project in 2-3 sentences based on these file and doc descriptions:\n${docDescriptions}`;
			const summaryModel = "claude-sonnet-4-6";

			let summaryText: string;
			if (summaryProvider === "claude-cli") {
				summaryText = await invokeClaude(summaryPrompt, summaryModel);
			} else {
				const { default: Anthropic } = await import("@anthropic-ai/sdk");
				const client = new Anthropic({ apiKey: config.llm.apiKey });
				const response = await client.messages.create({
					model: summaryModel,
					max_tokens: 300,
					messages: [{ role: "user", content: summaryPrompt }],
				});
				summaryText =
					response.content[0]?.type === "text" ? response.content[0].text : "";
			}

			if (summaryText) {
				createNode(db, {
					name: "Project Summary",
					nodeType: "concept",
					description: summaryText,
					affectedFiles: [],
					strength: 0.9,
					metadata: { source: "ingest", opusSummary: true },
				});
				nodesCreated++;
				console.log("Created project summary node");
			}
		} catch (err) {
			process.stderr.write(
				`Skipping project summary (${err instanceof Error ? err.message : String(err)})\n`,
			);
		}
	} else {
		console.log(
			"Skipping project summary (no API key configured and provider is not claude-cli)",
		);
	}

	console.log(
		`Ingest complete: ${files.length} files, ${edgesCreated} edges, ${episodesCreated} episodes, ${docsCreated} docs, ${todosCreated} TODOs`,
	);
	db.close();

	return {
		filesFound: files.length,
		nodesCreated,
		edgesCreated,
		episodesCreated,
		nodesEmbedded,
	};
}

export function printUsage(): void {
	console.log(`Usage: engram ingest [options]

Scan the current codebase and populate the knowledge graph with structural
knowledge. Creates file nodes, import edges, TODO/FIXME nodes, documentation
nodes, and git commit episodes.

Options:
  --depth shallow  Shallow scan (default, currently the only mode)
  --dry-run        Show what would happen without modifying the database
  --help           Show this help message`);
}

function main(): void {
	const args = process.argv.slice(2);
	if (args.includes("--help")) {
		printUsage();
		process.exit(0);
	}

	const dryRun = args.includes("--dry-run");

	runIngest({
		cwd: process.cwd(),
		dryRun,
	}).catch((err) => {
		console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
}

const argv1Real = (() => {
	try {
		return realpathSync(resolve(process.argv[1] ?? ""));
	} catch {
		return resolve(process.argv[1] ?? "");
	}
})();
if (argv1Real === fileURLToPath(import.meta.url)) {
	main();
}
