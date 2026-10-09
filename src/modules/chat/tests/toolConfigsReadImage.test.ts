import assert from 'node:assert/strict';
import { test } from 'vitest';

import { isImageFilePath, shouldHideToolResult } from '@/modules/chat/tools/configs/toolConfigs';

/**
 * Read's result is hidden by default — there's nowhere useful to render raw
 * file content inline, and the input row's "open file" chip already covers
 * that case. An image is the one exception: the model can only describe it
 * in text otherwise, so its result has to stay visible for ToolRenderer to
 * render the image itself.
 */

test('isImageFilePath recognizes common image extensions, case-insensitively', () => {
  assert.equal(isImageFilePath('/repo/assets/logo.png'), true);
  assert.equal(isImageFilePath('/repo/assets/logo.PNG'), true);
  assert.equal(isImageFilePath('/repo/assets/photo.jpeg'), true);
  assert.equal(isImageFilePath('/repo/assets/icon.svg'), true);
  assert.equal(isImageFilePath('/repo/README.md'), false);
  assert.equal(isImageFilePath('/repo/src/index.ts'), false);
  assert.equal(isImageFilePath(undefined), false);
  assert.equal(isImageFilePath(42), false);
});

test('a Read of a text file stays hidden on success', () => {
  const hidden = shouldHideToolResult('Read', { content: 'file contents' }, { file_path: '/repo/README.md' });
  assert.equal(hidden, true);
});

test('a Read of an image is not hidden, so its result renders', () => {
  const hidden = shouldHideToolResult('Read', { content: '' }, { file_path: '/repo/assets/logo.png' });
  assert.equal(hidden, false);
});

test('a failed Read of an image still shows the error, not the hidden/image path', () => {
  const hidden = shouldHideToolResult(
    'Read',
    { isError: true, content: 'ENOENT: no such file' },
    { file_path: '/repo/assets/missing.png' },
  );
  assert.equal(hidden, false);
});

test('a Read with no input (defensive) keeps the default hidden behavior', () => {
  const hidden = shouldHideToolResult('Read', { content: 'file contents' }, undefined);
  assert.equal(hidden, true);
});
