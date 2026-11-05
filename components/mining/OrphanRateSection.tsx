'use client';

import { Fragment } from 'react';
import Link from 'next/link';
import { useApiQuery } from '@/hooks/useApiQuery';
import { Card, CardBody } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui';
import { useUrlState } from '@/lib/use-url-state';
import { SortableDataTable } from '@/components/ui/SortableDataTable';
import { PoolLogo } from '@/components/PoolLogo';

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
  capture?: {
    startedAt: string | null; heartbeatAt: string | null; observers: number; healthyObservers: number; status: string;
    /** Public city per known observer; names, endpoints and IPs are never served. */
    /** operator is null for ZecBlock's own observers, else the partner that runs the node. */
    locations?: { city: string; operator?: string | null; collecting: boolean }[];
    unlistedObservers?: number;
  };
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

// Partner operators credited with a link; anything else from the API renders as plain text.
const PARTNER_LINKS: Record<string, string> = { 'zecminingpool.com': 'https://zecminingpool.com' };

const chip = 'inline-flex items-center rounded border border-cipher-border px-1.5 py-0.5 font-mono text-secondary';

/** "Observers: [Helsinki] [New York] … · via zecminingpool.com: [Austin] …"; partners link only from the allowlist. */
function ObserverChips({ capture }: { capture: NonNullable<OrphanRates['capture']> }) {
  const locations = capture.locations ?? [];
  const own = locations.filter(l => !l.operator);
  const partners = new Map<string, typeof locations>();
  for (const l of locations) if (l.operator) partners.set(l.operator, [...(partners.get(l.operator) ?? []), l]);
  const cities = (list: typeof locations) => list.map(l => (
    <span key={`${l.operator ?? ''}|${l.city}`} className={`${chip} ${l.collecting ? '' : 'opacity-50'}`} title={l.collecting ? undefined : 'Not collecting right now'}>{l.city}</span>
  ));
  return <>
    <span className="text-muted">Observers</span>
    {cities(own)}
    {[...partners].map(([operator, list]) => {
      const href = PARTNER_LINKS[operator];
      return <Fragment key={operator}>
        <span className="text-muted">· via {href ? <a href={href} target="_blank" rel="noopener" className="text-cipher-gold hover:underline">{operator}</a> : operator}</span>
        {cities(list)}
      </Fragment>;
    })}
    {capture.unlistedObservers ? <span className="text-muted">+{capture.unlistedObservers} more</span> : null}
  </>;
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
        <p className="text-sm text-muted mb-4">How often a block loses the race to a competing block, as seen by our observers.</p>
        {supported && data.capture && <div className="flex flex-wrap items-center gap-x-2 gap-y-2 mb-5 text-caption">
          <span className={`inline-flex items-center gap-1.5 font-mono ${data.capture.status === 'collecting' ? 'text-cipher-green' : 'text-muted'}`}>
            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${data.capture.status === 'collecting' ? 'bg-cipher-green' : 'bg-muted'}`} />
            {data.capture.status === 'collecting' ? 'Collecting' : 'Collector unavailable'}
          </span>
          {data.capture.locations?.length ? <><span className="text-muted">·</span><ObserverChips capture={data.capture} /></> : null}
        </div>}
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
                { id: 'pool', header: 'Pool', sortValue: (pool: PoolRate) => pool.name, cell: (pool: PoolRate) => <span className="inline-flex items-center gap-2 font-mono text-xs text-primary"><PoolLogo name={pool.name} />{pool.name}</span> },
                { id: 'canonical', header: 'Canonical blocks', align: 'right', sortValue: pool => pool.canonicalBlocks, cell: pool => <span className="font-mono text-xs tabular-nums">{pool.canonicalBlocks.toLocaleString()}</span> },
                { id: 'orphans', header: 'Observed orphans', align: 'right', sortValue: pool => pool.orphanedBlocks, cell: pool => <span className="font-mono text-xs tabular-nums">{pool.orphanedBlocks.toLocaleString()}</span> },
                { id: 'rate', header: 'Observed rate', align: 'right', sortValue: pool => pool.rate, cell: pool => <span className="font-mono text-xs tabular-nums">{percent(pool.rate)}</span> },
              ]} rows={selected.pools} rowKey={pool => pool.name} />}
          </>}
          <p className="text-caption text-muted mt-4">
            Snapshot {utc(data.asOf)} UTC{data.indexedHeight != null && ` · indexed height ${data.indexedHeight.toLocaleString()}`}
            {data.indexedTimestamp && ` · tip header ${utc(data.indexedTimestamp)} UTC`}
          </p>
          <details className="mt-3 text-caption text-muted">
            <summary className="cursor-pointer select-none text-secondary hover:text-primary">How this is measured</summary>
            <div className="mt-2 space-y-2 max-w-3xl">
              <p>
                Rate = observed orphans ÷ (canonical blocks + observed orphans), by block-header time.
                {data.method === 'observed-block-capture-v2'
                  ? ' Orphans are competing blocks our observers received plus blocks removed by reorgs.'
                  : ' Orphans are blocks this explorer saw leave the canonical chain in a reorganization.'}
                {' '}A competing block counts if any observer received it. Pool labels use public coinbase data; Unknown remains included. Small samples can produce large percentages.
              </p>
              <p>
                Competing blocks can still be missed and collection uptime is not verified, so this is not the whole network&apos;s or any pool&apos;s true orphan rate.
                {data.capture?.startedAt && ` Capture began ${utc(data.capture.startedAt)} UTC; earlier periods have less coverage.`}
                {' '}Saved observations stay included during interruptions.
              </p>
              <p>
                {nu7 ? <>Before NU7 covers up to 30 days before activation{nu7.activationHeight != null && ` at block #${nu7.activationHeight.toLocaleString('en-US')}`}, from no earlier than competing-block capture; Since NU7 starts at its header time. With 25-second blocks, more blocks compete in the same time.</>
                  : <>Before NU7 and Since NU7 windows appear once the activation block is indexed.</>}
              </p>
            </div>
          </details>
        </>}
      </CardBody></Card>
    </section>
  );
}
