import assert from 'node:assert/strict';

import { render, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import VegaLiteChart from '@/modules/code-editor/markdown/VegaLiteChart';

/**
 * VegaLiteChart never renders blank or shows a hard error: while vega-embed
 * loads, on invalid/incomplete JSON (a spec still streaming in), or on an
 * embed failure, the raw source stays visible instead.
 */

const embedMock = vi.fn();
const finalizeMock = vi.fn();

vi.mock('vega-embed', () => ({
  default: (...args: unknown[]) => embedMock(...args),
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

beforeEach(() => {
  embedMock.mockReset();
  finalizeMock.mockReset();
  embedMock.mockResolvedValue({
    view: {},
    spec: {},
    vgSpec: {},
    embedOptions: {},
    finalize: finalizeMock,
  });
});

test('a valid spec is parsed and handed to vega-embed with actions disabled', async () => {
  const spec = { mark: 'bar', data: { values: [] } };

  render(<VegaLiteChart spec={JSON.stringify(spec)} />);

  await waitFor(() => assert.equal(embedMock.mock.calls.length, 1));
  const [, embeddedSpec, opts] = embedMock.mock.calls[0] as [unknown, unknown, { actions?: boolean }];
  assert.deepEqual(embeddedSpec, spec);
  assert.equal(opts.actions, false);
});

test('invalid JSON falls back to the raw source instead of crashing', () => {
  const { getByText } = render(<VegaLiteChart spec="{not json" />);

  assert.ok(getByText('{not json'));
  assert.equal(embedMock.mock.calls.length, 0);
});

test('an embed failure falls back to the raw source', async () => {
  embedMock.mockRejectedValue(new Error('bad spec'));
  const spec = JSON.stringify({ mark: 'bar' });

  const { findByText } = render(<VegaLiteChart spec={spec} />);

  await findByText(spec);
});

test('a successful embed hides the raw source and shows the chart container', async () => {
  const { queryByText, container } = render(<VegaLiteChart spec={JSON.stringify({ mark: 'point' })} />);

  await waitFor(() => assert.equal(embedMock.mock.calls.length, 1));
  await waitFor(() => assert.equal(queryByText(/mark/), null));
  assert.equal(container.querySelector('pre'), null);
});
