import { Skeleton } from './Skeleton';
import { ReactNode } from 'react';

export interface DataTableColumn<T> {
  /** Stable column id */
  id: string;
  header: ReactNode;
  sortDirection?: 'ascending' | 'descending';
  /** Cell renderer */
  cell: (row: T, index: number) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Responsive visibility etc., applied to both th and td (e.g. "hidden sm:table-cell") */
  className?: string;
  /** Skeleton bar width class for the loading state (default w-20) */
  skeletonWidth?: string;
}

const ALIGN = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
} as const;

/**
 * DataTable — the one way to render a data table.
 *
 * Card-wrapped, horizontally scrollable table with the standard header
 * treatment, 44px rows, hover highlight, built-in skeleton loading, and an
 * empty-state slot. Every list view (blocks, txs, rich list, validators)
 * should render through this so tables cannot drift apart.
 *
 * Cells are fully custom via `cell` renderers — this component owns layout
 * and chrome, not content.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  skeletonRows = 15,
  empty,
  footer,
  stickyHeader = false,
  size = 'default',
  className = '',
  bare = false,
  rowClassName,
  caption,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  loading?: boolean;
  skeletonRows?: number;
  /** Rendered inside the card when rows are empty and not loading */
  empty?: ReactNode;
  /** Rendered inside the card, below the table (legend, footnote) */
  footer?: ReactNode;
  /** Pin the header row while the table scrolls (needs a bounded container) */
  stickyHeader?: boolean;
  /** Row density: default 44px archive rows, comfortable 52px preview widgets */
  size?: 'default' | 'comfortable';
  /** Skip the card wrapper — for tables embedded inside an existing Card */
  bare?: boolean;
  /** Extra classes per row (stale dimming, entry animations) */
  rowClassName?: (row: T, index: number) => string;
  className?: string;
  /** Screen-reader description of the table */
  caption?: string;
}) {
  const showEmpty = !loading && rows.length === 0 && empty;
  const rowHeight = size === 'comfortable' ? 'h-[52px]' : 'h-[44px]';

  return (
    <div aria-busy={loading || undefined} className={bare ? className : `card p-0 overflow-hidden ${className}`}>
      {loading && <span role="status" className="sr-only">Loading table data…</span>}
      <div className="overflow-x-auto">
        <table className="w-full">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className={stickyHeader ? 'sticky top-0 z-10 bg-cipher-surface-solid' : undefined}>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.id}
                  aria-sort={col.sortDirection}
                  className={`px-4 py-3 ${ALIGN[col.align ?? 'left']} text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border ${col.className ?? ''}`}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: skeletonRows }).map((_, i) => (
                  <tr key={i} aria-hidden="true">
                    {columns.map((col) => (
                      <td
                        key={col.id}
                        className={`px-4 ${rowHeight} border-b border-cipher-border ${col.className ?? ''}`}
                      >
                        <Skeleton
                          className={`h-4 ${col.skeletonWidth ?? 'w-20'} ${col.align === 'right' ? 'ml-auto' : col.align === 'center' ? 'mx-auto' : ''}`}
                        />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((row, i) => (
                  <tr
                    key={rowKey(row, i)}
                    className={`group transition-colors duration-100 hover:bg-cipher-hover ${rowClassName?.(row, i) ?? ''}`}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.id}
                        className={`px-4 ${rowHeight} border-b border-cipher-border ${ALIGN[col.align ?? 'left']} ${col.className ?? ''}`}
                      >
                        {col.cell(row, i)}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {showEmpty}
      {footer}
    </div>
  );
}
