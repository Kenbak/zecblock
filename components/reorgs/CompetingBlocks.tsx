'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { formatRelativeTime } from '@/lib/utils';
import { Badge, Card, CardBody, EmptyState, FilterButton, FilterGroup, HashLink, Select } from '@/components/ui';
import { BlockFirstSeen } from '@/components/BlockFirstSeen';
import { PoolLogo } from '@/components/PoolLogo';
import { ExportButton } from '@/components/ExportButton';

export interface ReorgBlockSide {
  hash: string;
  firstSeenAt?: string | null;
  timestamp: number | null;
  transactionCount: number | null;
  size: number | null;
  minerAddress: string | null;
  minerPool: string | null;
  minerPoolUrl?: string | null;
  source?: string;
}

/** A block our main node accepted and later switched away from (`/v1/uncles`). */
export interface OrphanedBlock {
  id: number;
  height: number;
  hash: string;
  firstSeenAt?: string | null;
  canonicalHash: string | null;
  timestamp: number | null;
  transactionCount: number;
  size: number;
  minerAddress: string | null;
  minerPool: string | null;
  source: string;
  detectedAt: string;
  forkEventId: number | null;
  canonicalBlock?: ReorgBlockSide | null;
}

/** A competing block only the observer network received (`/v1/uncles/observed`). Disjoint from OrphanedBlock by hash. */
export interface ObservedOrphan {
  height: number;
  hash: string;
  timestamp: number | null;
  firstSeenAt: string | null;
  observerCount: number | null;
  minerAddress: string | null;
  minerPool: string | null;
  canonicalBlock: ReorgBlockSide | null;
}

export interface ForkEvent {
  id: number;
  forkHeight: number;
  depth: number;
  orphanedCount: number;
  source: string;
  detectedAt: string;
}

export type CaughtBy = 'node' | 'observers';

interface CompetingBlock {
  key: string;
  height: number;
  hash: string;
  timestamp: number | null;
  firstSeenAt: string | null;
  caughtBy: CaughtBy;
  observerCount: number | null;
  depth: number | null;
  minerPool: string | null;
  minerAddress: string | null;
  transactionCount: number | null;
  size: number | null;
  canonical: ReorgBlockSide | null;
}

export function isUnknownPool(pool: string | null | undefined) {
  return !pool || /^Unknown/i.test(pool);
}

export function minerName(pool: string | null | undefined) {
  return isUnknownPool(pool) ? 'Unknown' : pool!;
}

