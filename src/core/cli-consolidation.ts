import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  EngramEvent,
  TurnCompleteEvent,
  WindowSummary,
  StructuredEpisode,
  GraphChangeRequest,
} from '../types.js';

const execFileAsync = promisify(execFile);

const MODEL_MAP: Record<string, string> = {
  'claude-sonnet-4-6': 'sonnet',
  'claude-opus-4-6': 'opus',
  'claude-haiku-4-5': 'haiku',
};

export function mapModelToCli(fullModel: string): string {
  return MODEL_MAP[fullModel] ?? fullModel;
}

export function parseCliResponse(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { type?: string; result?: unknown };
    if (typeof parsed.result === 'string') {
      return parsed.result;
    }
    return stdout.trim();
  } catch {
    return stdout.trim();
  }
}

export async function invokeClaude(prompt: string, model: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('claude', [
      '-p', prompt,
      '--model', mapModelToCli(model),
      '--bare',
      '--output-format', 'json',
    ]);
    return parseCliResponse(stdout);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      throw new Error('Claude CLI not found in PATH. Install Claude Code or switch to consolidation.provider: api');
    }
    const e = err as { stderr?: string; code?: number };
    throw new Error(`Claude CLI failed (exit ${e.code ?? 'unknown'}): ${e.stderr ?? 'no stderr'}`);
  }
}

export async function cliPass1Summarize(
  windows: EngramEvent[][],
  model: string,
): Promise<WindowSummary[]> {
  const summaries: WindowSummary[] = [];

  for (let idx = 0; idx < windows.length; idx++) {
    const windowEvts = windows[idx]!;
    const prompt = `Analyze these coding agent events and produce a JSON summary.

Events:
${JSON.stringify(windowEvts, null, 2)}

Return a JSON object with these fields:
- summary: what the agent was doing, what blocked it, and what non-obvious things were discovered (2-3 sentences with causal links)
- filesModified: array of file paths modified in these events
- decisionsIdentified: array of decision descriptions (empty array if none)
- gotchas: array of non-obvious traps, constraints, or surprises encountered — things that would bite a developer unfamiliar with this area (empty array if none)
- lessonsLearned: array of things that should be known to avoid repeating mistakes or wasted effort (empty array if none)
- outcome: one of "progress", "debugging", "blocked", "completed"

Additional extraction requirements:
- List specific bugs encountered with their error messages or stack traces verbatim
- Include concrete values: config settings, thresholds, version numbers, counts
- For each file modified, describe WHAT specifically changed (not just that it was modified)
- Quote the agent's stated reasons for actions verbatim when available in evidence_snippet fields`;

    const rawText = await invokeClaude(prompt, model);

    try {
      const parsed = JSON.parse(rawText) as {
        summary?: string;
        filesModified?: string[];
        decisionsIdentified?: string[];
        gotchas?: string[];
        lessonsLearned?: string[];
        outcome?: string;
      };
      summaries.push({
        windowIndex: idx,
        eventRange: { start: idx * windowEvts.length, end: idx * windowEvts.length + windowEvts.length - 1 },
        summary: parsed.summary ?? rawText,
        filesModified: parsed.filesModified ?? [],
        decisionsIdentified: parsed.decisionsIdentified ?? [],
        gotchas: parsed.gotchas ?? [],
        lessonsLearned: parsed.lessonsLearned ?? [],
        outcome: (parsed.outcome as WindowSummary['outcome']) ?? 'progress',
      });
    } catch {
      summaries.push({
        windowIndex: idx,
        eventRange: { start: 0, end: windowEvts.length - 1 },
        summary: rawText,
        filesModified: [],
        decisionsIdentified: [],
        outcome: 'progress' as const,
      });
    }
  }

  return summaries;
}

const VALID_NODE_TYPES = new Set(['concept', 'decision', 'pattern', 'file', 'entity']);

