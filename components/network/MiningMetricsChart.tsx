'use client';

import { useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
} from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { formatDifficulty, formatHashrate } from '@/lib/format-numbers';
import { useApiQuery } from '@/hooks/useApiQuery';
import { ChartCard } from './ChartCard';

type MetricKey = 'solrate' | 'difficulty' | 'blockTime' | 'txFees' | 'txCount';

const METRICS: { key: MetricKey; label: string; color: string; format: (v: number) => string }[] = [
  { key: 'solrate', label: 'Solrate', color: 'gold', format: (v) => formatHashrate(v) },
  { key: 'difficulty', label: 'Difficulty', color: 'yellow', format: (v) => formatDifficulty(v) },
  { key: 'blockTime', label: 'Block time', color: 'green', format: (v) => `~${Math.round(v)}s` },
  { key: 'txFees', label: 'TX fees', color: 'purple', format: (v) => `${v.toFixed(6)} ZEC` },
  { key: 'txCount', label: 'TX count', color: 'gold', format: (v) => v.toFixed(1) },
];

interface MiningMetricsData {
  points?: ({ height: number } & Record<MetricKey, number | null>)[];
  latest?: Partial<Record<MetricKey, number | null>>;
  window?: number;
}

export function MiningMetricsChart() {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const [active, setActive] = useState<MetricKey>('solrate');
  const window = 20;

  const { data } = useApiQuery<MiningMetricsData>(
    '/v1/mining/metrics',
    { window, limit: 120 },
  );
  const points = data?.points ?? [];
  const latest = data?.latest ?? {};

  const metric = METRICS.find((m) => m.key === active)!;
  const stroke = metric.color === 'gold' ? colors.gold : metric.color === 'yellow' ? colors.yellow : metric.color === 'green' ? colors.orchard : colors.purple;

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
              <p className="text-caption text-muted font-mono mt-0.5">{window} blk avg</p>
            </button>
          );
        })}
      </div>

      <ChartCard title={`${metric.label.toUpperCase().replace(/\s+/g, '_')}_TREND`} height={280} watermarkSize="lg">
        <p className="text-caption text-muted mb-3">{window}-block trailing averages. Timing uses block-header timestamps; unavailable values remain gaps.</p>
        <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={280}>
          <LineChart data={points}>
            <CartesianGrid strokeDasharray="2 6" stroke={colors.grid} opacity={0.5} />
            <XAxis
              dataKey="height"
              stroke={colors.axis}
              tick={{ fill: colors.axis, fontSize: 12 }}
              tickFormatter={(h) => Number(h).toLocaleString('en-US')}
              minTickGap={32}
            />
            <YAxis
              stroke={colors.axis}
              tick={{ fill: colors.axis, fontSize: 12 }}
              tickFormatter={(v) => (active === 'difficulty' ? formatDifficulty(v) : active === 'solrate' ? formatHashrate(v) : String(Math.round(v * 100) / 100))}
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
            <Line type="monotone" dataKey={active} stroke={stroke} strokeWidth={2} dot={false} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
