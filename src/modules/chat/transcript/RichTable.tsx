import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Input } from '@/shared/ui';
import { childrenToText } from '@/modules/chat/utils/chatFormatting';

type RichTableProps = {
  children?: React.ReactNode;
};

type SortState = { column: number; direction: 'asc' | 'desc' } | null;

// Below this many data rows, sort/filter chrome is noise, not help.
const TOOLBAR_ROW_THRESHOLD = 4;

const elementChildren = (element: React.ReactElement | undefined): React.ReactElement[] =>
  React.Children.toArray((element?.props as { children?: React.ReactNode } | undefined)?.children)
    .filter(React.isValidElement) as React.ReactElement[];

function compareCellText(a: string, b: string): number {
  const numA = Number(a);
  const numB = Number(b);
  if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(numA) && Number.isFinite(numB)) {
    return numA - numB;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

const PlainTable = ({ children }: RichTableProps) => (
  <div className="my-3 overflow-x-auto rounded-lg border border-border">
    {/* my-0 cancels Tailwind Typography's table margin, which would show as blank bands inside the border */}
    <table className="my-0 min-w-full border-collapse text-sm">{children}</table>
  </div>
);

/**
 * Replaces the plain `table` markdown override with a sortable, filterable
 * one. `thead`/`tr`/`th`/`td` are untouched — this reads their already
 * rendered output (so links, bold text, code spans inside cells survive
 * unchanged) via `childrenToText`, and only reorders/filters which `<tr>`
 * elements are mounted. No data-grid dependency: row counts here are small
 * enough that plain `useState`/`useMemo` covers it.
 */
export function RichTable({ children }: RichTableProps) {
  const { t } = useTranslation('chat');
  const [filterText, setFilterText] = useState('');
  const [sort, setSort] = useState<SortState>(null);

  const [theadElement, tbodyElement] = useMemo(
    () => React.Children.toArray(children).filter(React.isValidElement) as React.ReactElement[],
    [children],
  );

  const headerCells = useMemo(() => elementChildren(elementChildren(theadElement)[0]), [theadElement]);
  const columnNames = useMemo(() => headerCells.map((cell) => childrenToText(cell)), [headerCells]);
  const rowElements = useMemo(() => elementChildren(tbodyElement), [tbodyElement]);
  const rowTexts = useMemo(
    () => rowElements.map((row) => elementChildren(row).map((cell) => childrenToText(cell))),
    [rowElements],
  );

  const visibleOrder = useMemo(() => {
    let indices = rowElements.map((_, index) => index);

    const needle = filterText.trim().toLowerCase();
    if (needle) {
      indices = indices.filter((index) => rowTexts[index]?.some((cell) => cell.toLowerCase().includes(needle)));
    }

    if (sort) {
      const { column, direction } = sort;
      indices = [...indices].sort((a, b) => {
        const result = compareCellText(rowTexts[a]?.[column] ?? '', rowTexts[b]?.[column] ?? '');
        return direction === 'asc' ? result : -result;
      });
    }

    return indices;
  }, [rowElements, rowTexts, filterText, sort]);

  // Anything structurally unexpected (no tbody, a malformed tree) falls back
  // to the plain table rather than risking a wrong "no rows match" state.
  if (!theadElement || !tbodyElement || rowElements.length === 0) {
    return <PlainTable>{children}</PlainTable>;
  }

  const showToolbar = rowElements.length > TOOLBAR_ROW_THRESHOLD;

  return (
    <div className="my-3 space-y-2">
      {showToolbar && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-40 max-w-xs flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              placeholder={t('table.filterPlaceholder')}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <select
            value={sort?.column ?? ''}
            onChange={(event) => {
              const { value } = event.target;
              setSort(value === '' ? null : { column: Number(value), direction: sort?.direction ?? 'asc' });
            }}
            className="h-8 rounded-md border border-input bg-card px-2 text-xs text-foreground"
          >
            <option value="">{t('table.sortPlaceholder')}</option>
            {columnNames.map((name, index) => (
              <option key={index} value={index}>{name || `${index + 1}`}</option>
            ))}
          </select>
          {sort && (
            <button
              type="button"
              onClick={() => setSort(sort && { ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' })}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-input bg-card text-muted-foreground hover:text-foreground"
              aria-label={t('table.toggleSortDirection')}
            >
              {sort.direction === 'asc' ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="my-0 min-w-full border-collapse text-sm">
          {theadElement}
          <tbody>
            {visibleOrder.length > 0 ? (
              visibleOrder.map((index) => rowElements[index])
            ) : (
              <tr>
                <td colSpan={columnNames.length || 1} className="px-3 py-4 text-center text-sm text-muted-foreground">
                  {t('table.noRowsMatch')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
