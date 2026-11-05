'use client';

import { pulseEventDescription } from '@/lib/pulse-copy';
import { useMemo, useState } from 'react';
import { useApiQuery } from '@/hooks/useApiQuery';
import { PageHeader, SectionHeader } from '@/components/ui';
import { useUrlState } from '@/lib/use-url-state';

const PULSE_DAYS = ['7', '14', '30', '90'] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

interface PulseEvent {
  date: string;
  metric: string;
  value: number;
  zscore: number;
  direction: 'up' | 'down';
  description: string;
  detail: string;
  severity: 'extreme' | 'strong' | 'mild';
  createdAt: string;
}

interface PulseResponse {
  events: PulseEvent[];
  total: number;
  severityCounts?: { extreme: number; strong: number; mild: number };
  topMetric?: { metric: string; count: number } | null;
}

type Severity = 'all' | 'extreme' | 'strong' | 'mild';

// ─── Config ───────────────────────────────────────────────────────────────────

const SEVERITY_CONFIG: Record<string, { dot: string; text: string; bar: string; label: string }> = {
  extreme: { dot: 'bg-brand-gold', text: 'text-cipher-gold', bar: 'bg-brand-gold', label: 'Extreme' },
  strong: { dot: 'bg-brand-gold/70', text: 'text-cipher-gold/70', bar: 'bg-brand-gold/70', label: 'Strong' },
  mild: { dot: 'bg-brand-gold/40', text: 'text-cipher-gold/40', bar: 'bg-brand-gold/40', label: 'Mild' },
};

const METRIC_LABELS: Record<string, string> = {
  tx_count_total: 'Transaction Count',
  tx_count_shielded: 'Shielded Txs',
  shielded_pct: 'Shielded %',
  shield_volume_zat: 'Shield Volume',
  deshield_volume_zat: 'Deshield Volume',
  crosschain_inflow_usd: 'Cross-Chain Inflow',
  crosschain_outflow_usd: 'Cross-Chain Outflow',
  daily_fees_zat: 'Fee Market',
  exchange_deposit_zat: 'Exchange Deposits',
  mvrv: 'MVRV Ratio',
  migration_volume_zat: 'Ironwood Migration',
  miner_exchange_ratio: 'Miner Exchange Transfers',
};

// Splits "59.8% (z=2.53, μ=35.6%, σ=9.6%)" into value + stats parts.
function splitDetail(detail: string): { value: string; stats: string | null } {
  const m = detail.match(/^(.*?)\s*\((.*)\)\s*$/);
  if (!m) return { value: detail, stats: null };
  return { value: m[1], stats: m[2] };
}

function formatDay(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ─── Building blocks ──────────────────────────────────────────────────────────

function FilterPill<T extends string>({
  active,
  onClick,
  children,
  activeClass = 'bg-brand-gold/15 text-cipher-gold border-cipher-gold/30',
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  activeClass?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-caption font-mono transition-colors ${
        active
          ? activeClass
          : 'border-cipher-border/50 text-muted hover:border-cipher-border hover:text-primary'
      }`}
    >
      {children}
    </button>
  );
}

function ZScoreBar({ zscore, severity }: { zscore: number; severity: string }) {
  const cfg = SEVERITY_CONFIG[severity];
  const absZ = Math.abs(zscore);
  const pct = Math.min(absZ / 5, 1) * 100;
  return (
    <div className="flex items-center gap-2 w-28 shrink-0" title={`z-score: ${zscore.toFixed(2)}`}>
      <div className="h-1 flex-1 rounded-full bg-glass-6 overflow-hidden">
        <div className={`h-full rounded-full ${cfg.bar}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`font-mono text-caption font-semibold tabular-nums ${cfg.text}`}>
        {absZ.toFixed(1)}σ
      </span>
    </div>
  );
}

