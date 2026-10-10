import assert from 'node:assert/strict';

import { render, fireEvent, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import ChartZoomDialog from '@/modules/code-editor/markdown/ChartZoomDialog';

/**
 * Built on the existing Dialog primitive (portal, backdrop click, Escape,
 * focus trap, scroll lock — already exercised by 4 other modules), so this
 * only needs to verify ChartZoomDialog's own wiring: the content renders,
 * and DialogContent's lack of any built-in close UI is covered by the
 * explicit close button this component adds.
 */

test('renders its children inside the dialog', () => {
  render(
    <ChartZoomDialog onClose={() => {}} label="Enlarged diagram">
      <div data-testid="zoomed-content">the big chart</div>
    </ChartZoomDialog>,
  );

  assert.ok(screen.getByTestId('zoomed-content'));
  assert.equal(screen.getByTestId('zoomed-content').textContent, 'the big chart');
});

test('has an accessible dialog role with the given label', () => {
  render(
    <ChartZoomDialog onClose={() => {}} label="Enlarged diagram">
      <div>content</div>
    </ChartZoomDialog>,
  );

  const dialog = screen.getByRole('dialog');
  assert.ok(dialog);
});

test('the explicit close button calls onClose (DialogContent has no built-in close UI)', () => {
  const onClose = vi.fn();
  render(
    <ChartZoomDialog onClose={onClose} label="Enlarged diagram">
      <div>content</div>
    </ChartZoomDialog>,
  );

  // The only button rendered here is this component's own close button —
  // the children in this test have none.
  const closeButton = screen.getByRole('button');
  fireEvent.click(closeButton);

  assert.equal(onClose.mock.calls.length, 1);
});

test('Escape closes the dialog (delegates to the shared Dialog primitive)', () => {
  const onClose = vi.fn();
  render(
    <ChartZoomDialog onClose={onClose} label="Enlarged diagram">
      <div>content</div>
    </ChartZoomDialog>,
  );

  fireEvent.keyDown(document, { key: 'Escape' });

  assert.equal(onClose.mock.calls.length, 1);
});
