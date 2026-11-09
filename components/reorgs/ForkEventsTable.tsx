'use client';

import Link from 'next/link';
import { formatRelativeTime } from '@/lib/utils';
import { Badge } from '@/components/ui';
import { ExportButton } from '@/components/ExportButton';
import { SortableDataTable, type SortableColumn } from '@/components/ui/SortableDataTable';
import type { ForkEvent } from './CompetingBlocks';

const columns: SortableColumn<ForkEvent>[] = [
  {
    id: 'height', header: 'Fork height', sortValue: f => f.forkHeight,
    cell: f => <Link href={`/block/${f.forkHeight}`} prefetch={false} className="font-mono text-xs text-cipher-gold hover:underline">#{f.forkHeight.toLocaleString('en-US')}</Link>,
  },
  {
    id: 'depth', header: 'Depth', align: 'center', sortValue: f => f.depth,
    cell: f => <Badge color={f.depth > 3 ? 'orange' : f.depth > 1 ? 'gold' : 'muted'}>{f.depth} block{f.depth === 1 ? '' : 's'}</Badge>,
  },
  {
    id: 'blocks', header: 'Orphaned', align: 'center', sortValue: f => f.orphanedCount || null,
    cell: f => <span className="font-mono text-xs text-secondary">{f.orphanedCount || '—'}</span>,
  },
  {
    id: 'source', header: 'Source', sortValue: f => f.source,
    cell: f => <Badge color={f.source === 'external' ? 'purple' : 'gold'}>{f.source}</Badge>,
  },
  {
    id: 'description', header: 'Description', className: 'hidden sm:table-cell',
    cell: f => <span className="block max-w-[320px] truncate text-xs text-secondary" title={f.description ?? undefined}>{f.description || '—'}</span>,
  },
  {
    id: 'detected', header: 'Detected', align: 'right', sortValue: f => Date.parse(f.detectedAt),
    cell: f => <span className="whitespace-nowrap font-mono text-xs text-muted">{f.detectedAt ? formatRelativeTime(new Date(f.detectedAt).getTime() / 1000) : '—'}</span>,
  },
];

/** One row per reorg our main node went through — the former Reorg History tab. */
export function ForkEventsTable({ forks }: { forks: ForkEvent[] }) {
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 sm:px-6 py-3">
        <p className="text-caption text-muted">Each reorg our main node went through, newest first (latest {forks.length}). Select a column heading to sort.</p>
        {forks.length > 0 && (
          <ExportButton
            type="csv"
            data={forks}
            filename="zecblock-reorg-history"
            csvHeaders={['Fork event', 'Fork height', 'Depth (blocks)', 'Orphaned blocks', 'Canonical tip', 'Source', 'Detected (UTC)', 'Resolved (UTC)', 'Description']}
            csvMapper={(f: ForkEvent) => [
              String(f.id), String(f.forkHeight), String(f.depth), String(f.orphanedCount), String(f.canonicalTip ?? ''),
              f.source, f.detectedAt, f.resolvedAt ?? '', f.description ?? '',
            ]}
          />
        )}
      </div>
      <SortableDataTable caption="Chain reorganization history" columns={columns} rows={forks} rowKey={f => f.id} />
    </div>
  );
}
