'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useApiQuery } from '@/hooks/useApiQuery';
import { Card, CardBody } from '@/components/ui/Card';
import { DataTable, SectionHeader } from '@/components/ui';

type Period = '24h' | '7d' | '30d';
interface PoolRate {
  name: string;
  canonicalBlocks: number;
  orphanedBlocks: number;
  rate: number | null;
}
interface RateWindow {
  period: Period;
  windowStart: string;
  windowEnd: string;
  canonicalBlocks: number;
  orphanedBlocks: number;
  rate: number | null;
  unavailableReason: string | null;
  pools: PoolRate[];
}
interface OrphanRates {
  method: string;
  asOf: string;
  indexedHeight: number | null;
  indexedTimestamp: string | null;
  periods: RateWindow[];
}

function percent(rate: number | null) {
  if (rate === null) return 'Unavailable';
  // Keep an observed positive loss from rounding to a misleading zero.
  return rate > 0 && rate < 0.0001 ? '<0.01%' : `${(rate * 100).toFixed(2)}%`;
}

function utc(value: string) {
  return new Date(value).toLocaleString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function OrphanRateSection() {
  const [period, setPeriod] = useState<Period>('7d');
  const { data, loading, error } = useApiQuery<OrphanRates>('/v1/mining/orphan-rates', undefined, { refreshInterval: 60_000 });
  const supported = data?.method === 'observed-indexer-reorg-v1';
  const selected = supported ? data.periods.find(window => window.period === period) : null;

  return (
    <section id="orphans" className="scroll-mt-36 mb-12">
      <Card><CardBody>
        <SectionHeader label="OBSERVED_ORPHAN_RATE" actions={<Link href="/reorgs" className="text-caption font-mono text-cipher-gold hover:underline">View forks &amp; orphaned blocks →</Link>} />
        <p className="text-sm text-muted mb-4">
          Blocks observed by this explorer that left the canonical chain during a reorganization, as a share of canonical blocks plus observed orphans.
        </p>
        <p className="text-caption text-muted mb-5">
          Competing blocks may be missed, and collection uptime is not verified. These observations do not establish the full network or any pool&apos;s true orphan rate.
        </p>
        {loading ? <p role="status" className="text-sm text-muted py-6">Loading observed orphan rates…</p> : !supported ? (
          <p role="status" className="text-sm text-muted py-6">Observed orphan rates are temporarily unavailable.</p>
        ) : <>
          {error && <p role="status" className="text-caption text-muted mb-3">Refresh failed. Showing the previous snapshot from {utc(data.asOf)} UTC.</p>}
          <div className="grid sm:grid-cols-3 gap-3 mb-6">
            {data.periods.map(window => (
              <button key={window.period} type="button" aria-pressed={period === window.period} onClick={() => setPeriod(window.period)}
                className={`card p-4 text-left transition ${period === window.period ? 'ring-1 ring-cipher-gold/40' : 'hover:bg-glass-3'}`}>
                <span className="block text-caption font-mono text-muted uppercase mb-2">{window.period} observed rate</span>
                <span className="block text-xl font-mono font-semibold text-primary mb-2">{percent(window.rate)}</span>
                <span className="block text-caption text-muted">{window.orphanedBlocks.toLocaleString()} observed orphans · {window.canonicalBlocks.toLocaleString()} canonical blocks</span>
              </button>
            ))}
          </div>
          {selected && <>
            <p className="text-caption text-muted mb-3">{utc(selected.windowStart)} – {utc(selected.windowEnd)} UTC · block-header timestamps</p>
            {selected.unavailableReason ? <p className="text-sm text-muted py-4">Canonical block history is insufficient for this window. The observed counts above are retained; a rate is unavailable.</p> :
              <DataTable bare columns={[
                { id: 'pool', header: 'Pool', cell: (pool: PoolRate) => <span className="font-mono text-xs text-primary">{pool.name}</span> },
                { id: 'canonical', header: 'Canonical blocks', align: 'right', cell: pool => <span className="font-mono text-xs tabular-nums">{pool.canonicalBlocks.toLocaleString()}</span> },
                { id: 'orphans', header: 'Observed orphans', align: 'right', cell: pool => <span className="font-mono text-xs tabular-nums">{pool.orphanedBlocks.toLocaleString()}</span> },
                { id: 'rate', header: 'Observed rate', align: 'right', cell: pool => <span className="font-mono text-xs tabular-nums">{percent(pool.rate)}</span> },
              ]} rows={selected.pools} rowKey={pool => pool.name} />}
          </>}
          <p className="text-caption text-muted mt-4">
            Observed orphans ÷ (canonical blocks + observed orphans). Pool labels use public coinbase data; Unknown remains included. Small samples can produce large percentages.{' '}
            Snapshot {utc(data.asOf)} UTC{data.indexedHeight != null && ` · indexed height ${data.indexedHeight.toLocaleString()}`}
            {data.indexedTimestamp && ` · tip header ${utc(data.indexedTimestamp)} UTC`}.
          </p>
        </>}
      </CardBody></Card>
    </section>
  );
}