function EventRow({
  event,
  onMetricClick,
}: {
  event: PulseEvent;
  onMetricClick: (metric: string) => void;
}) {
  const cfg = SEVERITY_CONFIG[event.severity];
  const { value, stats } = splitDetail(event.detail);

  return (
    <div className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-cipher-hover sm:gap-4 sm:px-5">
      {/* Severity dot + direction */}
      <div className="flex shrink-0 items-center gap-1.5 w-8">
        <span className={`h-2 w-2 rounded-full ${cfg.dot}`} />
        <span className={`font-mono text-caption ${cfg.text}`}>
          {event.direction === 'up' ? '▲' : '▼'}
        </span>
      </div>

      {/* Description + stats */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium text-primary">{pulseEventDescription(event.metric, event.direction, event.description)}</span>
          <span className="font-mono text-xs font-semibold tabular-nums text-secondary">{value}</span>
        </div>
        {stats ? (
          <div className="mt-0.5 truncate font-mono text-caption text-muted">{stats}</div>
        ) : null}
      </div>

      {/* Metric chip */}
      <button
        onClick={() => onMetricClick(event.metric)}
        className="hidden shrink-0 rounded-full border border-cipher-border/40 bg-glass-3 px-2.5 py-0.5 font-mono text-caption text-muted transition-colors hover:border-cipher-gold/40 hover:text-primary sm:block"
      >
        {METRIC_LABELS[event.metric] || event.metric}
      </button>

      {/* Z-score magnitude */}
      <div className="hidden sm:block">
        <ZScoreBar zscore={event.zscore} severity={event.severity} />
      </div>
      <span className={`font-mono text-caption font-semibold tabular-nums sm:hidden ${cfg.text}`}>
        {Math.abs(event.zscore).toFixed(1)}σ
      </span>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PulsePage() {
  const [daysParam, setDaysParam] = useUrlState('days', '30', PULSE_DAYS);
  const days = Number(daysParam);
  const setDays = (value: number) => setDaysParam(String(value) as typeof PULSE_DAYS[number]);
  const [severity, setSeverity] = useState<Severity>('all');
  const [metricFilter, setMetricFilter] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const pageSize = 30;

  const { data: pulseData, loading } = useApiQuery<PulseResponse>(
    '/v1/pulse',
    { days, limit: pageSize, offset: page * pageSize, metric: metricFilter ?? undefined },
  );
  const events = pulseData?.events ?? [];
  const total = pulseData?.total ?? 0;
  const counts = pulseData?.severityCounts ?? { extreme: 0, strong: 0, mild: 0 };
  const topMetric = pulseData?.topMetric ?? null;

  const filtered = severity === 'all' ? events : events.filter(e => e.severity === severity);

  // Group by calendar day, preserving API order (most recent first).
  const grouped = useMemo(() => {
    const groups: { day: string; events: PulseEvent[] }[] = [];
    for (const event of filtered) {
      const day = String(event.date).slice(0, 10);
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.events.push(event);
      else groups.push({ day, events: [event] });
    }
    return groups;
  }, [filtered]);

  const handleMetricClick = (metric: string) => {
    setMetricFilter(prev => (prev === metric ? null : metric));
    setPage(0);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <PageHeader
        eyebrow="NETWORK_PULSE"
        title="Network Pulse"
        subtitle="Auto-detected statistical anomalies across 12 on-chain metrics — flagged when a daily value moves more than 2.5 standard deviations from its 90-day average."
      />

      {/* ─── KPI strip ──────────────────────────────────────── */}
      <div className="mt-4 overflow-hidden rounded-2xl border border-cipher-border bg-cipher-surface">
        <div className="flex items-center gap-2 border-b border-cipher-border-subtle px-4 py-2.5 sm:px-5">
          <span className="h-2 w-2 rounded-full bg-brand-gold animate-pulse" />
          <span className="font-mono text-caption uppercase tracking-wider text-secondary">
            Pulse · last {days} days
          </span>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-cipher-border-subtle sm:grid-cols-5 sm:divide-y-0">
          <div className="min-w-0 px-3 py-3 sm:px-4 sm:py-3.5">
            <div className="text-base font-semibold font-mono tabular-nums text-primary lg:text-lg">
              {loading ? '—' : total.toLocaleString()}
            </div>
            <div className="mt-0.5 truncate font-mono text-caption uppercase tracking-wider text-muted">Anomalies</div>
            <div className="mt-0.5 truncate font-mono text-caption text-muted">Detected in period</div>
          </div>
          {(['extreme', 'strong', 'mild'] as const).map(sev => {
            const cfg = SEVERITY_CONFIG[sev];
            return (
              <button
                key={sev}
                onClick={() => setSeverity(prev => (prev === sev ? 'all' : sev))}
                className={`min-w-0 px-3 py-3 text-left transition-colors hover:bg-cipher-hover sm:px-4 sm:py-3.5 ${
                  severity === sev ? 'bg-cipher-hover' : ''
                }`}
              >
                <div className={`text-base font-semibold font-mono tabular-nums lg:text-lg ${cfg.text}`}>
                  {loading ? '—' : counts[sev].toLocaleString()}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
                  <span className="truncate font-mono text-caption uppercase tracking-wider text-muted">{cfg.label}</span>
                </div>
                <div className="mt-0.5 truncate font-mono text-caption text-muted">
                  {sev === 'extreme' ? '|z| ≥ 4.0' : sev === 'strong' ? '|z| ≥ 3.0' : '|z| ≥ 2.5'}
                </div>
              </button>
            );
          })}
          <div className="min-w-0 px-3 py-3 sm:px-4 sm:py-3.5">
            <div className="truncate text-base font-semibold font-mono text-primary lg:text-lg">
              {loading || !topMetric ? '—' : METRIC_LABELS[topMetric.metric] || topMetric.metric}
            </div>
            <div className="mt-0.5 truncate font-mono text-caption uppercase tracking-wider text-muted">Top signal</div>
            <div className="mt-0.5 truncate font-mono text-caption text-muted">
              {topMetric ? `${topMetric.count} event${topMetric.count === 1 ? '' : 's'}` : 'No events'}
            </div>
          </div>
        </div>
      </div>

      {/* ─── Filters ────────────────────────────────────────── */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className="mr-1 font-mono text-caption uppercase tracking-wider text-muted">Period</span>
        {PULSE_DAYS.map(Number).map(d => (
          <FilterPill key={d} active={days === d} onClick={() => { setDays(d); setPage(0); }}>
            {d}D
          </FilterPill>
        ))}

        {metricFilter ? (
          <>
            <div className="mx-2 h-5 w-px bg-cipher-border/40" />
            <FilterPill active onClick={() => { setMetricFilter(null); setPage(0); }}>
              {METRIC_LABELS[metricFilter] || metricFilter} ✕
            </FilterPill>
          </>
        ) : null}
      </div>

      {/* ─── Feed ───────────────────────────────────────────── */}
      <div className="mt-6 overflow-hidden rounded-2xl border border-cipher-border bg-cipher-surface">
        {loading ? (
          <div className="divide-y divide-cipher-border-subtle">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-4">
                <div className="h-2 w-2 rounded-full skeleton-bg motion-safe:animate-pulse" />
                <div className="h-3 flex-1 max-w-sm rounded skeleton-bg motion-safe:animate-pulse" />
                <div className="h-1 w-24 rounded skeleton-bg motion-safe:animate-pulse" />
              </div>
            ))}
          </div>
        ) : grouped.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <span className="h-2.5 w-2.5 rounded-full bg-cipher-green" />
            <p className="text-sm text-secondary">No anomalies in this period.</p>
            <p className="font-mono text-xs text-muted">The network is within normal parameters.</p>
          </div>
        ) : (
          grouped.map(group => (
            <div key={group.day}>
              <div className="flex items-center gap-2 border-y border-cipher-border-subtle bg-glass-3 px-4 py-2 first:border-t-0 sm:px-5">
                <span className="font-mono text-caption uppercase tracking-wider text-muted">
                  {formatDay(group.day)}
                </span>
                <span className="font-mono text-caption text-muted">
                  {group.events.length} event{group.events.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="divide-y divide-cipher-border-subtle/50">
                {group.events.map((event, idx) => (
                  <EventRow
                    key={`${event.date}-${event.metric}-${idx}`}
                    event={event}
                    onMetricClick={handleMetricClick}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* ─── Pagination ─────────────────────────────────────── */}
      {total > pageSize && (
        <div className="mt-6 flex items-center justify-center gap-4">
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            className="rounded-lg border border-cipher-border/40 px-4 py-2 font-mono text-xs text-secondary transition-colors hover:bg-cipher-surface disabled:opacity-30"
          >
            ← Previous
          </button>
          <span className="font-mono text-xs tabular-nums text-muted">
            {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}
          </span>
          <button
            onClick={() => setPage(p => p + 1)}
            disabled={(page + 1) * pageSize >= total}
            className="rounded-lg border border-cipher-border/40 px-4 py-2 font-mono text-xs text-secondary transition-colors hover:bg-cipher-surface disabled:opacity-30"
          >
            Next →
          </button>
        </div>
      )}

      {/* ─── Methodology ───────────────────────────────────── */}
      <section className="mt-14">
        <SectionHeader label="METHODOLOGY" />
        <div className="mt-6 overflow-hidden rounded-2xl border border-cipher-border bg-cipher-surface">
          <div className="grid divide-y divide-cipher-border-subtle sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <div className="px-5 py-4">
              <div className="font-mono text-caption uppercase tracking-wider text-muted">Detection</div>
              <p className="mt-1.5 text-sm text-secondary leading-relaxed">
                Each metric is computed daily and compared against its 90-day rolling mean
                and standard deviation. Events fire at |z| ≥ 2.5.
              </p>
            </div>
            <div className="px-5 py-4">
              <div className="font-mono text-caption uppercase tracking-wider text-muted">Signal Intensity</div>
              <div className="mt-1.5 space-y-1">
                {(['extreme', 'strong', 'mild'] as const).map(sev => {
                  const cfg = SEVERITY_CONFIG[sev];
                  return (
                    <div key={sev} className="flex items-center gap-2 text-sm">
                      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
                      <span className="text-secondary">{cfg.label}</span>
                      <span className="font-mono text-xs text-muted">
                        {sev === 'extreme' ? '|z| ≥ 4.0' : sev === 'strong' ? '|z| ≥ 3.0' : '|z| ≥ 2.5'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="px-5 py-4">
              <div className="font-mono text-caption uppercase tracking-wider text-muted">Coverage</div>
              <p className="mt-1.5 text-sm text-secondary leading-relaxed">
                12 metrics: transaction counts, shielded adoption, shield/deshield volume,
                cross-chain flows, fees, exchange deposits, MVRV, Ironwood migration, and
                miner-to-exchange transfer share. Updated daily after 21:00 UTC.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
