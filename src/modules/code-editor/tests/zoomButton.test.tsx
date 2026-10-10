import assert from 'node:assert/strict';

import { render, fireEvent } from '@testing-library/react';
import { test, vi } from 'vitest';

import ZoomButton from '@/modules/code-editor/markdown/ZoomButton';

test('renders with the given label as its accessible name and calls onClick', () => {
  const onClick = vi.fn();
  const { getByRole } = render(<ZoomButton onClick={onClick} label="Zoom diagram" />);

  const button = getByRole('button', { name: 'Zoom diagram' });
  fireEvent.click(button);

  assert.equal(onClick.mock.calls.length, 1);
});
