import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';

/**
 * A Read of an image previously rendered nothing: the result config is
 * `{ hidden: true }` by default, and even when shown it had no `type`, so
 * ToolRenderer's dispatch fell through to `return null`. The model could
 * only describe the image in text, with no way for the user to actually see
 * it. This reuses MarkdownImage's workspace-path blob-fetch so the image
 * renders the same way an assistant markdown image reference would.
 *
 * `toolInput` reaches ToolRenderer JSON-stringified in production —
 * `normalizedToChatMessages` in useChatMessages.ts merges the tool_use and
 * tool_result WS messages into one ChatMessage and serializes the input in
 * the process. The first version of this test passed `toolInput` as a plain
 * object, which is NOT what the real app sends: that masked a real bug where
 * `toolInput?.file_path` was read off the raw string and always came back
 * `undefined`, so the image never rendered outside this test file. The
 * primary case below uses the real (string) shape; a secondary case confirms
 * the pre-parsed object shape still works too, since `parseToolPayload` is
 * meant to accept either.
 */

const readFileBlob = vi.fn();
vi.mock('@/shared/api', () => ({
  api: {
    readFileBlob: (...args: unknown[]) => readFileBlob(...args),
  },
}));

const OBJECT_URL = 'blob:mock-tool-image';
URL.createObjectURL = vi.fn(() => OBJECT_URL);
URL.revokeObjectURL = vi.fn();

beforeEach(() => {
  readFileBlob.mockReset();
});

const renderResult = (toolInput: unknown, toolResult: unknown, projectId: string | null = 'project-1') =>
  render(
    <MarkdownWorkspaceContext.Provider value={{ projectId }}>
      <ToolRenderer toolName="Read" toolInput={toolInput} toolResult={toolResult} mode="result" />
    </MarkdownWorkspaceContext.Provider>,
  );

test('a Read result for an image file renders the image inline (real, JSON-stringified toolInput)', async () => {
  readFileBlob.mockResolvedValue({ ok: true, blob: async () => new Blob(['png']) });

  const { findByRole } = renderResult(
    JSON.stringify({ file_path: '/repo/AI_Gov/sbx/assets/agent-logos/claude-code-anthropic.png' }),
    { content: 'base64-or-whatever-the-sdk-sent' },
  );

  const img = (await findByRole('img')) as HTMLImageElement;
  assert.equal(img.getAttribute('src'), OBJECT_URL);
  assert.deepEqual(
    readFileBlob.mock.calls[0].slice(0, 2),
    ['project-1', '/repo/AI_Gov/sbx/assets/agent-logos/claude-code-anthropic.png'],
  );
});

test('a Read result for an image file also renders when toolInput is already an object', async () => {
  readFileBlob.mockResolvedValue({ ok: true, blob: async () => new Blob(['png']) });

  const { findByRole } = renderResult(
    { file_path: '/repo/AI_Gov/sbx/assets/agent-logos/claude-code-anthropic.png' },
    { content: 'base64-or-whatever-the-sdk-sent' },
  );

  await findByRole('img');
});

test('a Read result for a non-image file renders nothing (unchanged behavior)', () => {
  const { container } = renderResult(JSON.stringify({ file_path: '/repo/README.md' }), { content: 'file contents' });
  assert.equal(container.innerHTML, '');
  assert.equal(readFileBlob.mock.calls.length, 0);
});
