'use client';
import { ChartSkeleton } from '@/components/ui/Skeleton';

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
} from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { formatHashrate } from '@/lib/format-numbers';
import { useApiQuery } from '@/hooks/useApiQuery';
import { hashrateChartPoints, type HashrateEstimate, type HashrateStats, type HashrateWindow } from '@/lib/hashrate';
import { ChartCard } from './ChartCard';
import { useUrlState } from '@/lib/use-url-state';
import { objectRowsCsv } from '@/components/charts/PanelShareControl';

const PERIODS = ['30d', '90d', '1y', 'all'] as const;
type Period = typeof PERIODS[number];

interface HashrateHistoryResponse {
  window?: string;
  method?: string;
  points?: (HashrateEstimate & { date: string })[];
}

function HashratePeriodSelector({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <div className="inline-flex gap-0 p-0.5 rounded-md bg-glass-3 flex-shrink-0">
      {PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={`px-1.5 py-0.5 text-caption font-mono rounded transition whitespace-nowrap ${
            value === p
              ? 'bg-glass-6 text-primary font-semibold'
              : 'text-muted hover:text-primary'
          }`}
        >
          {p.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

/**
 * Trailing-work estimates sampled daily at UTC midnight, plus the shared current snapshot.
 * Complements MiningMetricsChart, which shows short-range per-block solrate/difficulty —
 * this one is for spotting week-to-month-scale ramps (new fleets, pool migrations, etc).
 */
export function NetworkHashrateChart() {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const [period, setPeriod] = useUrlState<Period>('hashrate', '30d', PERIODS);
  const [window, setWindow] = useUrlState<HashrateWindow>('hashrateWindow', '24h', ['24h', '7d']);
  const stats = useApiQuery<HashrateStats>('/v1/network/stats', undefined, { refreshInterval: 30_000 });

  const { data, loading, error } = useApiQuery<HashrateHistoryResponse>(
    '/v1/mining/hashrate-history',
    { period, window },
    { refreshInterval: 300_000, timeoutMs: 30_000 },
  );
  const snapshot = stats.data?.mining?.hashrateEstimate;
  const points = hashrateChartPoints(data, window, snapshot);
  const current = snapshot?.windows['24h'];

  return (
    <ChartCard
      title="NETWORK_HASHRATE_TREND"
      share={{ title: `Zcash network hashrate (${window} estimate, ${period})`, fileName: `zecblock-hashrate-${period}-${window}`, csv: () => objectRowsCsv(points) }}
      height={280}
      watermarkSize="lg"
      controls={<div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted">Estimate window{' '}
          <select aria-label="Hashrate estimate window" value={window} onChange={event => setWindow(event.target.value as HashrateWindow)} className="bg-transparent text-primary">
            <option value="24h">24 hours</option><option value="7d">7 days</option>
          </select>
        </label>
        <HashratePeriodSelector value={period} onChange={setPeriod} />
      </div>}
    >
      <p className="text-xs font-mono text-muted mb-3">
        Estimated hashrate · 24h: <span className="text-primary font-semibold">{snapshot ? stats.data?.mining?.networkHashrate : '—'}</span>
        {current && <span className="block text-muted">{current.blockCount.toLocaleString()} blocks · As of {current.windowEnd.replace('T', ' ').replace('Z', ' UTC')}</span>}
      </p>
      <p className="text-xs text-muted mb-3">
        Canonical block work divided by the full trailing {window === '24h' ? '24 hours' : '7 days'}.
        Historical samples end at midnight UTC; the last point uses the current shared snapshot.
        Estimates use block-header timestamps and exclude orphaned blocks.
      </p>
      {(stats.error || stats.isRefreshing) && <p className="text-xs text-muted" role="status">{stats.error ? 'Live refresh delayed; showing the last available snapshot.' : 'Refreshing estimate…'}</p>}
      {error && <p role="status" className="text-xs text-muted">History refresh unavailable. Any retained samples are shown below.</p>}
      {!points.some(point => point.hashrate != null) ? (
        <div className="flex items-center justify-center h-[260px]">
          {loading ? <ChartSkeleton height={260} /> : <p className="text-xs text-muted">Hashrate history unavailable</p>}
        </div>
      ) : (
        <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={260}>
          <LineChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="2 6" stroke={colors.grid} opacity={0.5} />
            <XAxis
              dataKey="timestamp"
              minTickGap={40}
              padding={{ left: 12, right: 20 }}
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              stroke={colors.axis}
              tick={{ fill: colors.axis, fontSize: 12 }}
              tickFormatter={(d: number) => {
                const date = new Date(d);
                return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
              }}
            />
            <YAxis
              stroke={colors.axis}
              tick={{ fill: colors.axis, fontSize: 12 }}
              tickFormatter={(v: number) => formatHashrate(v)}
              width={100}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: colors.tooltipBg,
                border: `1px solid ${colors.tooltipBorder}`,
                borderRadius: 8,
                fontSize: 12,
                fontFamily: 'var(--font-geist-mono), monospace',
              }}
              labelFormatter={(d) => `${new Date(Number(d)).toISOString().replace('T', ' ').replace('Z', '')} UTC`}
              formatter={(value) => [formatHashrate(Number(value)), `Estimated hashrate · ${window}`]}
            />
            <Line
              type="linear"
              connectNulls={false}
              dataKey="hashrate"
              stroke={colors.gold}
              strokeWidth={2}
              dot={points.filter(point => point.hashrate != null).length === 1 ? { r: 3 } : false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
