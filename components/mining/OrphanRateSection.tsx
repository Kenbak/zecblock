'use client';

import Link from 'next/link';
import { useApiQuery } from '@/hooks/useApiQuery';
import { Card, CardBody } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui';
import { useUrlState } from '@/lib/use-url-state';
import { SortableDataTable } from '@/components/ui/SortableDataTable';

type Period = '24h' | '7d' | '30d' | 'pre-nu7' | 'nu7';
const PERIOD_LABELS: Record<Period, string> = { '24h': '24h', '7d': '7d', '30d': '30d', 'pre-nu7': 'Before NU7', nu7: 'Since NU7' };
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
/** Present only once the NU7 activation block is indexed. */
interface Nu7Comparison { activationHeight: number | null; activationTimestamp: string; before: RateWindow; since: RateWindow }
interface OrphanRates {
  method: string;
  capture?: { startedAt: string | null; heartbeatAt: string | null; observers: number; healthyObservers: number; status: string };
  asOf: string;
  indexedHeight: number | null;
  indexedTimestamp: string | null;
  periods: RateWindow[];
  nu7?: Nu7Comparison | null;
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
  const [period, setPeriod] = useUrlState<Period>('orphans', '30d', ['24h', '7d', '30d', 'pre-nu7', 'nu7']);
  const { data, loading, error } = useApiQuery<OrphanRates>('/v1/mining/orphan-rates', undefined, { refreshInterval: 60_000 });
  const supported = data?.method === 'observed-indexer-reorg-v1' || data?.method === 'observed-block-capture-v2';
  const nu7 = supported ? data.nu7 ?? null : null;
  const windows = supported ? [...data.periods, ...(nu7 ? [nu7.before, nu7.since] : [])] : [];
  // A shared NU7 link opened before activation falls back to the default window.
  const selected = windows.find(window => window.period === period) ?? windows.find(window => window.period === '30d') ?? null;

  return (
    <section id="orphans" className="scroll-mt-36 mb-12">
      <Card><CardBody>
        <SectionHeader label="OBSERVED_ORPHAN_RATE" actions={<Link href="/reorgs" className="text-caption font-mono text-cipher-gold hover:underline">View forks &amp; orphaned blocks →</Link>} />
        <p className="text-sm text-muted mb-4">
          {data?.method === 'observed-block-capture-v2'
            ? 'Observed blocks outside the current canonical chain, including captured competing blocks and blocks removed by reorgs, as a share of canonical blocks plus observed orphans.'
            : 'Blocks observed by this explorer that left the canonical chain during a reorganization, as a share of canonical blocks plus observed orphans.'}
        </p>
        <p className="text-caption text-muted mb-5">
          Competing blocks may be missed, and collection uptime is not verified. These observations do not establish the full network or any pool&apos;s true orphan rate.
        </p>
        {supported && data.capture && <p className="text-caption text-muted mb-5">
          Competing-block collector: {data.capture.status === 'collecting' ? 'collecting' : 'currently unavailable'}.
          {data.capture.startedAt && ` Capture began ${utc(data.capture.startedAt)} UTC; earlier periods have less coverage.`}
          {' '}Saved observations remain included during interruptions.
        </p>}
        {loading ? <p role="status" className="text-sm text-muted py-6">Loading observed orphan rates…</p> : !supported ? (
          <p role="status" className="text-sm text-muted py-6">Observed orphan rates are temporarily unavailable.</p>
        ) : <>
          {error && <p role="status" className="text-caption text-muted mb-3">Refresh failed. Showing the previous snapshot from {utc(data.asOf)} UTC.</p>}
          <div className={`grid grid-cols-2 sm:grid-cols-3 ${nu7 ? 'lg:grid-cols-5' : ''} gap-3 mb-6`}>
            {windows.map(window => (
              <button key={window.period} type="button" aria-pressed={selected?.period === window.period} onClick={() => setPeriod(window.period)}
                className={`card p-4 text-left transition ${selected?.period === window.period ? 'ring-1 ring-cipher-gold/40' : 'hover:bg-glass-3'} ${window.period === 'nu7' ? 'border-cipher-gold/30' : ''}`}>
                <span className={`block text-caption font-mono uppercase mb-2 ${window.period === 'nu7' ? 'text-cipher-gold' : 'text-muted'}`}>{PERIOD_LABELS[window.period]} observed rate</span>
                <span className="block text-xl font-mono font-semibold text-primary mb-2">{percent(window.rate)}</span>
                <span className="block text-caption text-muted">{window.orphanedBlocks.toLocaleString()} observed orphans · {window.canonicalBlocks.toLocaleString()} canonical blocks</span>
              </button>
            ))}
          </div>
          {selected && <>
            <p className="text-caption text-muted mb-3">{utc(selected.windowStart)} – {utc(selected.windowEnd)} UTC · block-header timestamps</p>
            {selected.unavailableReason === 'capture-began-after-activation' ? <p className="text-sm text-muted py-4">Competing-block capture began after NU7 activated on this network, so there is no comparable before-NU7 window.</p>
              : selected.unavailableReason ? <p className="text-sm text-muted py-4">Canonical block history is insufficient for this window. The observed counts above are retained; a rate is unavailable.</p> :
              <SortableDataTable bare caption={`Observed orphan rate by mining pool, ${PERIOD_LABELS[selected.period]}`} columns={[
                { id: 'pool', header: 'Pool', sortValue: (pool: PoolRate) => pool.name, cell: (pool: PoolRate) => <span className="font-mono text-xs text-primary">{pool.name}</span> },
                { id: 'canonical', header: 'Canonical blocks', align: 'right', sortValue: pool => pool.canonicalBlocks, cell: pool => <span className="font-mono text-xs tabular-nums">{pool.canonicalBlocks.toLocaleString()}</span> },
                { id: 'orphans', header: 'Observed orphans', align: 'right', sortValue: pool => pool.orphanedBlocks, cell: pool => <span className="font-mono text-xs tabular-nums">{pool.orphanedBlocks.toLocaleString()}</span> },
                { id: 'rate', header: 'Observed rate', align: 'right', sortValue: pool => pool.rate, cell: pool => <span className="font-mono text-xs tabular-nums">{percent(pool.rate)}</span> },
              ]} rows={selected.pools} rowKey={pool => pool.name} />}
          </>}
          <p className="text-caption text-muted mt-4">
            {nu7 ? <>Before NU7 covers up to 30 days before activation{nu7.activationHeight != null && ` at block #${nu7.activationHeight.toLocaleString('en-US')}`}, from no earlier than competing-block capture; Since NU7 starts at its header time. With 25-second blocks, more blocks compete in the same time.{' '}</>
              : <>Before NU7 and Since NU7 windows appear once the activation block is indexed.{' '}</>}
            Observed orphans ÷ (canonical blocks + observed orphans). Pool labels use public coinbase data; Unknown remains included. Small samples can produce large percentages.{' '}
            Snapshot {utc(data.asOf)} UTC{data.indexedHeight != null && ` · indexed height ${data.indexedHeight.toLocaleString()}`}
            {data.indexedTimestamp && ` · tip header ${utc(data.indexedTimestamp)} UTC`}.
          </p>
        </>}
      </CardBody></Card>
    </section>
  );
}
