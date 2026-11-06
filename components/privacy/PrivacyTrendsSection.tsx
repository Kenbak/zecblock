'use client';

import { useMemo } from 'react';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,

  ResponsiveContainer,
  Legend,
} from 'recharts';
import { ChartTooltip as RechartsTooltip } from '@/components/charts/ChartTooltip';
import { ShareableCard } from '@/components/ShareableCard';
import { PeriodSelector, type Period } from '@/components/privacy/PeriodSelector';
import { PeriodPillTags } from '@/components/ui/PeriodPillTags';
import { getChartColors } from '@/lib/chart-theme';
import { formatTrendDate, normalizeTrendDateKey, parseTrendDate } from '@/lib/privacy-trend-dates';

const CHART_VIEWS = [
  { id: 'score', label: 'SCORE HISTORY' },
  { id: 'adoption', label: 'SHIELDED SHARE' },
  { id: 'activity', label: 'DAILY ACTIVITY' },
] as const;

export type TrendChartView = (typeof CHART_VIEWS)[number]['id'];

type TrendDay = {
  date: string;
  shielded: number;
  transparent: number;
  poolSize: number;
  shieldedPercentage: number;
  privacyScore: number;
};

function filterTrendsByPeriod(daily: TrendDay[], period: Period): TrendDay[] {
  if (period === 'all' || daily.length === 0) return daily;
  const daysMap: Record<Exclude<Period, 'all'>, number> = {
    '7d': 7,
    '30d': 30,
    '90d': 90,
    '1y': 365,
  };
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - daysMap[period]);
  const cutoffMs = cutoff.getTime();
  return daily.filter((row) => {
    const ms = parseTrendDate(row.date).getTime();
    return !Number.isNaN(ms) && ms >= cutoffMs;
  });
}

function chartDescription(view: TrendChartView) {
  if (view === 'adoption') {
    return 'Daily shielded share of shielded plus non-coinbase transparent transactions. This daily measure differs from the score’s 30-day input.';
  }
  if (view === 'activity') {
    return 'Daily shielded vs transparent transaction counts (coinbase excluded from transparent).';
  }
  return 'Privacy Score over time. Step changes may reflect formula updates.';
}

function buildShareText(
  view: TrendChartView,
  period: Period,
  privacyScore: number,
  chartData: TrendDay[],
) {
  const periodLabel = period === 'all' ? 'all time' : period.toUpperCase();
  const url = 'https://zecblock.com/privacy';
  const latest = chartData[chartData.length - 1];

  if (view === 'score') {
    const score = latest?.privacyScore ?? privacyScore;
    return `Zcash Privacy Score: ${score}/100 (${periodLabel}) on ZecBlock\n\n${url}`;
  }
  if (view === 'adoption' && latest) {
    return `Zcash shielded tx share: ${latest.shieldedPercentage.toFixed(1)}% (${periodLabel}) on ZecBlock\n\n${url}`;
  }
  if (view === 'activity' && latest) {
    return `Zcash shielded activity: ${latest.shielded.toLocaleString()} shielded txs (${periodLabel}) on ZecBlock\n\n${url}`;
  }
  return `Zcash privacy metrics on ZecBlock (${periodLabel})\n\n${url}`;
}

