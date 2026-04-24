import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawToolCall, EngramEvent, FileWriteEvent, TurnCompleteEvent } from '../types.js';

function makeToolCall(overrides: Partial<RawToolCall> & { tool_name: string }): RawToolCall {
  return {
    tool_input: {},
    session_id: 'test-session',
    ...overrides,
  };
}

describe('R044 — Edit evidence snippet before/after', () => {
  let classifyToolCall: typeof import('../core/event-stream.js').classifyToolCall;

  beforeEach(async () => {
    const mod = await import('../core/event-stream.js');
    classifyToolCall = mod.classifyToolCall;
  });

  it('Edit with old_string and new_string produces --- before / +++ after markers', () => {
    const result = classifyToolCall(makeToolCall({
      tool_name: 'Edit',
      tool_input: { file_path: '/src/foo.ts', old_string: 'const x = 1;', new_string: 'const x = 2;' },
    }));
    expect(result).not.toBeNull();
    const fw = result as FileWriteEvent;
    expect(fw.evidenceSnippet).toContain('--- before');
    expect(fw.evidenceSnippet).toContain('+++ after');
    expect(fw.evidenceSnippet).toContain('const x = 1;');
    expect(fw.evidenceSnippet).toContain('const x = 2;');
  });

  it('Edit with missing old_string (undefined) still produces evidence snippet gracefully', () => {
    const result = classifyToolCall(makeToolCall({
      tool_name: 'Edit',
      tool_input: { file_path: '/src/foo.ts', new_string: 'const y = 3;' },
    }));
    expect(result).not.toBeNull();
    const fw = result as FileWriteEvent;
    expect(fw.evidenceSnippet).toContain('--- before');
    expect(fw.evidenceSnippet).toContain('+++ after');
    expect(fw.evidenceSnippet).toContain('const y = 3;');
  });

  it('MultiEdit produces before/after evidence snippet', () => {
    const result = classifyToolCall(makeToolCall({
      tool_name: 'MultiEdit',
      tool_input: { file_path: '/src/bar.ts', old_string: 'a', new_string: 'b' },
    }));
    expect(result).not.toBeNull();
    const fw = result as FileWriteEvent;
    expect(fw.evidenceSnippet).toContain('--- before');
    expect(fw.evidenceSnippet).toContain('+++ after');
  });

  it('Write still uses old format without before/after markers', () => {
    const content = 'line1\nline2\nline3';
    const result = classifyToolCall(makeToolCall({
      tool_name: 'Write',
      tool_input: { file_path: '/src/new.ts', content },
    }));
    expect(result).not.toBeNull();
    const fw = result as FileWriteEvent;
    expect(fw.evidenceSnippet).not.toContain('--- before');
    expect(fw.evidenceSnippet).not.toContain('+++ after');
    expect(fw.evidenceSnippet).toContain('line1');
  });

  it('Edit with long old_string/new_string (>5 lines) truncates both to 5 lines', () => {
    const longOld = Array.from({ length: 10 }, (_, i) => `old-line-${i}`).join('\n');
    const longNew = Array.from({ length: 10 }, (_, i) => `new-line-${i}`).join('\n');
    const result = classifyToolCall(makeToolCall({
      tool_name: 'Edit',
      tool_input: { file_path: '/src/big.ts', old_string: longOld, new_string: longNew },
    }));
    expect(result).not.toBeNull();
    const fw = result as FileWriteEvent;
    const snippet = fw.evidenceSnippet;
    const beforeSection = snippet.split('+++ after')[0]!;
    const afterSection = snippet.split('+++ after')[1]!;
    expect(beforeSection).toContain('old-line-0');
    expect(beforeSection).toContain('old-line-4');
    expect(beforeSection).not.toContain('old-line-5');
    expect(afterSection).toContain('new-line-0');
    expect(afterSection).toContain('new-line-4');
    expect(afterSection).not.toContain('new-line-5');
  });
});

describe('R045 — buildTurnCompleteEvent enrichment', () => {
  let buildTurnCompleteEvent: typeof import('../core/event-stream.js').buildTurnCompleteEvent;

  beforeEach(async () => {
    const mod = await import('../core/event-stream.js');
    buildTurnCompleteEvent = mod.buildTurnCompleteEvent;
  });

  it('no options returns event without userMessage/agentSummary', () => {
    const event = buildTurnCompleteEvent('sess-1', 3, 1);
    expect(event.type).toBe('turn_complete');
    expect(event.toolCallCount).toBe(3);
    expect(event.turnNumber).toBe(1);
    expect('userMessage' in event).toBe(false);
    expect('agentSummary' in event).toBe(false);
  });

  it('options with userMessage and agentSummary includes both fields', () => {
    const event = buildTurnCompleteEvent('sess-1', 2, 5, {
      userMessage: 'hello',
      agentSummary: 'did stuff',
    });
    expect(event.userMessage).toBe('hello');
    expect(event.agentSummary).toBe('did stuff');
  });

  it('partial options (only userMessage) works', () => {
    const event = buildTurnCompleteEvent('sess-1', 0, 1, { userMessage: 'hi' });
    expect(event.userMessage).toBe('hi');
    expect('agentSummary' in event).toBe(false);
  });
});

