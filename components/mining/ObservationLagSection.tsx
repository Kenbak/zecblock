'use client';

import { useApiQuery } from '@/hooks/useApiQuery';
import { Card, CardBody } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui';
import { useUrlState } from '@/lib/use-url-state';
import { SortableDataTable } from '@/components/ui/SortableDataTable';
import { formatObservationLag } from '@/components/BlockFirstSeen';

type Period = '24h' | '7d' | '30d';
interface LagSummary {
  blocks: number;
  observed: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  headerAfterSeen: number;
}
interface PoolLag extends LagSummary { name: string }
interface LagWindow extends LagSummary {
  period: Period;
  windowStart: string;
  windowEnd: string;
  pools: PoolLag[];
}
interface ObservationLag {
  method: string;
  asOf: string;
  minSample: number;
  collectionStart: string | null;
  periods: LagWindow[];
}

function lag(seconds: number | null) {
  return seconds === null ? '—' : formatObservationLag(seconds);
}

function share(part: number, whole: number) {
  if (!whole) return '—';
  const pct = (part / whole) * 100;
  // Keep a real nonzero count from rounding to a misleading zero.
  return part > 0 && pct < 0.1 ? '<0.1%' : `${pct.toFixed(1)}%`;
}

function utc(value: string) {
  return new Date(value).toLocaleString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ObservationLagSection() {
  const [period, setPeriod] = useUrlState<Period>('lag', '7d', ['24h', '7d', '30d']);
  const { data, loading, error } = useApiQuery<ObservationLag>('/v1/mining/observation-lag', undefined, { refreshInterval: 60_000 });
  const supported = data?.method === 'local-node-tip-receipt-v1';
  const selected = supported ? data.periods.find(window => window.period === period) : null;

  return (
    <section id="timing" className="scroll-mt-36 mb-12">
      <Card><CardBody>
        <SectionHeader label="HEADER_TIME_VS_FIRST_SEEN" />
        <p className="text-sm text-muted mb-2">
          How long after a block&apos;s miner-provided header timestamp ZecBlock&apos;s node first reported it as the chain tip.
        </p>
        <p className="text-caption text-muted mb-5">
          Pools usually set the header time when they hand out mining work, so the gap includes solving time as well as propagation; it is not a network propagation delay.
          A negative gap means the header time is later than our first observation, usually a miner clock running ahead.
          The tip is polled every second, so blocks replaced within a second or missed during outages have no observation.
        </p>
        {loading ? <p role="status" className="text-sm text-muted py-6">Loading header-time gaps…</p> : !supported ? (
          <p role="status" className="text-sm text-muted py-6">Header-time gaps are temporarily unavailable.</p>
        ) : <>
          {error && <p role="status" className="text-caption text-muted mb-3">Refresh failed. Showing the previous snapshot from {utc(data.asOf)} UTC.</p>}
          <div className="grid sm:grid-cols-3 gap-3 mb-6">
            {data.periods.map(window => (
              <button key={window.period} type="button" aria-pressed={period === window.period} onClick={() => setPeriod(window.period)}
                className={`card p-4 text-left transition ${period === window.period ? 'ring-1 ring-cipher-gold/40' : 'hover:bg-glass-3'}`}>
                <span className="block text-caption font-mono text-muted uppercase mb-2">{window.period} median gap</span>
                <span className="block text-xl font-mono font-semibold text-primary mb-2">{lag(window.medianSeconds)}</span>
                <span className="block text-caption text-muted">
                  p90 {lag(window.p90Seconds)} · {window.observed.toLocaleString()} of {window.blocks.toLocaleString()} blocks observed
                </span>
              </button>
            ))}
          </div>
          {selected && <>
            <p className="text-caption text-muted mb-3">{utc(selected.windowStart)} – {utc(selected.windowEnd)} UTC · windows by header timestamp</p>
            {selected.observed === 0 ? <p className="text-sm text-muted py-4">No blocks in this window have a first-seen observation.</p> :
              <SortableDataTable bare caption={`Header time versus first seen by mining pool, ${period}`} columns={[
                { id: 'pool', header: 'Pool', sortValue: (pool: PoolLag) => pool.name, cell: (pool: PoolLag) => <span className="font-mono text-xs text-primary">{pool.name}</span> },
                { id: 'observed', header: 'Observed / blocks', align: 'right', sortValue: pool => pool.observed, cell: pool => <span className="font-mono text-xs tabular-nums">{pool.observed.toLocaleString()} / {pool.blocks.toLocaleString()}</span> },
                { id: 'median', header: 'Median gap', align: 'right', sortValue: pool => pool.medianSeconds, cell: pool => <span className="font-mono text-xs tabular-nums">{lag(pool.medianSeconds)}</span> },
                { id: 'p90', header: 'p90 gap', align: 'right', sortValue: pool => pool.p90Seconds, cell: pool => <span className="font-mono text-xs tabular-nums">{lag(pool.p90Seconds)}</span> },
                { id: 'ahead', header: 'Header after seen', align: 'right', sortValue: pool => pool.observed ? pool.headerAfterSeen / pool.observed : null, cell: pool => <span className="font-mono text-xs tabular-nums">{share(pool.headerAfterSeen, pool.observed)}</span> },
              ]} rows={selected.pools} rowKey={pool => pool.name} />}
          </>}
          <p className="text-caption text-muted mt-4">
            Gap = first local-node tip receipt − header timestamp; header times have one-second precision. Median and p90 need at least {data.minSample} observed blocks.
            Pool labels use public coinbase data; Unknown remains included.{' '}
            {data.collectionStart ? `Observations began ${utc(data.collectionStart)} UTC; earlier blocks are unobserved.` : 'No observations have been recorded yet.'}
            {' '}Snapshot {utc(data.asOf)} UTC.
          </p>
        </>}
      </CardBody></Card>
    </section>
  );
}