function buildRows(orphans: OrphanedBlock[], observed: ObservedOrphan[], forks: ForkEvent[]): CompetingBlock[] {
  const depthByEvent = new Map(forks.map(f => [f.id, f.depth]));
  const rows: CompetingBlock[] = [
    ...orphans.map((b): CompetingBlock => ({
      key: `n-${b.id}`,
      height: b.height,
      hash: b.hash,
      timestamp: b.timestamp,
      firstSeenAt: b.firstSeenAt ?? null,
      caughtBy: 'node',
      observerCount: null,
      depth: b.forkEventId != null ? depthByEvent.get(b.forkEventId) ?? null : null,
      minerPool: b.minerPool,
      minerAddress: b.minerAddress,
      transactionCount: b.transactionCount,
      size: b.size,
      canonical: b.canonicalBlock ?? (b.canonicalHash ? { hash: b.canonicalHash, timestamp: null, transactionCount: null, size: null, minerAddress: null, minerPool: null } : null),
    })),
    ...observed.map((b): CompetingBlock => ({
      key: `o-${b.hash}`,
      height: b.height,
      hash: b.hash,
      timestamp: b.timestamp,
      firstSeenAt: b.firstSeenAt,
      caughtBy: 'observers',
      observerCount: b.observerCount,
      depth: null,
      minerPool: b.minerPool,
      minerAddress: b.minerAddress,
      transactionCount: null,
      size: null,
      canonical: b.canonicalBlock,
    })),
  ];
  return rows.sort((a, b) => b.height - a.height || (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

function MinerLabel({ pool, address, tone = 'gold' }: { pool: string | null; address: string | null; tone?: 'gold' | 'muted' }) {
  if (isUnknownPool(pool)) {
    return address
      ? <HashLink value={address} href={`/address/${address}`} lead={6} tail={4} copy={false} />
      : <span className="text-xs text-muted">Unknown</span>;
  }
  const cls = `inline-flex items-center gap-2 max-w-[160px] text-xs font-mono ${tone === 'gold' ? 'text-cipher-gold' : 'text-secondary'}`;
  const label = <><PoolLogo name={pool!} /><span className="truncate">{pool}</span></>;
  return address
    ? <Link href={`/address/${address}`} prefetch={false} className={`${cls} hover:underline`} title={address} onClick={e => e.stopPropagation()}>{label}</Link>
    : <span className={cls}>{label}</span>;
}

function CaughtTag({ row }: { row: CompetingBlock }) {
  if (row.caughtBy === 'node') {
    return <span className="inline-flex items-center gap-1.5 text-caption font-mono text-secondary" title="Our main node accepted this block, then switched to the winning chain">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-cipher-orange" />Our node reorged
    </span>;
  }
  const n = row.observerCount;
  return <span className="inline-flex items-center gap-1.5 text-caption font-mono text-muted" title="Observer nodes received this block; our main node never switched to it">
    <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-muted" />{n != null ? `${n} observer${n === 1 ? '' : 's'}` : 'Observers'}
  </span>;
}

function SideCard({ label, block, height, lost }: { label: string; block: ReorgBlockSide; height: number; lost: boolean }) {
  const tone = lost ? 'text-cipher-orange' : 'text-cipher-green';
  return (
    <div className={`flex-1 min-w-0 rounded-lg border p-4 ${lost ? 'border-cipher-orange/30 bg-cipher-orange/5' : 'border-cipher-green/30 bg-cipher-green/5'}`}>
      <div className="flex items-center justify-between mb-3">
        <span className={`text-caption font-mono uppercase tracking-wider font-semibold ${tone}`}>{label}</span>
        <Badge color={lost ? 'orange' : 'green'}>{lost ? 'Orphaned' : 'Canonical'}</Badge>
      </div>
      <div className="space-y-2.5">
        <div>
          <span className="text-caption text-muted font-mono uppercase">Hash</span>
          <Link href={lost ? `/block/${block.hash}` : `/block/${height}`} prefetch={false} className={`text-xs font-mono break-all hover:underline block mt-0.5 ${tone}`}>{block.hash}</Link>
        </div>
        <div>
          <span className="text-caption text-muted font-mono uppercase">Miner</span>
          <div className="mt-1"><MinerLabel pool={block.minerPool} address={block.minerAddress} tone="muted" /></div>
        </div>
        <BlockFirstSeen value={block.firstSeenAt} />
        <div className="flex gap-6">
          <div>
            <span className="text-caption text-muted font-mono uppercase">TXs</span>
            <div className="text-xs font-mono text-secondary">{block.transactionCount ?? '—'}</div>
          </div>
          <div>
            <span className="text-caption text-muted font-mono uppercase">Block time</span>
            <div className="text-xs font-mono text-secondary">{block.timestamp ? formatRelativeTime(block.timestamp) : '—'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

const PAGE = 25;

const WINDOW_SECONDS = { '24h': 86_400, '7d': 7 * 86_400, '30d': 30 * 86_400 } as const;

export function CompetingBlocks({
  orphans, observed, forks, miner, onMinerChange, loading, window,
}: {
  window: keyof typeof WINDOW_SECONDS;
  orphans: OrphanedBlock[];
  observed: ObservedOrphan[];
  forks: ForkEvent[];
  miner: string | null;
  onMinerChange: (miner: string | null) => void;
  loading: boolean;
}) {
  const [caught, setCaught] = useState<'all' | CaughtBy>('all');
  const [deepOnly, setDeepOnly] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [expanded, setExpanded] = useState<string | null>(null);

  const allRows = useMemo(() => buildRows(orphans, observed, forks), [orphans, observed, forks]);
  // Same rolling window (by block header time) as the summary above, so pool counts line up.
  const rows = useMemo(() => {
    const cutoff = Date.now() / 1000 - WINDOW_SECONDS[window];
    return allRows.filter(r => r.timestamp != null && r.timestamp >= cutoff);
  }, [allRows, window]);
  const deepCount = rows.filter(r => (r.depth ?? 0) >= 2).length;
  const miners = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(minerName(r.minerPool), (counts.get(minerName(r.minerPool)) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const filtered = useMemo(() => rows.filter(r =>
    (caught === 'all' || r.caughtBy === caught)
    && (!deepOnly || (r.depth ?? 0) >= 2)
    && (!miner || minerName(r.minerPool).toLowerCase() === miner.toLowerCase())
  ), [rows, caught, deepOnly, miner]);
  const visible = filtered.slice(0, shown);
  const nodeCount = rows.filter(r => r.caughtBy === 'node').length;

  return (
    <Card>
      <CardBody>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex flex-wrap items-center gap-2">
            <FilterGroup inline>
              <FilterButton active={caught === 'all'} onClick={() => { setCaught('all'); setShown(PAGE); }}>All {rows.length}</FilterButton>
              <FilterButton active={caught === 'node'} onClick={() => { setCaught('node'); setShown(PAGE); }}>Our node reorged {nodeCount}</FilterButton>
              <FilterButton active={caught === 'observers'} onClick={() => { setCaught('observers'); setShown(PAGE); }}>Observers only {rows.length - nodeCount}</FilterButton>
            </FilterGroup>
            {(deepCount > 0 || deepOnly) && (
              <FilterGroup inline>
                <FilterButton active={deepOnly} onClick={() => { setDeepOnly(v => !v); setShown(PAGE); }}>Reorg ≥ 2 blocks {deepCount}</FilterButton>
              </FilterGroup>
            )}
            <Select aria-label="Miner" value={miner ?? ''} onChange={e => { onMinerChange(e.target.value || null); setShown(PAGE); }}>
              <option value="">All miners</option>
              {miners.map(([name, n]) => <option key={name} value={name}>{name} ({n})</option>)}
            </Select>
          </div>
          {filtered.length > 0 && (
            <ExportButton
              type="csv"
              data={filtered}
              filename="zecblock-competing-blocks"
              csvHeaders={['Height', 'Lost hash', 'Winning hash', 'Caught by', 'Observers', 'Reorg depth', 'Lost by pool', 'Lost by address', 'Winning pool', 'Block time (UTC)', 'First seen (UTC)']}
              csvMapper={(r: CompetingBlock) => [
                String(r.height), r.hash, r.canonical?.hash ?? '', r.caughtBy === 'node' ? 'our node reorged' : 'observers only', String(r.observerCount ?? ''), String(r.depth ?? ''),
                r.minerPool ?? '', r.minerAddress ?? '', r.canonical?.minerPool ?? '', r.timestamp ? new Date(r.timestamp * 1000).toISOString() : '', r.firstSeenAt ?? '',
              ]}
            />
          )}
        </div>

        <dl className="mb-4 grid gap-2 text-caption text-muted sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="inline-flex shrink-0 items-center gap-1.5 font-mono text-secondary"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-cipher-orange" />Our node reorged</dt>
            <dd>Our main node accepted the block, then switched to the winner.</dd>
          </div>
          <div className="flex gap-2">
            <dt className="inline-flex shrink-0 items-center gap-1.5 font-mono text-secondary"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-muted" />N observers</dt>
            <dd>Lost before our node switched; N is how many of our observer nodes received it.</dd>
          </div>
        </dl>

        {loading && rows.length === 0 ? (
          <EmptyState title="Loading competing blocks…" />
        ) : filtered.length === 0 ? (
          <EmptyState title="No competing blocks match these filters" action={(miner || deepOnly || caught !== 'all') ? (
            <button type="button" onClick={() => { setCaught('all'); setDeepOnly(false); onMinerChange(null); }} className="text-xs font-mono text-cipher-gold hover:underline">Clear filters</button>
          ) : undefined} />
        ) : (
          <div className="-mx-4 sm:-mx-6 overflow-x-auto">
            <table className="w-full">
              <caption className="sr-only">Competing blocks that lost the race, newest first. Select a row to compare it with the winning block.</caption>
              <thead>
                <tr className="text-caption font-semibold uppercase tracking-wider text-muted">
                  <th scope="col" className="px-4 sm:px-6 py-3 text-left border-b border-cipher-border">Height</th>
                  <th scope="col" className="px-4 py-3 text-left border-b border-cipher-border">Lost by</th>
                  <th scope="col" className="px-4 py-3 text-left border-b border-cipher-border hidden md:table-cell">Won by</th>
                  <th scope="col" className="px-4 py-3 text-left border-b border-cipher-border">Caught by</th>
                  <th scope="col" className="px-4 sm:px-6 py-3 text-right border-b border-cipher-border">Time</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(row => {
                  const open = expanded === row.key;
                  return (
                    <React.Fragment key={row.key}>
                      <tr className={`cursor-pointer transition-colors hover:bg-cipher-hover ${open ? 'bg-cipher-hover' : ''}`}
                        onClick={() => setExpanded(open ? null : row.key)}>
                        <td className="px-4 sm:px-6 py-2.5 border-b border-cipher-border whitespace-nowrap">
                          <button type="button" aria-expanded={open} aria-label={`Compare competing blocks at height ${row.height.toLocaleString('en-US')}`}
                            onClick={e => { e.stopPropagation(); setExpanded(open ? null : row.key); }}
                            className={`mr-2 text-muted transition-transform ${open ? 'rotate-90' : ''}`}>›</button>
                          <Link href={`/block/${row.hash}`} prefetch={false} onClick={e => e.stopPropagation()} className="font-mono text-xs text-cipher-gold hover:underline">
                            #{row.height.toLocaleString('en-US')}
                          </Link>
                          {(row.depth ?? 0) >= 2 && <span className="ml-2"><Badge color="orange">{row.depth}-block reorg</Badge></span>}
                        </td>
                        <td className="px-4 py-2.5 border-b border-cipher-border"><MinerLabel pool={row.minerPool} address={row.minerAddress} /></td>
                        <td className="px-4 py-2.5 border-b border-cipher-border hidden md:table-cell">
                          {row.canonical ? <MinerLabel pool={row.canonical.minerPool} address={row.canonical.minerAddress} tone="muted" /> : <span className="text-xs text-muted">—</span>}
                        </td>
                        <td className="px-4 py-2.5 border-b border-cipher-border whitespace-nowrap"><CaughtTag row={row} /></td>
                        <td className="px-4 sm:px-6 py-2.5 border-b border-cipher-border text-right text-xs text-muted font-mono whitespace-nowrap">
                          {row.timestamp ? formatRelativeTime(row.timestamp) : '—'}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={5} className="px-4 sm:px-6 py-4 bg-cipher-surface border-b border-cipher-border">
                            <div className="flex flex-col lg:flex-row gap-3">
                              <SideCard label="Lost block" lost height={row.height} block={{
                                hash: row.hash, firstSeenAt: row.firstSeenAt, timestamp: row.timestamp, transactionCount: row.transactionCount,
                                size: row.size, minerAddress: row.minerAddress, minerPool: row.minerPool,
                              }} />
                              <div className="hidden lg:flex items-center px-1 text-muted font-mono text-xs">vs</div>
                              {row.canonical
                                ? <SideCard label="Winning block" lost={false} height={row.height} block={row.canonical} />
                                : <div className="flex-1 rounded-lg border border-cipher-border bg-glass-2 p-4 flex items-center justify-center text-xs text-muted font-mono">Winning block not indexed</div>}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {filtered.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-caption text-muted">
            <span>Showing {visible.length} of {filtered.length} in the last {window === '24h' ? '24 hours' : window === '7d' ? '7 days' : '30 days'} · loaded from the latest {orphans.length} node reorgs and {observed.length} observer-only blocks</span>
            {visible.length < filtered.length && (
              <button type="button" onClick={() => setShown(s => s + PAGE)} className="font-mono text-cipher-gold hover:underline">Show {Math.min(PAGE, filtered.length - visible.length)} more</button>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