describe('R045 — shouldUseDiscussionConsolidation', () => {
  let shouldUseDiscussionConsolidation: typeof import('../core/consolidation.js').shouldUseDiscussionConsolidation;

  beforeEach(async () => {
    const mod = await import('../core/consolidation.js');
    shouldUseDiscussionConsolidation = mod.shouldUseDiscussionConsolidation;
  });

  function makeTurnComplete(toolCallCount: number): TurnCompleteEvent {
    return {
      type: 'turn_complete',
      sessionId: 'sess-1',
      timestamp: new Date().toISOString(),
      toolCallCount,
      turnNumber: 1,
    };
  }

  it('returns true for 1 turn_complete event with toolCallCount=0', () => {
    expect(shouldUseDiscussionConsolidation([makeTurnComplete(0)])).toBe(true);
  });

  it('returns true for 2 turn_complete events with toolCallCount=0', () => {
    expect(shouldUseDiscussionConsolidation([makeTurnComplete(0), makeTurnComplete(0)])).toBe(true);
  });

  it('returns false for 3 turn_complete events (>= 3 threshold)', () => {
    expect(shouldUseDiscussionConsolidation([
      makeTurnComplete(0), makeTurnComplete(0), makeTurnComplete(0),
    ])).toBe(false);
  });

  it('returns false when any event has toolCallCount > 0', () => {
    expect(shouldUseDiscussionConsolidation([makeTurnComplete(0), makeTurnComplete(1)])).toBe(false);
  });

  it('returns false when events include non-turn_complete types', () => {
    const events: EngramEvent[] = [
      makeTurnComplete(0),
      { type: 'file_read', sessionId: 'sess-1', timestamp: new Date().toISOString(), filePath: '/x.ts' },
    ];
    expect(shouldUseDiscussionConsolidation(events)).toBe(false);
  });

  it('returns false for empty events array', () => {
    expect(shouldUseDiscussionConsolidation([])).toBe(false);
  });
});

describe('R041 — Prompt keyword assertions', () => {
  let pass1Summarize: typeof import('../core/consolidation.js').pass1Summarize;
  let pass2Extract: typeof import('../core/consolidation.js').pass2Extract;

  beforeEach(async () => {
    const mod = await import('../core/consolidation.js');
    pass1Summarize = mod.pass1Summarize;
    pass2Extract = mod.pass2Extract;
  });

  it('pass1Summarize prompt contains error messages, concrete values, verbatim', async () => {
    let capturedPrompt = '';
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: { messages: Array<{ content: string }> }) => {
          capturedPrompt = params.messages[0]!.content;
          return { content: [{ type: 'text', text: JSON.stringify({
            summary: 'test', filesModified: [], decisionsIdentified: [], outcome: 'progress',
          }) }] };
        }),
      },
    };

    const events: EngramEvent[] = [{
      type: 'file_read', sessionId: 's', timestamp: new Date().toISOString(), filePath: '/a.ts',
    }];

    await pass1Summarize([events], mockClient, 'test-model');

    expect(capturedPrompt).toContain('error messages');
    expect(capturedPrompt).toContain('concrete values');
    expect(capturedPrompt).toContain('verbatim');
  });

  it('pass2Extract prompt contains [inferred] and verbatim', async () => {
    let capturedPrompt = '';
    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: { messages: Array<{ content: string }> }) => {
          capturedPrompt = params.messages[0]!.content;
          return {
            content: [{
              type: 'tool_use', id: 'call_1', name: 'extract_episode',
              input: {
                episode: {
                  goal: 'g', approach: 'a', outcome: 'success',
                  discoveries: [], decisions: [], errors: [],
                },
                changes: { nodesToCreate: [], nodesToUpdate: [], edgesToCreate: [] },
              },
            }],
          };
        }),
      },
    };

    await pass2Extract(
      [{ windowIndex: 0, eventRange: { start: 0, end: 0 }, summary: 'test', filesModified: [], decisionsIdentified: [], outcome: 'progress' as const }],
      mockClient,
      'test-model',
    );

    expect(capturedPrompt).toContain('[inferred]');
    expect(capturedPrompt).toContain('verbatim');
  });
});

describe('R045 — discussionConsolidate', () => {
  let discussionConsolidate: typeof import('../core/consolidation.js').discussionConsolidate;

  beforeEach(async () => {
    const mod = await import('../core/consolidation.js');
    discussionConsolidate = mod.discussionConsolidate;
  });

  it('calls client with event data and returns parsed topics/decisions/constraints', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify({
            topics: ['auth design'],
            decisions: ['use JWT'],
            constraints: ['must support SSO'],
          }) }],
        }),
      },
    };

    const events: TurnCompleteEvent[] = [{
      type: 'turn_complete', sessionId: 's', timestamp: new Date().toISOString(),
      toolCallCount: 0, turnNumber: 1, userMessage: 'discuss auth', agentSummary: 'talked about auth',
    }];

    const result = await discussionConsolidate(events, mockClient, 'test-model');

    expect(result.topics).toEqual(['auth design']);
    expect(result.decisions).toEqual(['use JWT']);
    expect(result.constraints).toEqual(['must support SSO']);
    expect(mockClient.messages.create).toHaveBeenCalledTimes(1);
  });

  it('returns empty arrays on malformed LLM response', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'not valid json at all' }],
        }),
      },
    };

    const events: TurnCompleteEvent[] = [{
      type: 'turn_complete', sessionId: 's', timestamp: new Date().toISOString(),
      toolCallCount: 0, turnNumber: 1,
    }];

    const result = await discussionConsolidate(events, mockClient, 'test-model');

    expect(result.topics).toEqual([]);
    expect(result.decisions).toEqual([]);
    expect(result.constraints).toEqual([]);
  });
});
