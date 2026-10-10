import assert from 'node:assert/strict';

import { render, fireEvent, waitFor } from '@testing-library/react';
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

let mockIsDarkMode = false;
vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: mockIsDarkMode, toggleDarkMode: () => undefined }),
}));

beforeEach(() => {
  embedMock.mockReset();
  finalizeMock.mockReset();
  mockIsDarkMode = false;
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

test('the zoom button only appears once the chart has embedded', async () => {
  let resolveEmbed: (value: unknown) => void = () => {};
  embedMock.mockReturnValue(new Promise((resolve) => { resolveEmbed = resolve; }));

  const { queryByRole, findByRole } = render(<VegaLiteChart spec={JSON.stringify({ mark: 'bar' })} />);

  assert.equal(queryByRole('button'), null);

  resolveEmbed({ view: {}, spec: {}, vgSpec: {}, embedOptions: {}, finalize: finalizeMock });
  await findByRole('button');
});

test('clicking the zoom button opens a dialog with a second, independent embed — interactivity preserved', async () => {
  const { getByRole, findByRole } = render(<VegaLiteChart spec={JSON.stringify({ mark: 'bar' })} />);

  const zoomButton = await findByRole('button');
  fireEvent.click(zoomButton);

  await waitFor(() => assert.ok(getByRole('dialog')));
  // A second, genuinely live vega-embed call — not a CSS-scaled copy of the
  // same rendered node — is what keeps tooltips/interactivity working once
  // zoomed, per the explicit requirement this feature was built around.
  await waitFor(() => assert.equal(embedMock.mock.calls.length, 2));
});

test('closing the dialog finalizes the zoomed view (and leaves the inline one running)', async () => {
  const { findByRole, queryByRole } = render(<VegaLiteChart spec={JSON.stringify({ mark: 'bar' })} />);

  const zoomButton = await findByRole('button');
  fireEvent.click(zoomButton);
  await waitFor(() => assert.equal(embedMock.mock.calls.length, 2));
  await waitFor(() => assert.equal(finalizeMock.mock.calls.length, 0));

  fireEvent.keyDown(document, { key: 'Escape' });

  await waitFor(() => assert.equal(queryByRole('dialog'), null));
  // Only the zoomed copy's view is torn down; the inline one keeps running.
  await waitFor(() => assert.equal(finalizeMock.mock.calls.length, 1));
});

test('unmounting the parent while zoomed finalizes both the inline and zoomed views', async () => {
  const { findByRole, unmount } = render(<VegaLiteChart spec={JSON.stringify({ mark: 'bar' })} />);

  const zoomButton = await findByRole('button');
  fireEvent.click(zoomButton);
  await waitFor(() => assert.equal(embedMock.mock.calls.length, 2));

  unmount();

  assert.equal(finalizeMock.mock.calls.length, 2);
});

test('toggling theme while zoomed re-embeds both the inline and zoomed views', async () => {
  const spec = JSON.stringify({ mark: 'bar' });
  const { findByRole, rerender } = render(<VegaLiteChart spec={spec} />);

  const zoomButton = await findByRole('button');
  fireEvent.click(zoomButton);
  await waitFor(() => assert.equal(embedMock.mock.calls.length, 2));

  mockIsDarkMode = true;
  rerender(<VegaLiteChart spec={spec} />);

  await waitFor(() => assert.equal(embedMock.mock.calls.length, 4));
  const lastCallOpts = embedMock.mock.calls[3][2] as { theme?: string };
  assert.equal(lastCallOpts.theme, 'dark');
});
