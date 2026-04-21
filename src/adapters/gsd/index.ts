import { createSession, onToolCall, onSessionStart, onPrompt, onStop } from '../../adapter.js';
import type { GSDExtensionAPI } from './types.js';

const TOOL_NAME_MAP: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  multiedit: 'MultiEdit',
  bash: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  websearch: 'WebSearch',
  webfetch: 'WebFetch',
  view: 'View',
};

function normalizeInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  const lower = toolName.toLowerCase();

  if (lower === 'read' || lower === 'write' || lower === 'edit' || lower === 'view') {
    if ('path' in normalized && !('file_path' in normalized)) {
      normalized.file_path = normalized.path;
      delete normalized.path;
    }
  }

  if (lower === 'edit') {
    if ('oldText' in normalized && !('old_string' in normalized)) {
      normalized.old_string = normalized.oldText;
      delete normalized.oldText;
    }
    if ('newText' in normalized && !('new_string' in normalized)) {
      normalized.new_string = normalized.newText;
      delete normalized.newText;
    }
  }

  return normalized;
}

export default async function engramGSDExtension(api: GSDExtensionAPI): Promise<void> {
  const session = createSession({ cwd: process.cwd() });

  let pendingContext = '';
  try {
    const startResult = onSessionStart(session);
    pendingContext = startResult.context;
  } catch {
    // session start failures are non-fatal
  }

  api.on('before_agent_start', (event) => {
    try {
      const promptResult = onPrompt(session, event.systemPrompt);
      const parts: string[] = [];
      if (pendingContext) {
        parts.push(pendingContext);
        pendingContext = '';
      }
      if (promptResult.context) {
        parts.push(promptResult.context);
      }
      if (parts.length === 0) {
        return undefined;
      }
      const contextBlock = parts.join('\n\n');
      return { systemPrompt: event.systemPrompt + '\n\n' + contextBlock };
    } catch {
      return undefined;
    }
  });

  api.on('tool_call', (event) => {
    try {
      const mappedName = TOOL_NAME_MAP[event.toolName.toLowerCase()]
        ?? event.toolName.charAt(0).toUpperCase() + event.toolName.slice(1);
      const normalizedInput = normalizeInput(event.toolName, event.input);

      const tags: Record<string, string> = {};
      const unit = api.getActiveUnit();
      if (unit) {
        tags.milestoneId = unit.milestoneId;
        tags.sliceId = unit.sliceId;
        tags.taskId = unit.taskId;
      }

      const rawToolCall: import('../../types.js').RawToolCall = {
        tool_name: mappedName,
        tool_input: normalizedInput,
        session_id: session.sessionId,
      };
      if (Object.keys(tags).length > 0) {
        rawToolCall.tags = tags;
      }
      onToolCall(session, rawToolCall);
    } catch {
      // tool call failures are non-fatal
    }
  });

  api.on('session_shutdown', () => {
    try {
      onStop(session);
      session.close();
    } catch {
      // shutdown failures are non-fatal
    }
  });
}
