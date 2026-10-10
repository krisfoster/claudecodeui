import assert from 'node:assert/strict';
import { test } from 'vitest';

import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { shouldHideToolResult } from '@/modules/chat/tools/configs/toolConfigs';
import type { NormalizedMessage } from '@/shared/types';

/**
 * Closes the gap the previous Read-image tests missed: they passed
 * `toolInput` as a plain object straight into ToolRenderer/shouldHideToolResult,
 * which is NOT what the real app does. The backend sends a `tool_use` and a
 * later `tool_result` as two separate WS messages; `normalizedToChatMessages`
 * (src/modules/chat/hooks/useChatMessages.ts) merges them into one
 * ChatMessage and, in the process, JSON-stringifies `toolInput`
 * unconditionally when it isn't already a string. That stringified value is
 * what `MessageComponent`/`ToolRenderer` actually receive, and reading
 * `.file_path` off it without reparsing always returned `undefined` — so the
 * image preview never rendered outside the old, unrealistic unit tests. This
 * test exercises the real merge function end to end.
 */

const row = (fields: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: fields.id || Math.random().toString(36).slice(2),
  sessionId: 's1',
  timestamp: '2026-01-01T00:00:00.000Z',
  provider: 'claude',
  kind: 'text',
  role: 'assistant',
  ...fields,
} as NormalizedMessage);

test("merging a real Read-of-image tool_use/tool_result pair leaves toolInput JSON-stringified", () => {
  const toolUse = row({
    kind: 'tool_use',
    toolName: 'Read',
    toolId: 'toolu_1',
    toolInput: { file_path: '/repo/AI_Gov/sbx/assets/agent-logos/claude-code-anthropic.png' },
  });
  const toolResult = row({
    kind: 'tool_result',
    toolId: 'toolu_1',
    content: JSON.stringify([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xyz' } }]),
    isError: false,
  });

  const [merged] = normalizedToChatMessages([toolUse, toolResult]);

  assert.equal(typeof merged.toolInput, 'string');
  assert.deepEqual(JSON.parse(merged.toolInput as string), {
    file_path: '/repo/AI_Gov/sbx/assets/agent-logos/claude-code-anthropic.png',
  });

  // The actual regression: shouldHideToolResult must still recognize this as
  // an image once fed the real (stringified) shape the merge produces.
  const hidden = shouldHideToolResult('Read', merged.toolResult, merged.toolInput);
  assert.equal(hidden, false);
});

test('merging a real Read-of-text-file pair keeps the result hidden', () => {
  const toolUse = row({
    kind: 'tool_use',
    toolName: 'Read',
    toolId: 'toolu_2',
    toolInput: { file_path: '/repo/README.md' },
  });
  const toolResult = row({
    kind: 'tool_result',
    toolId: 'toolu_2',
    content: '# README\n\nSome file content.',
    isError: false,
  });

  const [merged] = normalizedToChatMessages([toolUse, toolResult]);

  const hidden = shouldHideToolResult('Read', merged.toolResult, merged.toolInput);
  assert.equal(hidden, true);
});
