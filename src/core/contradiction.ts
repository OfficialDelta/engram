import { getDecisionNodesForFile } from "../db/graph.js";
import type { DatabaseType } from "../db/migrations.js";
import type { ContradictionConfig, ContradictionResult } from "../types.js";

type HaikuClient = {
	messages: {
		create: (params: unknown) => Promise<{
			content: Array<{
				type: string;
				id?: string;
				name?: string;
				input?: unknown;
			}>;
		}>;
	};
};

const contradictionTool = {
	name: "check_contradiction",
	description:
		"Evaluate whether a file write contradicts existing project decisions",
	input_schema: {
		type: "object",
		properties: {
			verdict: {
				type: "string",
				enum: [
					"NO_CONTRADICTION",
					"INDIRECT_CONTRADICTION",
					"DIRECT_CONTRADICTION",
				],
			},
			severity: { type: "string", enum: ["low", "medium", "high"] },
			explanation: { type: "string" },
			recommendation: { type: "string" },
		},
		required: ["verdict", "severity", "explanation", "recommendation"],
	},
} as const;

export class ContradictionChecker {
	private consecutiveFailures = 0;
	private disabled = false;

	get isDisabled(): boolean {
		return this.disabled;
	}

	get failureCount(): number {
		return this.consecutiveFailures;
	}

	async checkContradiction(
		db: DatabaseType,
		filePath: string,
		evidenceSnippet: string,
		config?: ContradictionConfig,
	): Promise<ContradictionResult | null> {
		if (this.disabled) return null;

		const decisions = getDecisionNodesForFile(db, filePath);
		const threshold = config?.strengthThreshold ?? 0.3;
		const filtered = decisions.filter((d) => d.strength > threshold);
		if (filtered.length === 0) return null;

		const maxFailures = config?.maxFailures ?? 3;

		try {
			const client: HaikuClient =
				(config?.client as HaikuClient) ??
				new (await import("@anthropic-ai/sdk")).default();

			const decisionDescriptions = filtered
				.map((d) => `- ${d.name}: ${d.description} (strength: ${d.strength})`)
				.join("\n");

			const response = await client.messages.create({
				model: config?.model ?? "claude-haiku-4-5",
				max_tokens: 1024,
				messages: [
					{
						role: "user",
						content: `You are checking whether a file write contradicts existing project decisions.\n\nExisting decisions:\n${decisionDescriptions}\n\nFile being written: ${filePath}\nContent snippet:\n${evidenceSnippet}\n\nUse the check_contradiction tool to report your verdict.`,
					},
				],
				tools: [contradictionTool],
				tool_choice: { type: "tool", name: "check_contradiction" },
			});

			const toolUse = response.content.find(
				(block) => block.type === "tool_use",
			);
			if (!toolUse) throw new Error("No tool_use block in Haiku response");

			const result = toolUse.input as ContradictionResult;
			this.consecutiveFailures = 0;

			if (result.verdict === "NO_CONTRADICTION") return null;
			return result;
		} catch {
			this.consecutiveFailures++;
			if (this.consecutiveFailures >= maxFailures) this.disabled = true;
			return null;
		}
	}
}
