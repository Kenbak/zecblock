'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts';
import { ChartTooltip as RechartsTooltip } from '@/components/charts/ChartTooltip';
import { ShareableCard } from '@/components/ShareableCard';
import { PeriodSelector, type Period } from '@/components/privacy/PeriodSelector';
import { getChartColors } from '@/lib/chart-theme';
import { formatTrendDate, normalizeTrendDateKey, parseTrendDate } from '@/lib/privacy-trend-dates';

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

const POINTER_LINK = 'text-secondary underline decoration-cipher-border underline-offset-4 hover:text-primary hover:decoration-current';

/**
 * The score over time. The score's inputs are charted where they are counted
 * (transactions on Transactions, supply on Shielded Pools), so this page links
 * to those charts instead of drawing them a second time.
 */
export function PrivacyTrendsSection({
  trendHistory,
  privacyScore,
  lastBlockScanned,
  theme,
  period,
  onPeriodChange,
}: {
  trendHistory: TrendDay[];
  privacyScore: number;
  lastBlockScanned: number;
  theme: 'dark' | 'light';
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
  const latest = chartData[chartData.length - 1];
  const periodLabel = period === 'all' ? 'all time' : period.toUpperCase();
  const shareText = `Zcash Privacy Score: ${latest?.privacyScore ?? privacyScore}/100 (${periodLabel}) on ZecBlock\n\nhttps://zecblock.com/privacy`;
  const tooltipStyle = {
    backgroundColor: colors.tooltipBg,
    border: `1px solid ${colors.tooltipBorder}`,
    borderRadius: '8px',
    color: colors.tooltipText,
    padding: '12px 16px',
    fontSize: 12,
  };
  const axisLabel = { fill: colors.axis, fontSize: 12 };

  return (
    <ShareableCard
      title="Privacy Score history"
      isLive={false}
      sourceHeight={lastBlockScanned}
      shareText={shareText}
      fileName="zecblock-privacy-score-history.png"
      className=""
    >
      <div
        className="mb-4 flex flex-wrap items-center justify-between gap-3"
        data-html2canvas-ignore="true"
      >
        <p className="text-caption leading-relaxed text-muted">Steps in the line can come from formula updates.</p>
        <PeriodSelector value={period} onChange={onPeriodChange} />
      </div>

      <p className="mb-2 text-caption text-muted" data-html2canvas-ignore="true">
        Charts of the inputs:{' '}
        <Link href="/txs?view=activity" className={POINTER_LINK}>Daily shielded share and counts <span aria-hidden="true">→</span></Link>
        {' · '}
        <Link href="/pools" className={POINTER_LINK}>Shielded supply <span aria-hidden="true">→</span></Link>
      </p>
      {latest && <p className="mb-5 text-caption font-mono text-muted">Latest recorded day · {formatTrendDate(latest.date)}</p>}

      {chartData.length === 0 ? (
        <div className="flex h-[320px] items-center justify-center text-xs font-mono text-muted">
          No score history for this range.
        </div>
      ) : (
        <div className="h-[320px]">
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
                label={{ value: 'Date', position: 'insideBottom' as const, offset: -2, ...axisLabel }}
              />
              <YAxis
                tick={{ fill: colors.axis, fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                tickCount={5}
                domain={[0, 100]}
                width={52}
                label={{ value: 'Score (0–100)', angle: -90, position: 'insideLeft' as const, ...axisLabel }}
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
        </div>
      )}
    </ShareableCard>
  );
}
