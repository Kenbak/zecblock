'use client';
import { ChartSkeleton } from '@/components/ui/Skeleton';

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
import { CURRENCY } from '@/lib/config';
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

interface Threshold {
  thresholdZat: number;
  thresholdZec: number;
  shieldCount: number;
  deshieldCount: number;
}

const CHART_HEIGHT = 340;

export function AnonymitySetChart() {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const [period, setPeriod] = useUrlState<Period>('anonymity', '30d', PRIVACY_PERIODS);

  const { data: res, loading, error } = useApiQuery<{ thresholds: Threshold[] }>(
    '/v1/privacy/anonymity-set',
    { period },
  );
  const data = res?.thresholds ?? [];

  const chartData = data.map((t) => ({
    label: formatZec(t.thresholdZec),
    shield: t.shieldCount,
    deshield: t.deshieldCount,
    total: t.shieldCount + t.deshieldCount,
  }));

  const tooltipStyle = {
    backgroundColor: colors.tooltipBg,
    border: `1px solid ${colors.tooltipBorder}`,
    borderRadius: '8px',
    padding: '12px',
    color: colors.tooltipText,
  };

  return (
    <PrivacyFlowCard
      title="Flows above an amount"
      description={<>Counts of public shielding and deshielding flows at or above each {CURRENCY} threshold
            ({period === 'all' ? 'full history' : `last ${period}`}). Thresholds overlap; this is not a measured anonymity set.</>}
      controls={<PeriodSelector value={period} onChange={setPeriod} />}
    >
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
                label={privacyXAxisTitle(`${CURRENCY} threshold`, colors.axis)}
              />
              <YAxis
                tick={{ fill: colors.axis, fontSize: 12 }}
                tickFormatter={formatCount}
                width={52}
                label={privacyYAxisLabel('Transactions', colors.axis)}
              />
              <Tooltip
                cursor={{ fill: colors.barCursorGold }}
                contentStyle={tooltipStyle}
                labelStyle={{ color: colors.tooltipText, fontWeight: 600, marginBottom: '8px' }}
                formatter={(value, name) => [
                  `${Number(value).toLocaleString()} txs`,
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

function formatZec(zec: number): string {
  if (zec >= 1000) return `${(zec / 1000).toFixed(0)}K`;
  if (zec >= 1) return `${zec}`;
  if (zec >= 0.01) return `${zec}`;
  return `${zec}`;
}

function formatCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return `${n}`;
}
