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

test('a Read result for an image file renders the image inline', async () => {
  readFileBlob.mockResolvedValue({ ok: true, blob: async () => new Blob(['png']) });

  const { findByRole } = renderResult(
    { file_path: '/repo/AI_Gov/sbx/assets/agent-logos/claude-code-anthropic.png' },
    { content: 'base64-or-whatever-the-sdk-sent' },
  );

  const img = (await findByRole('img')) as HTMLImageElement;
  assert.equal(img.getAttribute('src'), OBJECT_URL);
  assert.deepEqual(
    readFileBlob.mock.calls[0].slice(0, 2),
    ['project-1', '/repo/AI_Gov/sbx/assets/agent-logos/claude-code-anthropic.png'],
  );
});

test('a Read result for a non-image file renders nothing (unchanged behavior)', () => {
  const { container } = renderResult({ file_path: '/repo/README.md' }, { content: 'file contents' });
  assert.equal(container.innerHTML, '');
  assert.equal(readFileBlob.mock.calls.length, 0);
});
