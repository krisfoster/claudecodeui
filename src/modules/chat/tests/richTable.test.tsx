import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';

/**
 * The `table` markdown override is swapped for RichTable, which adds
 * sorting and filtering on top of any GFM table Claude already writes — no
 * new fence syntax to teach it. These drive it through the real Markdown
 * pipeline so cell content (a link, here) survives reordering untouched.
 */

const SIX_ROW_TABLE = `
| Name | Score |
| --- | --- |
| [Alice](https://example.com/alice) | 90 |
| Bob | 70 |
| Carol | 85 |
| Dave | 60 |
| Eve | 95 |
| Frank | 80 |
`;

const namesInOrder = () =>
  screen.getAllByRole('row').slice(1).map((row) => row.querySelector('td')?.textContent?.trim());

// react-i18next has no initialized instance in this test environment (the
// same "NO_I18NEXT_INSTANCE" warning every other markdown test already
// triggers), so `t(key)` returns the raw key rather than the English copy —
// that is what these look up, not a hardcoded translation of it.

test('a table with more than 4 rows gets sort/filter chrome', () => {
  render(<Markdown>{SIX_ROW_TABLE}</Markdown>);

  assert.ok(screen.getByPlaceholderText('table.filterPlaceholder'));
});

test('a table with 4 or fewer rows has no toolbar', () => {
  render(<Markdown>{'| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n'}</Markdown>);

  assert.equal(screen.queryByPlaceholderText('table.filterPlaceholder'), null);
});

test('sorting by a numeric column reorders rows and keeps the link intact', () => {
  render(<Markdown>{SIX_ROW_TABLE}</Markdown>);

  fireEvent.change(screen.getByDisplayValue('table.sortPlaceholder'), { target: { value: '1' } });

  assert.deepEqual(namesInOrder(), ['Dave', 'Bob', 'Frank', 'Carol', 'Alice', 'Eve']);

  const link = screen.getByRole('link', { name: 'Alice' });
  assert.equal(link.getAttribute('href'), 'https://example.com/alice');
});

test('toggling sort direction reverses the order', () => {
  render(<Markdown>{SIX_ROW_TABLE}</Markdown>);

  fireEvent.change(screen.getByDisplayValue('table.sortPlaceholder'), { target: { value: '1' } });
  fireEvent.click(screen.getByLabelText('table.toggleSortDirection'));

  assert.deepEqual(namesInOrder(), ['Eve', 'Alice', 'Carol', 'Frank', 'Bob', 'Dave']);
});

test('filtering hides non-matching rows', () => {
  render(<Markdown>{SIX_ROW_TABLE}</Markdown>);

  fireEvent.change(screen.getByPlaceholderText('table.filterPlaceholder'), { target: { value: 'a' } });

  assert.deepEqual(namesInOrder().sort(), ['Alice', 'Carol', 'Dave', 'Frank']);
});

test('a filter matching nothing shows the empty state instead of an empty table', () => {
  render(<Markdown>{SIX_ROW_TABLE}</Markdown>);

  fireEvent.change(screen.getByPlaceholderText('table.filterPlaceholder'), { target: { value: 'zzz' } });

  assert.ok(screen.getByText('table.noRowsMatch'));
});
