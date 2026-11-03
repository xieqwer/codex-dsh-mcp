import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeAcpError, TurnCollector } from '../src/output.ts';
import { AcpError } from '../src/acp-client.ts';

function messageChunk(text: string): unknown {
  return { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } };
}

function thoughtChunk(text: string): unknown {
  return { sessionId: 's', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } };
}

function toolCall(id: string, rawOutput: unknown): unknown {
  return {
    sessionId: 's',
    update: { sessionUpdate: 'tool_call', toolCallId: id, title: 't', rawOutput },
  };
}

test('collector clips assistant text while keeping the original length', () => {
  const collector = new TurnCollector({ maxChars: 10 });
  collector.apply(messageChunk('x'.repeat(25)));
  const turn = collector.collect();
  assert.equal(turn.assistantText, 'x'.repeat(10));
  assert.equal(turn.assistantOriginalChars, 25);
  assert.equal(turn.assistantTruncated, true);
});

test('collector bounds memory across many small chunks', () => {
  const collector = new TurnCollector({ maxChars: 100 });
  for (let i = 0; i < 100; i += 1) collector.apply(messageChunk('0123456789'));
  const turn = collector.collect();
  assert.equal(turn.assistantText.length, 100);
  assert.equal(turn.assistantOriginalChars, 1000);
  assert.equal(turn.assistantTruncated, true);
});

test('collector replaces oversized tool rawOutput with a preview', () => {
  const collector = new TurnCollector({ maxChars: 50, maxToolChars: 20 });
  collector.apply(toolCall('tool-1', { blob: 'y'.repeat(500) }));
  const turn = collector.collect();
  const entry = turn.toolCalls[0] as Record<string, unknown>;
  assert.equal(turn.truncatedToolFields, 1);
  const clipped = entry.rawOutput as Record<string, unknown>;
  assert.equal(clipped.__truncated, true);
  assert.equal(typeof clipped.preview, 'string');
  assert.equal((clipped.preview as string).length <= 20, true);
});

test('collector drops thoughts unless explicitly enabled', () => {
  const withDefault = new TurnCollector();
  withDefault.apply(thoughtChunk('secret reasoning'));
  assert.equal(withDefault.collect().thoughts, '');
  assert.equal(withDefault.collect().thoughtsTruncated, false);

  const withThoughts = new TurnCollector({ includeThoughts: true, maxChars: 5 });
  withThoughts.apply(thoughtChunk('secret reasoning'));
  const turn = withThoughts.collect();
  assert.equal(turn.thoughts, 'secre');
  assert.equal(turn.thoughtsTruncated, true);
});

test('defer_loading turn failure maps to a stale-tool-history error with guidance', () => {
  const normalized = normalizeAcpError(
    new AcpError({
      code: -32603,
      message:
        'Internal error: turn failed: tools: at least one tool must have defer_loading=false. All tools cannot be deferred. (request_id: x)',
    }),
  );
  assert.equal(normalized.code, 'DSH_SESSION_TOOL_HISTORY_STALE');
  assert.match(normalized.message, /create a NEW session/u);
  assert.match(normalized.message, /dsh_close_session/u);
});
