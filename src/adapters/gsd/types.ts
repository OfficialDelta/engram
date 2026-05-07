export interface GSDActiveUnit {
	milestoneId: string;
	milestoneTitle: string;
	sliceId: string;
	sliceTitle: string;
	taskId: string;
	taskTitle: string;
}

export interface GSDToolCallEvent {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}

export interface GSDBeforeAgentStartEvent {
	systemPrompt: string;
	prompt?: string;
}

export type GSDExtensionContext = Record<string, never>;

export interface GSDExtensionAPI {
	on(
		event: "before_agent_start",
		handler: (
			event: GSDBeforeAgentStartEvent,
			ctx: GSDExtensionContext,
		) => { systemPrompt: string } | undefined | undefined,
	): void;
	on(
		event: "tool_call",
		handler: (event: GSDToolCallEvent, ctx: GSDExtensionContext) => void,
	): void;
	on(
		event: "session_shutdown",
		handler: (ctx: GSDExtensionContext) => void,
	): void;
	getPhase(): string | null;
	getActiveUnit(): GSDActiveUnit | null;
}
