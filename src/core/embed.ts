import type { DatabaseType } from "../db/migrations.js";
import { loadConfig } from "./config.js";

const DIMENSION_MAP: Record<string, number> = {
	"voyage-3-lite": 512,
	"voyage-3": 1024,
	openai: 1536,
	"text-embedding-3-small": 1536,
	"text-embedding-3-large": 3072,
	local: 384,
	ollama: 768,
};

export function getDimensions(provider: string): number {
	return DIMENSION_MAP[provider] ?? 512;
}

export function validateEmbeddingDimension(
	db: DatabaseType,
	provider: string,
): {
	existing: number;
	expected: number;
	existingProvider: string;
	currentProvider: string;
} | null {
	const dimRow = db
		.prepare("SELECT value FROM metadata WHERE key = ?")
		.get("embedding_dimension") as { value: string } | undefined;
	if (!dimRow) return null;

	const existing = Number(dimRow.value);
	const expected = getDimensions(provider);
	if (existing === expected) return null;

	const providerRow = db
		.prepare("SELECT value FROM metadata WHERE key = ?")
		.get("embedding_provider") as { value: string } | undefined;
	return {
		existing,
		expected,
		existingProvider: providerRow?.value ?? "unknown",
		currentProvider: provider,
	};
}

type EmbeddingPipeline = (
	texts: string[],
	opts: { pooling: string; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let localPipeline: EmbeddingPipeline | null = null;

async function getLocalPipeline(): Promise<EmbeddingPipeline> {
	if (!localPipeline) {
		console.log("Downloading local embedding model...");
		const { pipeline } = await import("@huggingface/transformers");
		const pipe = await pipeline(
			"feature-extraction",
			"Xenova/all-MiniLM-L6-v2",
		);
		localPipeline = pipe as unknown as EmbeddingPipeline;
	}
	return localPipeline;
}

async function embedLocal(texts: string[]): Promise<number[][]> {
	const pipe = await getLocalPipeline();
	const output = await pipe(texts, { pooling: "mean", normalize: true });
	const nested: number[][] = output.tolist();
	if (
		texts.length === 1 &&
		nested.length === 1 &&
		Array.isArray(nested[0]![0])
	) {
		return nested[0] as unknown as number[][];
	}
	return nested;
}

async function embedOllama(
	texts: string[],
	ollamaUrl: string,
	model: string,
): Promise<number[][]> {
	return Promise.all(
		texts.map(async (text) => {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5000);
			let response: Response;
			try {
				response = await fetch(`${ollamaUrl}/api/embeddings`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ model, prompt: text }),
					signal: controller.signal,
				});
			} catch (err: unknown) {
				clearTimeout(timeout);
				if (err instanceof DOMException && err.name === "AbortError") {
					throw new Error(
						`Ollama connection timed out at ${ollamaUrl}. Is Ollama running? Start with: ollama serve`,
					);
				}
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`Ollama connection failed: ${msg}`);
				throw new Error(
					`Cannot reach Ollama at ${ollamaUrl}. Is Ollama running? Start with: ollama serve`,
				);
			}
			clearTimeout(timeout);

			if (!response.ok) {
				const body = await response.text();
				throw new Error(
					`Ollama API error ${response.status}: ${body.slice(0, 200)}`,
				);
			}

			const json = (await response.json()) as { embedding: number[] };
			if (!json.embedding?.length) {
				throw new Error(
					"Ollama returned malformed response: missing embedding",
				);
			}
			return json.embedding;
		}),
	);
}

async function embedHTTP(
	texts: string[],
	provider: string,
	apiKey: string,
): Promise<number[][]> {
	let url: string;
	let model: string;

	if (provider.startsWith("voyage")) {
		url = "https://api.voyageai.com/v1/embeddings";
		model = provider;
	} else {
		url = "https://api.openai.com/v1/embeddings";
		model = provider === "openai" ? "text-embedding-3-small" : provider;
	}

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ model, input: texts }),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`Embedding API error ${response.status}: ${body.slice(0, 200)}`,
		);
	}

	const json = (await response.json()) as {
		data: Array<{ embedding: number[] }>;
	};
	if (!json.data?.length) {
		throw new Error(
			"Embedding API returned malformed response: missing data[].embedding",
		);
	}

	return json.data.map((d) => d.embedding);
}

export async function getEmbedding(
	texts: string[],
	config?: {
		provider?: string;
		apiKey?: string;
		ollamaUrl?: string;
		ollamaModel?: string;
	},
): Promise<number[][]> {
	const fileConfig = loadConfig();
	const provider =
		config?.provider ?? fileConfig.embedding.provider ?? "voyage-3-lite";

	if (provider === "local") {
		return embedLocal(texts);
	}

	if (provider === "ollama") {
		const ollamaUrl =
			config?.ollamaUrl ??
			fileConfig.embedding.ollamaUrl ??
			"http://localhost:11434";
		const ollamaModel = config?.ollamaModel ?? "nomic-embed-text";
		return embedOllama(texts, ollamaUrl, ollamaModel);
	}

	const apiKey = resolveApiKey(provider, config?.apiKey, fileConfig);
	if (!apiKey) {
		throw new Error(`No API key provided for embedding provider "${provider}"`);
	}

	return embedHTTP(texts, provider, apiKey);
}

function resolveApiKey(
	provider: string,
	explicit: string | undefined,
	fileConfig: ReturnType<typeof loadConfig>,
): string | undefined {
	if (explicit) return explicit;
	if (fileConfig.embedding.apiKey) return fileConfig.embedding.apiKey;
	if (provider.startsWith("voyage")) return process.env.VOYAGE_API_KEY;
	return process.env.OPENAI_API_KEY;
}

export function _resetLocalPipeline(): void {
	localPipeline = null;
}
