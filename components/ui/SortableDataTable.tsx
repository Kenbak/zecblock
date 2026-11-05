'use client';

import { useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { DataTable, type DataTableColumn } from './DataTable';

export interface SortableColumn<T> extends DataTableColumn<T> {
  /** Value used to sort this column; columns without it are not sortable. */
  sortValue?: (row: T) => number | string | null | undefined;
}

type Direction = 'ascending' | 'descending';

function compare(a: number | string | null | undefined, b: number | string | null | undefined): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

/**
 * DataTable with client-side column sorting for complete, already-loaded rows.
 * Header buttons expose aria-sort; missing values always sort last. Do not use
 * it for server-paginated lists, where sorting one page would mislead.
 */
export function SortableDataTable<T>({ columns, rows, initialSort, caption, ...props }: Omit<ComponentProps<typeof DataTable<T>>, 'columns'> & {
  columns: SortableColumn<T>[];
  initialSort?: { id: string; direction: Direction };
  caption: string;
}) {
  const [sort, setSort] = useState<{ id: string; direction: Direction } | null>(initialSort ?? null);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find(col => col.id === sort.id);
    if (!column?.sortValue) return rows;
    const value = column.sortValue;
    const sign = sort.direction === 'ascending' ? 1 : -1;
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const va = value(a.row), vb = value(b.row);
        if (va == null || vb == null) return compare(va, vb) || a.index - b.index;
        return sign * compare(va, vb) || a.index - b.index;
      })
      .map(entry => entry.row);
  }, [columns, rows, sort]);

  const headerColumns = columns.map((col): DataTableColumn<T> => {
    if (!col.sortValue) return col;
    const active = sort?.id === col.id;
    const nextDirection: Direction = active && sort.direction === 'descending' ? 'ascending' : 'descending';
    const header: ReactNode = (
      <button
        type="button"
        onClick={() => setSort({ id: col.id, direction: nextDirection })}
        className={`inline-flex items-center gap-1 uppercase tracking-wider hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold rounded ${active ? 'text-primary' : ''}`}
      >
        {col.header}
        <span aria-hidden="true" className="text-caption">{active ? (sort.direction === 'descending' ? '↓' : '↑') : '↕'}</span>
      </button>
    );
    return { ...col, header, sortDirection: active ? sort.direction : undefined };
  });

  return <DataTable {...props} columns={headerColumns} rows={sortedRows} caption={`${caption}. Select a column heading to sort.`} />;
}