export async function cliPass2Extract(
  summaries: WindowSummary[],
  model: string,
): Promise<{ episode: StructuredEpisode; changes: GraphChangeRequest }> {
  const summaryText = summaries
    .map((s, i) => `Window ${i}: ${s.summary}\nFiles: ${s.filesModified.join(', ')}\nDecisions: ${s.decisionsIdentified.join(', ')}\nGotchas: ${(s.gotchas ?? []).join(', ')}\nLessons: ${(s.lessonsLearned ?? []).join(', ')}\nOutcome: ${s.outcome}`)
    .join('\n\n');

  const prompt = `Analyze these session window summaries and extract a structured episode with graph changes.

Decision extraction guidance:
- Identify both EXPLICIT decisions (agent stated a choice with rationale) and IMPLICIT decisions (agent chose between alternatives without stating the choice).
- For explicit decisions: set isImplicit=false, include the stated rationale verbatim, set causallyImportant=true on the corresponding graph node.
- For implicit decisions: set isImplicit=true, infer the rationale from context. Only flag as a decision when alternatives were clearly available — routine code changes are not decisions. Set causallyImportant=false.
- Each decision node should have nodeType='decision' and a descriptive name summarizing the choice made.
- Include affected file paths in affectedFiles for every decision node.
- Flag decisions that have hidden dependencies — choices that only work because of an unstated constraint, prior decision, or environmental assumption. Prefix the description of such decisions with "[hidden-dependency]" so downstream consumers can identify them.

Rationale formatting:
- For explicit decisions (isImplicit=false): include the agent's stated reason verbatim, without modification or hedging.
- For implicit decisions (isImplicit=true): prefix the inferred rationale with "[inferred]" so downstream consumers can distinguish stated from inferred reasoning.

Error extraction guidance:
- Identify bugs that are likely to recur — bugs caused by a false assumption not captured in code (not transient typos or tool failures). Prefix the rootCause of such errors with "[recurring-risk]".

${summaryText}

Respond with ONLY a valid JSON object matching this exact schema (no other text):
{
  "episode": {
    "goal": "string",
    "approach": "string",
    "outcome": "success" | "partial" | "failure",
    "discoveries": [{ "content": "string", "evidence": "string", "confidence": number }],
    "decisions": [{ "content": "string", "rationale": "string", "isImplicit": boolean }],
    "errors": [{ "description": "string", "rootCause": "string", "resolution": "string" }]
  },
  "changes": {
    "nodesToCreate": [{ "name": "string", "nodeType": "concept"|"decision"|"pattern"|"file"|"entity", "description": "string", "affectedFiles": ["string"], "causallyImportant": boolean }],
    "nodesToUpdate": [{ "existingNodeId": "string", "updates": {} }],
    "edgesToCreate": [{ "sourceNodeName": "string", "targetNodeName": "string", "relationshipType": "string", "weight": number }]
  }
}`;

  const rawText = await invokeClaude(prompt, model);
  const result = JSON.parse(rawText) as { episode: StructuredEpisode; changes: GraphChangeRequest };

  result.changes.nodesToCreate = result.changes.nodesToCreate.filter(
    (n) => VALID_NODE_TYPES.has(n.nodeType),
  );

  return result;
}

export async function cliDiscussionConsolidate(
  events: EngramEvent[],
  model: string,
): Promise<{ topics: string[]; decisions: string[]; constraints: string[] }> {
  const turnEvents = events.filter((e): e is TurnCompleteEvent => e.type === 'turn_complete');
  const eventSummary = turnEvents
    .map((e, i) => {
      const parts = [`Turn ${i + 1}`];
      if (e.userMessage) parts.push(`User: ${e.userMessage}`);
      if (e.agentSummary) parts.push(`Agent: ${e.agentSummary}`);
      return parts.join('\n');
    })
    .join('\n\n');

  try {
    const prompt = `Analyze this discussion session and extract structured information.

Discussion turns:
${eventSummary}

Return a JSON object with:
- topics: array of topics discussed
- decisions: array of decisions stated during the discussion
- constraints: array of constraints or requirements mentioned`;

    const rawText = await invokeClaude(prompt, model);
    try {
      const parsed = JSON.parse(rawText) as {
        topics?: string[];
        decisions?: string[];
        constraints?: string[];
      };
      return {
        topics: parsed.topics ?? [],
        decisions: parsed.decisions ?? [],
        constraints: parsed.constraints ?? [],
      };
    } catch {
      return { topics: [], decisions: [], constraints: [] };
    }
  } catch {
    return { topics: [], decisions: [], constraints: [] };
  }
}