export function PrivacyTrendsSection({
  trendHistory,
  privacyScore,
  lastBlockScanned,
  theme,
  view,
  onViewChange,
  period,
  onPeriodChange,
}: {
  trendHistory: TrendDay[];
  privacyScore: number;
  lastBlockScanned: number;
  theme: 'dark' | 'light';
  view: TrendChartView;
  onViewChange: (view: TrendChartView) => void;
  period: Period;
  onPeriodChange: (period: Period) => void;
}) {
  const colors = getChartColors(theme);
  const filtered = useMemo(
    () => filterTrendsByPeriod(trendHistory, period),
    [trendHistory, period],
  );
  const chartData = useMemo(
    () =>
      [...filtered]
        .reverse()
        .map((row) => ({ ...row, date: normalizeTrendDateKey(row.date) })),
    [filtered],
  );
  const shareText = buildShareText(view, period, privacyScore, chartData);
  const tooltipStyle = {
    backgroundColor: colors.tooltipBg,
    border: `1px solid ${colors.tooltipBorder}`,
    borderRadius: '8px',
    color: colors.tooltipText,
    padding: '12px 16px',
    fontSize: 12,
  };

  const axisLabel = { fill: colors.axis, fontSize: 12 };
  const xLabel = { value: 'Date', position: 'insideBottom' as const, offset: -2, ...axisLabel };
  const yAdoptionLabel = {
    value: 'Shielded tx %',
    angle: -90,
    position: 'insideLeft' as const,
    ...axisLabel,
  };
  const yActivityLabel = {
    value: 'Transactions',
    angle: -90,
    position: 'insideLeft' as const,
    ...axisLabel,
  };
  const yScoreLabel = {
    value: 'Score (0–100)',
    angle: -90,
    position: 'insideLeft' as const,
    ...axisLabel,
  };

  return (
    <ShareableCard
      title="Historical trends"
      isLive={false}
      sourceHeight={lastBlockScanned}
      shareText={shareText}
      fileName="zecblock-privacy-trends.png"
      className=""
    >
      <div
        className="mb-4 flex flex-wrap items-center justify-between gap-3"
        data-html2canvas-ignore="true"
      >
        <PeriodPillTags
          aria-label="Trend chart view"
          options={CHART_VIEWS.map(({ id, label }) => ({ key: id, label }))}
          value={view}
          onChange={onViewChange}
        />
        <PeriodSelector value={period} onChange={onPeriodChange} />
      </div>

      <p className="mb-2 text-caption leading-relaxed text-muted">{chartDescription(view)}</p>
      {chartData.length > 0 && <p className="mb-5 text-caption font-mono text-muted">Latest recorded day · {formatTrendDate(chartData[chartData.length - 1].date)}</p>}

      {chartData.length === 0 ? (
        <div className="flex h-[320px] items-center justify-center text-xs font-mono text-muted">
          No trend data for this range.
        </div>
      ) : (
        <div className="h-[320px]">
          {view === 'adoption' && (
            <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 12, left: 4, bottom: 20 }}>
                <CartesianGrid vertical={false} stroke={colors.gridStroke} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: colors.axis, fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => formatTrendDate(value)}
                  minTickGap={24}
                  textAnchor="middle"
                  height={52}
                  label={xLabel}
                />
                <YAxis
                  tick={{ fill: colors.axis, fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  tickCount={5}
                  domain={[0, 100]}
                  width={52}
                  label={yAdoptionLabel}
                />
                <RechartsTooltip
                  cursor={{ stroke: colors.referenceLine, strokeDasharray: '3 4' }}
                  contentStyle={tooltipStyle}
                  labelFormatter={(label) => typeof label === 'string' || typeof label === 'number' ? formatTrendDate(label) : ''}
                  formatter={(v) => [`${Number(v).toFixed(1)}%`, 'Shielded tx share']}
                />
                <Line isAnimationActive={false}
                  type="monotone"
                  dataKey="shieldedPercentage"
                  stroke={colors.shielded}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
          {view === 'activity' && (
            <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height="100%">
              <BarChart barGap={3} maxBarSize={18} data={chartData} margin={{ top: 8, right: 12, left: 4, bottom: 20 }}>
                <CartesianGrid vertical={false} stroke={colors.gridStroke} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: colors.axis, fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => formatTrendDate(value)}
                  minTickGap={24}
                  textAnchor="middle"
                  height={52}
                  label={xLabel}
                />
                <YAxis
                  tick={{ fill: colors.axis, fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  tickCount={5}
                  tickFormatter={value => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value))}
                  width={56}
                  label={yActivityLabel}
                />
                <RechartsTooltip
                  cursor={{ fill: theme === 'dark' ? 'rgba(156,164,176,0.07)' : 'rgba(89,97,109,0.06)' }}
                  contentStyle={tooltipStyle}
                  labelFormatter={(label) => typeof label === 'string' || typeof label === 'number' ? formatTrendDate(label) : ''}
                  formatter={(value, name) => [Number(value).toLocaleString(), name]}
                />
                <Legend wrapperStyle={{ fontSize: 12, color: colors.axis }} />
                <Bar isAnimationActive={false} dataKey="shielded" name="Shielded" fill={colors.shielded} radius={[2, 2, 0, 0]} />
                <Bar isAnimationActive={false}
                  dataKey="transparent"
                  name="Transparent"
                  fill={colors.transparent}
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
          {view === 'score' && (
            <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 12, left: 4, bottom: 20 }}>
                <CartesianGrid vertical={false} stroke={colors.gridStroke} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: colors.axis, fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => formatTrendDate(value)}
                  minTickGap={24}
                  textAnchor="middle"
                  height={52}
                  label={xLabel}
                />
                <YAxis
                  tick={{ fill: colors.axis, fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  tickCount={5}
                  domain={[0, 100]}
                  width={52}
                  label={yScoreLabel}
                />
                <RechartsTooltip
                  cursor={{ stroke: colors.referenceLine, strokeDasharray: '3 4' }}
                  contentStyle={tooltipStyle}
                  labelFormatter={(label) => typeof label === 'string' || typeof label === 'number' ? formatTrendDate(label) : ''}
                  formatter={(v) => [`${Number(v).toFixed(0)} / 100`, 'Privacy Score']}
                />
                <Line isAnimationActive={false}
                  type="linear"
                  dataKey="privacyScore"
                  stroke={colors.gold}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </ShareableCard>
  );
}
