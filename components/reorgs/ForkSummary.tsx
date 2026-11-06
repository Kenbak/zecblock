'use client';

import Link from 'next/link';
import { Card, CardBody, MetricCard } from '@/components/ui';
import { PeriodPillTags } from '@/components/ui/PeriodPillTags';
import { PoolLogo } from '@/components/PoolLogo';
import { OrphanRateDailyChart } from '@/components/mining/OrphanRateDailyChart';
import { isUnknownPool } from './CompetingBlocks';

export type Window = '24h' | '7d' | '30d';
export const WINDOWS: readonly Window[] = ['24h', '7d', '30d'];
const WINDOW_LABEL: Record<Window, string> = { '24h': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days' };

interface PoolRate { name: string; canonicalBlocks: number; orphanedBlocks: number; rate: number | null }
interface RateWindow { period: string; canonicalBlocks: number; orphanedBlocks: number; rate: number | null; unavailableReason: string | null; pools: PoolRate[] }
export interface OrphanRates {
  method: string;
  capture?: { startedAt: string | null; observers: number; healthyObservers: number; status: string };
  periods: RateWindow[];
}
export interface ReorgStats {
  totalOrphanedBlocks: number;
  totalForkEvents: number;
  deepestReorg: number;
  observerOnlyOrphanedBlocks?: number | null;
  observerCaptureStartedAt?: string | null;
}
export interface NodesSummary { total: number; online: number; forking: number }

function pct(rate: number | null) {
  if (rate === null) return '—';
  return rate > 0 && rate < 0.0001 ? '<0.01%' : `${(rate * 100).toFixed(2)}%`;
}

export function ForkSummary({
  rates, stats, nodes, window, onWindowChange, onSelectMiner,
}: {
  rates: OrphanRates | null;
  stats: ReorgStats | null;
  nodes: NodesSummary | null;
  window: Window;
  onWindowChange: (w: Window) => void;
  onSelectMiner: (miner: string) => void;
}) {
  const supported = rates?.method === 'observed-indexer-reorg-v1' || rates?.method === 'observed-block-capture-v2';
  const selected = supported ? rates!.periods.find(p => p.period === window) ?? null : null;
  const pools = (selected?.pools ?? []).filter(p => p.orphanedBlocks > 0).sort((a, b) => b.orphanedBlocks - a.orphanedBlocks || (b.rate ?? 0) - (a.rate ?? 0));
  const maxRate = Math.max(0.0001, ...pools.map(p => p.rate ?? 0));
  const capture = supported ? rates!.capture : undefined;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody>
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <h2 className="text-caption font-mono uppercase tracking-wider text-muted mb-3">Competing blocks</h2>
              <div className="flex items-baseline gap-3 flex-wrap">
                <span className="text-4xl sm:text-6xl font-light tracking-tight text-primary tabular-nums">
                  {selected ? selected.orphanedBlocks.toLocaleString('en-US') : '—'}
                </span>
                <span className="text-sm text-secondary">blocks lost the race · {WINDOW_LABEL[window]}</span>
              </div>
              <p className="mt-2 text-sm text-muted">
                {selected && selected.rate !== null
                  ? <><span className="text-cipher-gold">{pct(selected.rate)}</span> of {selected.canonicalBlocks.toLocaleString('en-US')} blocks</>
                  : selected?.unavailableReason ?? 'Observed orphan rate unavailable'}
              </p>
              {nodes && (
                <p className="mt-3 inline-flex items-center gap-2 text-caption font-mono text-muted">
                  <span aria-hidden className={`h-2 w-2 rounded-full ${nodes.forking > 0 ? 'bg-cipher-orange' : 'bg-cipher-green'}`} />
                  {nodes.forking > 0
                    ? `${nodes.forking} monitored node${nodes.forking === 1 ? ' is' : 's are'} on a different tip`
                    : `No fork across ${nodes.online} online monitored nodes`}
                  {capture && <span className="text-muted"> · {capture.healthyObservers}/{capture.observers} observers collecting</span>}
                </p>
              )}
            </div>
            <PeriodPillTags className="self-start" options={WINDOWS.map(w => ({ key: w, label: w.toUpperCase() }))} value={window} onChange={onWindowChange} aria-label="Time window" />
          </div>
          <div className="mt-6">
            <OrphanRateDailyChart />
          </div>
        </CardBody>
      </Card>

      {stats && (
        <section aria-labelledby="fork-watch-all-time">
          <h2 id="fork-watch-all-time" className="type-label text-muted uppercase mb-2">All time</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard size="compact" label="Fork events" value={stats.totalForkEvents.toLocaleString('en-US')} hint="Reorgs on our main node" />
            <MetricCard size="compact" label="Reorged on our node" value={stats.totalOrphanedBlocks.toLocaleString('en-US')} hint="Blocks it accepted, then dropped" />
            <MetricCard size="compact" label="Seen only by observers" value={stats.observerOnlyOrphanedBlocks != null ? stats.observerOnlyOrphanedBlocks.toLocaleString('en-US') : '—'}
              hint={stats.observerCaptureStartedAt ? `Since ${new Date(stats.observerCaptureStartedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}` : 'Observer capture'} />
            <MetricCard size="compact" label="Longest reorg" value={stats.deepestReorg > 0 ? `${stats.deepestReorg} block${stats.deepestReorg === 1 ? '' : 's'}` : '—'}
              accent={stats.deepestReorg > 3 ? 'orange' : 'default'} hint="On our main node" />
          </div>
        </section>
      )}

        <Card>
          <CardBody>
            <div className="flex items-baseline justify-between gap-3 mb-4">
              <h2 className="text-caption font-mono uppercase tracking-wider text-muted">Who lost races · {window.toUpperCase()}</h2>
              <Link href={`/mining?orphans=${window}#orphans`} prefetch={false} className="text-caption font-mono text-cipher-gold hover:underline">All pools on Mining →</Link>
            </div>
            {pools.length === 0 ? (
              <p className="py-6 text-sm text-muted">{selected ? 'No competing blocks in this window.' : 'Per-pool rates are unavailable.'}</p>
            ) : (
              <ul className="grid gap-x-10 lg:grid-cols-2 [&>li]:border-b [&>li]:border-cipher-border">
                {pools.slice(0, 10).map(p => (
                  <li key={p.name}>
                    <button type="button" onClick={() => onSelectMiner(isUnknownPool(p.name) ? 'Unknown' : p.name)}
                      title={`Show ${p.name}'s competing blocks`}
                      className="group grid w-full grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-3 py-2.5 text-left">
                      <span className="inline-flex min-w-0 items-center gap-2 text-sm text-primary group-hover:text-cipher-gold">
                        {!isUnknownPool(p.name) && <PoolLogo name={p.name} />}<span className="truncate">{p.name}</span>
                      </span>
                      <span className="hidden sm:block h-1.5 rounded-full bg-glass-4 overflow-hidden" aria-hidden>
                        <span className="block h-full rounded-full bg-cipher-orange/70" style={{ width: `${Math.max(2, ((p.rate ?? 0) / maxRate) * 100)}%` }} />
                      </span>
                      <span className="text-right font-mono text-xs tabular-nums text-secondary whitespace-nowrap">
                        <span className="text-primary">{p.orphanedBlocks}</span> lost · {pct(p.rate)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-caption text-muted">Rate = lost ÷ (won + lost) for that pool in the window. Small samples swing widely. Select a pool to list its blocks.</p>
          </CardBody>
        </Card>

    </div>
  );
}
