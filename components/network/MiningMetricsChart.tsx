'use client';

import { useUrlState } from '@/lib/use-url-state';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
} from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { formatDifficulty, formatHashrate } from '@/lib/format-numbers';
import { MINING_METRICS_POINTS, MINING_METRICS_WINDOW } from '@/lib/mining-metrics';
import { useApiQuery } from '@/hooks/useApiQuery';
import { CURRENCY } from '@/lib/config';
import { ChartCard } from './ChartCard';
import { objectRowsCsv } from '@/components/charts/PanelShareControl';

/** Short axis labels: whole units, no decimals, so they fit beside a phone-width plot. */
function axisTick(metric: string, value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0';
  const short = (n: number) => (Math.abs(n) >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));
  if (metric === 'solrate') {
    if (value >= 1e12) return `${short(value / 1e12)} TSol/s`;
    if (value >= 1e9) return `${short(value / 1e9)} GSol/s`;
    if (value >= 1e6) return `${short(value / 1e6)} MSol/s`;
    return `${short(value)} Sol/s`;
  }
  if (metric === 'difficulty') {
    if (value >= 1e9) return `${short(value / 1e9)}B`;
    if (value >= 1e6) return `${short(value / 1e6)}M`;
    if (value >= 1e3) return `${short(value / 1e3)}K`;
  }
  return short(value);
}

type MetricKey = 'solrate' | 'difficulty' | 'blockTime' | 'txFees' | 'txCount';

const METRICS: { key: MetricKey; label: string; color: string; format: (v: number) => string }[] = [
  // The API field is `solrate` (solutions per second, Zcash's name for hashrate); the site says hashrate.
  { key: 'solrate', label: 'Hashrate', color: 'gold', format: (v) => formatHashrate(v) },
  { key: 'difficulty', label: 'Difficulty', color: 'yellow', format: (v) => formatDifficulty(v) },
  { key: 'blockTime', label: 'Block time', color: 'green', format: (v) => `~${Math.round(v)}s` },
  { key: 'txFees', label: 'Block fees', color: 'purple', format: (v) => `${v.toFixed(6)} ${CURRENCY}` },
  { key: 'txCount', label: 'TX count', color: 'gold', format: (v) => v.toFixed(1) },
];

interface MiningMetricsData {
  points?: ({ height: number } & Record<MetricKey, number | null>)[];
  latest?: Partial<Record<MetricKey, number | null>>;
  window?: number;
  solrateMethod?: string;
}

const METRIC_KEYS = METRICS.map(m => m.key);

export function MiningMetricsChart() {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  // In the URL so another page can link straight to one metric's trend, e.g. /mining?metric=txFees#economics.
  const [active, setActive] = useUrlState<MetricKey>('metric', 'solrate', METRIC_KEYS);
  const window = MINING_METRICS_WINDOW;

  const { data, loading, error } = useApiQuery<MiningMetricsData>(
    '/v1/mining/metrics',
    { window, limit: MINING_METRICS_POINTS },
  );
  const points = data?.points ?? [];
  const latest = data?.latest ?? {};

  const metric = METRICS.find((m) => m.key === active)!;
  const stroke = metric.color === 'gold' ? colors.gold : metric.color === 'yellow' ? colors.yellow : metric.color === 'green' ? colors.orchard : colors.purple;
  const hasValues = points.some((point) => point[active] != null && Number.isFinite(point[active]));
  const elapsedSolrate = active === 'solrate' && data?.solrateMethod === 'difficulty-work-over-elapsed-v1';
  // The page's main hashrate chart uses 24-hour and 7-day windows, so this one names its own window.
  const trendName = active === 'solrate' ? `${metric.label} ${window} block` : metric.label;
  const emptyMessage = loading ? 'Loading mining metrics…'
    : error ? 'Mining metrics are temporarily unavailable.'
      : `No complete ${window}-block window is available for ${metric.label.toLowerCase()}.`;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {METRICS.map((m) => {
          const value = latest[m.key];
          return (
            <button
              key={m.key}
              type="button"
              aria-pressed={active === m.key}
              onClick={() => setActive(m.key)}
              className={`card p-3 text-left transition ${active === m.key ? 'ring-1 ring-cipher-gold/40' : 'opacity-80 hover:opacity-100'}`}
            >
              <p className="text-caption text-muted font-mono uppercase mb-1">{m.label}</p>
              <p className="text-sm font-semibold font-mono text-primary whitespace-nowrap truncate">
                {value != null ? m.format(value) : '—'}
              </p>
              <p className="text-caption text-muted font-mono mt-0.5">{window} blk {m.key === 'solrate' && data?.solrateMethod === 'difficulty-work-over-elapsed-v1' ? 'estimate' : 'avg'}</p>
            </button>
          );
        })}
      </div>

      <ChartCard title={`${trendName} trend`} height={280} watermarkSize="lg" share={{ title: `Zcash ${trendName.toLowerCase()} trend`, fileName: `zecblock-${trendName.toLowerCase().replace(/\s+/g, '-')}`, csv: () => objectRowsCsv(points) }}>
        <p className="text-caption text-muted mb-3">{elapsedSolrate
          ? `${window}-block estimates from total difficulty and elapsed header time: the 24-hour measure at the top of the page over a shorter window, so it moves more.`
          : `${window}-block trailing averages.`}</p>
        {error && hasValues && <p role="status" className="text-caption text-muted mb-3">Refresh unavailable. Showing the last received mining metrics.</p>}
        {!hasValues ? <div role="status" className="flex h-[280px] items-center justify-center text-caption text-muted">{emptyMessage}</div> :
        <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={280}>
          <LineChart data={points}>
            <CartesianGrid vertical={false} stroke={colors.gridStroke} />
            <XAxis tickLine={false} axisLine={false}
              dataKey="height"
              stroke={colors.axis}
              tick={{ fill: colors.axis, fontSize: 12 }}
              tickFormatter={(h) => Number(h).toLocaleString('en-US')}
              minTickGap={32}
            />
            <YAxis tickLine={false} axisLine={false}
              stroke={colors.axis}
              tick={{ fill: colors.axis, fontSize: 12 }}
              width={68}
              tickFormatter={(v) => axisTick(active, Number(v))}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: colors.tooltipBg,
                border: `1px solid ${colors.tooltipBorder}`,
                borderRadius: '8px',
                fontSize: 12,
              }}
              labelFormatter={(h) => `Block ${h}`}
              formatter={(value) => [value == null ? 'Unavailable' : metric.format(Number(value)), metric.label]}
            />
            <Line type="linear" dataKey={active} stroke={stroke} strokeWidth={2} dot={{ r: 2, fill: stroke, strokeWidth: 0 }} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>}
      </ChartCard>
    </div>
  );
}
