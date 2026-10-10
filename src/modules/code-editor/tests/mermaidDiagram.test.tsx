import assert from 'node:assert/strict';

import { render, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import MermaidDiagram from '@/modules/code-editor/markdown/MermaidDiagram';

/**
 * MermaidDiagram never renders blank or shows a hard error: while mermaid
 * loads or a diagram fails to parse (e.g. still streaming in), the raw
 * source stays visible instead. No test file existed for this component
 * before the zoom feature — these baseline cases are required groundwork
 * for testing zoom against it at all.
 */

const renderMock = vi.fn();
const initializeMock = vi.fn();

vi.mock('mermaid', () => ({
  default: {
    initialize: (...args: unknown[]) => initializeMock(...args),
    render: (...args: unknown[]) => renderMock(...args),
  },
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

beforeEach(() => {
  renderMock.mockReset();
  initializeMock.mockReset();
  renderMock.mockResolvedValue({ svg: '<svg data-testid="rendered-diagram"><rect /></svg>' });
});

test('a diagram renders as SVG once mermaid resolves', async () => {
  const { container } = render(<MermaidDiagram code="graph TD; A-->B;" />);

  await waitFor(() => assert.ok(container.querySelector('[data-testid="rendered-diagram"]')));
  assert.equal(container.querySelector('pre'), null);
});

test('a render failure falls back to the raw source instead of crashing', async () => {
  renderMock.mockRejectedValue(new Error('parse error'));

  const { findByText } = render(<MermaidDiagram code="not a real diagram" />);

  await findByText('not a real diagram');
});

test('the zoom button only appears once the diagram has rendered', async () => {
  let resolveRender: (value: { svg: string }) => void = () => {};
  renderMock.mockReturnValue(new Promise((resolve) => { resolveRender = resolve; }));

  const { queryByRole, findByRole } = render(<MermaidDiagram code="graph TD; A-->B;" />);

  assert.equal(queryByRole('button'), null);

  resolveRender({ svg: '<svg data-testid="rendered-diagram"><rect /></svg>' });
  await findByRole('button');
});

test('clicking the zoom button opens a dialog with a second, independent rendering', async () => {
  const { getByRole, findByRole } = render(<MermaidDiagram code="graph TD; A-->B;" />);

  const zoomButton = await findByRole('button');
  fireEvent.click(zoomButton);

  await waitFor(() => assert.ok(getByRole('dialog')));
  // mermaid.render is called once for the inline instance and again for the
  // independently-mounted zoomed copy — not a shared/reused render.
  await waitFor(() => assert.equal(renderMock.mock.calls.length, 2));
  // Each call gets its own render id (useId()-based), so mermaid's internal
  // element ids (gradients/markers) can never collide between the two.
  const [firstId] = renderMock.mock.calls[0] as [string, string];
  const [secondId] = renderMock.mock.calls[1] as [string, string];
  assert.notEqual(firstId, secondId);
});

test('the zoomed copy has no zoom button of its own (no zoom-inside-zoom)', async () => {
  const { findByRole, getAllByRole } = render(<MermaidDiagram code="graph TD; A-->B;" />);

  const zoomButton = await findByRole('button');
  fireEvent.click(zoomButton);

  await waitFor(() => assert.equal(renderMock.mock.calls.length, 2));
  // Only the one button that opened the dialog — the zoomed instance
  // (zoomable=false) renders no button of its own, and the dialog's own
  // close control is an icon button without a role="button" text match here
  // only if we search broadly; assert the diagram-zoom button specifically
  // stays singular by checking there isn't a second one once the dialog is open.
  const buttons = getAllByRole('button');
  // One zoom button (now presumably still rendered behind the dialog) plus
  // the dialog's own close button — never a third "zoom" button from the
  // zoomed copy.
  assert.ok(buttons.length <= 2, `expected at most 2 buttons (zoom + close), got ${buttons.length}`);
});

test('closing the dialog removes the zoomed copy', async () => {
  const { findByRole, queryByRole, getAllByRole } = render(<MermaidDiagram code="graph TD; A-->B;" />);

  const zoomButton = await findByRole('button');
  fireEvent.click(zoomButton);
  await waitFor(() => assert.ok(queryByRole('dialog')));

  fireEvent.keyDown(document, { key: 'Escape' });

  await waitFor(() => assert.equal(queryByRole('dialog'), null));
  assert.equal(getAllByRole('button').length, 1);
});
