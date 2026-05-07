import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { loadConfig, maskApiKey, saveConfig } from "../core/config.js";

const KNOWN_KEYS = new Set([
	"llm.apiKey",
	"llm.pass1Model",
	"llm.pass2Model",
	"embedding.provider",
	"embedding.apiKey",
	"embedding.ollamaUrl",
	"consolidation.turnThreshold",
	"consolidation.eventThreshold",
	"consolidation.windowSize",
	"consolidation.windowOverlap",
	"consolidation.provider",
]);

const NUMERIC_KEYS = new Set([
	"consolidation.turnThreshold",
	"consolidation.eventThreshold",
	"consolidation.windowSize",
	"consolidation.windowOverlap",
]);

const KEY_FIELDS = new Set(["llm.apiKey", "embedding.apiKey"]);

const EMBEDDING_PROVIDERS = [
	"voyage-3-lite",
	"openai",
	"text-embedding-3-small",
	"local",
	"ollama",
];

function getNestedValue(
	obj: Record<string, unknown>,
	dotPath: string,
): unknown {
	const parts = dotPath.split(".");
	let current: unknown = obj;
	for (const part of parts) {
		if (
			current === null ||
			current === undefined ||
			typeof current !== "object"
		)
			return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

function setNestedValue(
	obj: Record<string, unknown>,
	dotPath: string,
	value: unknown,
): void {
	const parts = dotPath.split(".");
	let current = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i]!;
		if (
			!(part in current) ||
			typeof current[part] !== "object" ||
			current[part] === null
		) {
			current[part] = {};
		}
		current = current[part] as Record<string, unknown>;
	}
	current[parts[parts.length - 1]!] = value;
}

function printConfigUsage(): void {
	console.log(`Usage: engram config [subcommand]

Subcommands:
  show              Display current configuration (API keys masked)
  get <key>         Get a single config value by dot-path
  set <key> <value> Set a config value by dot-path
  (no subcommand)   Interactive configuration wizard

Valid keys:
  llm.apiKey, llm.pass1Model, llm.pass2Model,
  embedding.provider, embedding.apiKey, embedding.ollamaUrl,
  consolidation.turnThreshold, consolidation.eventThreshold,
  consolidation.windowSize, consolidation.windowOverlap,
  consolidation.provider

Options:
  --help  Show this help message`);
}

function configShow(overridePath?: string): void {
	const config = loadConfig(overridePath);
	const flat: Record<string, string> = {};

	for (const [section, values] of Object.entries(config)) {
		if (values && typeof values === "object") {
			for (const [key, val] of Object.entries(
				values as Record<string, unknown>,
			)) {
				const dotPath = `${section}.${key}`;
				if (val === undefined) continue;
				const display =
					KEY_FIELDS.has(dotPath) && typeof val === "string"
						? maskApiKey(val)
						: String(val);
				flat[dotPath] = display;
			}
		}
	}

	if (Object.keys(flat).length === 0) {
		console.log("(no configuration set)");
		return;
	}

	for (const [key, value] of Object.entries(flat)) {
		console.log(`${key} = ${value}`);
	}
}

function configGet(dotPath: string, overridePath?: string): void {
	if (!KNOWN_KEYS.has(dotPath)) {
		console.error(`Unknown config key: ${dotPath}`);
		process.exit(1);
	}

	const config = loadConfig(overridePath);
	const value = getNestedValue(
		config as unknown as Record<string, unknown>,
		dotPath,
	);

	if (value === undefined) {
		console.log("(not set)");
		return;
	}

	const display =
		KEY_FIELDS.has(dotPath) && typeof value === "string"
			? maskApiKey(value)
			: String(value);
	console.log(display);
}

function configSet(
	dotPath: string,
	rawValue: string,
	overridePath?: string,
): void {
	if (!KNOWN_KEYS.has(dotPath)) {
		console.error(`Unknown config key: ${dotPath}`);
		console.error(`Valid keys: ${[...KNOWN_KEYS].join(", ")}`);
		process.exit(1);
	}

	const config = loadConfig(overridePath);
	let value: string | number = rawValue;

	if (NUMERIC_KEYS.has(dotPath)) {
		const num = Number(rawValue);
		if (Number.isNaN(num)) {
			console.error(`${dotPath} must be a number`);
			process.exit(1);
		}
		value = num;
	}

	setNestedValue(config as unknown as Record<string, unknown>, dotPath, value);
	saveConfig(config, overridePath);
	console.log(
		`Set ${dotPath} = ${KEY_FIELDS.has(dotPath) && typeof value === "string" ? maskApiKey(value) : value}`,
	);
}

async function configWizard(overridePath?: string): Promise<void> {
	if (!process.stdin.isTTY) {
		console.log(
			"Non-interactive environment detected. Use engram config set <key> <value> instead.",
		);
		return;
	}

	const rl = createInterface({ input: stdin, output: stdout });

	try {
		const config = loadConfig(overridePath);

		console.log("Consolidation provider:");
		console.log("  1) Anthropic API (requires API key) [default]");
		console.log("  2) Claude CLI (uses your Claude subscription)");
		const providerAnswer = await rl.question("Choice [1]: ");

		if (providerAnswer.trim() === "2") {
			config.consolidation = {
				...config.consolidation,
				provider: "claude-cli",
			};
		} else {
			const apiKey = await rl.question(
				"Anthropic API key (for LLM consolidation): ",
			);
			if (apiKey.trim()) {
				config.llm.apiKey = apiKey.trim();
			}
		}

		console.log("\nEmbedding providers:");
		for (let i = 0; i < EMBEDDING_PROVIDERS.length; i++) {
			console.log(`  ${i + 1}. ${EMBEDDING_PROVIDERS[i]}`);
		}
		const providerChoice = await rl.question(
			`Choose embedding provider [1-${EMBEDDING_PROVIDERS.length}]: `,
		);
		const providerIndex = parseInt(providerChoice, 10) - 1;
		const selectedProvider = EMBEDDING_PROVIDERS[providerIndex];
		if (providerIndex >= 0 && selectedProvider) {
			config.embedding.provider = selectedProvider;
		}

		const provider = config.embedding.provider ?? "";
		if (provider !== "ollama" && provider !== "local") {
			const embeddingKey = await rl.question(`${provider} API key: `);
			if (embeddingKey.trim()) {
				config.embedding.apiKey = embeddingKey.trim();
			}
		}

		const confirm = await rl.question("\nSave configuration? [Y/n] ");
		if (confirm.trim().toLowerCase() !== "n") {
			saveConfig(config, overridePath);
			console.log("Configuration saved.");
		} else {
			console.log("Configuration not saved.");
		}
	} finally {
		rl.close();
	}
}

export async function runConfig(
	args: string[],
	overridePath?: string,
): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		printConfigUsage();
		return;
	}

	const subcommand = args[0];

	switch (subcommand) {
		case "show":
			configShow(overridePath);
			break;
		case "get":
			if (!args[1]) {
				console.error("Usage: engram config get <key>");
				process.exit(1);
			}
			configGet(args[1], overridePath);
			break;
		case "set":
			if (!args[1] || !args[2]) {
				console.error("Usage: engram config set <key> <value>");
				process.exit(1);
			}
			configSet(args[1], args[2], overridePath);
			break;
		default:
			await configWizard(overridePath);
			break;
	}
}
