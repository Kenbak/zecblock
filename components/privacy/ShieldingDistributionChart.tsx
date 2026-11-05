'use client';
import { ChartSkeleton } from '@/components/ui/Skeleton';

import { useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,

  ResponsiveContainer,
} from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { useApiQuery } from '@/hooks/useApiQuery';
import { PrivacyFlowCard } from './PrivacyFlowCard';
import { PeriodSelector, PRIVACY_PERIODS, Period } from './PeriodSelector';
import {
  PRIVACY_BAR_CHART_MARGIN,
  privacyXAxisTitle,
  privacyYAxisLabel,
} from './privacy-chart-axis';
import { PrivacyBarLegend } from './PrivacyBarLegend';
import { useUrlState } from '@/lib/use-url-state';

interface Bucket {
  label: string;
  minZat: number;
  maxZat: number | null;
  shieldCount: number;
  deshieldCount: number;
  shieldVolumeZat: number;
  deshieldVolumeZat: number;
}

type ViewMode = 'count' | 'volume';

const CHART_HEIGHT = 340;

function modePillClass(active: boolean) {
  return `px-1.5 py-0.5 text-caption font-mono rounded transition whitespace-nowrap ${
    active
      ? 'bg-brand-gold/15 text-cipher-gold font-semibold'
      : 'text-muted hover:text-primary'
  }`;
}

export function ShieldingDistributionChart() {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const [period, setPeriod] = useUrlState<Period>('shielding', '30d', PRIVACY_PERIODS);
  const [mode, setMode] = useState<ViewMode>('count');
  const yLabel = mode === 'count' ? 'Transactions' : 'ZEC volume';

  const { data: res, loading, error } = useApiQuery<{ buckets: Bucket[] }>(
    '/v1/privacy/shielding-distribution',
    { period },
  );
  const data = res?.buckets ?? [];

  const chartData = data.map((b) => ({
    label: `${b.label} ZEC`,
    shield: mode === 'count' ? b.shieldCount : b.shieldVolumeZat / 1e8,
    deshield: mode === 'count' ? b.deshieldCount : b.deshieldVolumeZat / 1e8,
  }));

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex flex-shrink-0 gap-0 rounded-md bg-glass-3 p-0.5">
        {(['count', 'volume'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            className={modePillClass(mode === m)}
          >
            {m === 'count' ? 'COUNT' : 'VOLUME'}
          </button>
        ))}
      </div>
      <PeriodSelector value={period} onChange={setPeriod} />
    </div>
  );

  const tooltipStyle = {
    backgroundColor: colors.tooltipBg,
    border: `1px solid ${colors.tooltipBorder}`,
    borderRadius: '8px',
    padding: '12px',
    color: colors.tooltipText,
  };

  return (
    <PrivacyFlowCard title="Flows by amount range" description={<>{mode === 'count'
              ? `Transaction count by amount range (${period === 'all' ? 'all time' : `last ${period}`}). Each flow belongs to one amount range.`
              : `ZEC volume by amount range (${period === 'all' ? 'all time' : `last ${period}`}). Shows where value concentrates across shielded flows.`}</>} controls={controls}>
      {loading ? (
        <div><ChartSkeleton height={340} /><div className="mt-2 h-5" /></div>
      ) : error ? <p role="status" className="text-caption text-muted py-8">Public flow observations could not load.</p> : data.length === 0 ? <p className="text-caption text-muted py-8">No public flow observations for this period.</p> : (
        <div>
          <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={CHART_HEIGHT}>
            <BarChart data={chartData} margin={PRIVACY_BAR_CHART_MARGIN}>
              <CartesianGrid vertical={false} stroke={colors.gridStroke} />
              <XAxis
                dataKey="label"
                tick={{ fill: colors.axis, fontSize: 12 }}
                minTickGap={24}
                textAnchor="middle"
                height={56}
                interval="preserveStartEnd"
                label={privacyXAxisTitle('Amount range', colors.axis)}
              />
              <YAxis
                tick={{ fill: colors.axis, fontSize: 12 }}
                tickFormatter={(v) => (mode === 'count' ? formatCount(v) : formatZec(v))}
                width={52}
                label={privacyYAxisLabel(yLabel, colors.axis)}
              />
              <Tooltip
                cursor={{ fill: colors.barCursorGold }}
                contentStyle={tooltipStyle}
                labelStyle={{ color: colors.tooltipText, fontWeight: 600, marginBottom: '8px' }}
                formatter={(value, name) => [
                  mode === 'count'
                    ? `${Number(value).toLocaleString()} txs`
                    : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })} ZEC`,
                  String(name) === 'shield' ? 'Shield (in)' : 'Deshield (out)',
                ]}
              />
              <Bar isAnimationActive={false} dataKey="shield" fill={colors.shielding} name="shield" radius={[3, 3, 0, 0]} />
              <Bar isAnimationActive={false} dataKey="deshield" fill={colors.deshielding} name="deshield" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <PrivacyBarLegend shieldColor={colors.shielding} deshieldColor={colors.deshielding} />
        </div>
      )}
    </PrivacyFlowCard>
  );
}

function formatCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return `${n}`;
}

function formatZec(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return n.toFixed(0);
}
