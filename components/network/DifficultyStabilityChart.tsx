'use client';

import {
  Area, CartesianGrid, ComposedChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis,
} from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { objectRowsCsv } from '@/components/charts/PanelShareControl';
import { ChartSkeleton } from '@/components/ui/Skeleton';
import { useTheme } from '@/contexts/ThemeContext';
import { useApiQuery } from '@/hooks/useApiQuery';
import { getChartColors } from '@/lib/chart-theme';
import { isMainnet } from '@/lib/config';
import { ChartCard } from './ChartCard';

interface EraSummary {
  days: number;
  blocks: number;
  missingBlocks: number;
  largestDropPct: number;
  largestRisePct: number;
  typicalSwingPct: number;
  typicalDailyRangePct: number | null;
}
interface StabilityPoint { timestamp: number; era: 'before' | 'after'; lowPct: number; highPct: number }
interface StabilityResponse {
  available?: boolean;
  activation?: { height: number; timestamp: number };
  before?: EraSummary;
  after?: EraSummary;
  swingReduction?: number | null;
  points?: StabilityPoint[];
}

const DAY_MS = 86_400_000;
const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}%`;
const utcDay = (ms: number) => { const date = new Date(ms); return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`; };

function ComparisonTile({ label, before, after }: { label: string; before: string; after: string }) {
  return (
    <div className="card p-3">
      <p className="text-caption text-muted font-mono uppercase mb-2">{label}</p>
      <dl className="grid grid-cols-2 gap-2 font-mono">
        <div><dt className="text-caption text-muted">Before</dt><dd className="text-sm text-secondary tabular-nums">{before}</dd></div>
        <div><dt className="text-caption text-muted">Since NU7</dt><dd className="text-sm font-semibold text-primary tabular-nums">{after}</dd></div>
      </dl>
    </div>
  );
}

/** Before/since NU7 difficulty swings, each measured against its own era's 24-hour median. */
export function DifficultyStabilityChart() {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const { data, loading, error } = useApiQuery<StabilityResponse>(
    '/v1/mining/difficulty-stability', undefined,
    { enabled: isMainnet, refreshInterval: 600_000, timeoutMs: 30_000 },
  );
  if (!isMainnet) return null;

  const { before, after, activation, swingReduction } = data ?? {};
  const ready = data?.available === true && before && after && activation;
  const activationMs = activation ? activation.timestamp * 1000 : 0;
  const rows = (data?.points ?? []).map(point => ({
    timestamp: point.timestamp * 1000, era: point.era, range: [point.lowPct, point.highPct] as [number, number],
  }));
  // The null row carries the NU7 line and keeps the eras from being joined by a drawn segment.
  const firstAfter = rows.findIndex(row => row.era === 'after');
  const chartRows: { timestamp: number; range: [number, number] | null }[] = firstAfter < 0 ? rows
    : [...rows.slice(0, firstAfter), { timestamp: activationMs, range: null }, ...rows.slice(firstAfter)];

  // Samples sit side by side, so a tick must be a sample that exists: the first of each UTC day.
  const seenDays = new Set<number>();
  const dayTicks = rows.flatMap(({ timestamp }) => {
    const day = Math.floor(timestamp / DAY_MS);
    if (seenDays.has(day)) return [];
    seenDays.add(day);
    return [timestamp];
  });

  return (
    <div id="difficulty-stability" className="scroll-mt-36">
      <ChartCard
        title="DIFFICULTY_STABILITY"
        height={280}
        watermarkSize="lg"
        share={{ title: 'Zcash difficulty swings before and since NU7', fileName: 'zecblock-difficulty-stability', csv: () => objectRowsCsv(data?.points ?? []) }}
      >
        {!ready ? (
          <div role="status" className="flex h-[280px] items-center justify-center text-caption text-muted">
            {loading ? <ChartSkeleton height={260} />
              : error ? 'Difficulty stability is temporarily unavailable.'
                : 'Not enough blocks since NU7 to compare difficulty yet.'}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold text-primary">
                {swingReduction != null ? `Difficulty swings are ${swingReduction.toFixed(1)}× smaller since NU7` : 'Difficulty swings before and since NU7'}
              </h2>
              <p className="text-xs text-muted mt-1">
                NU7 moved blocks from 75 to 25 seconds and widened the difficulty averaging window from 17 to 102 blocks.
                Each block is compared with the median difficulty of the surrounding 24 hours in its own era.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              <ComparisonTile label="Largest drop" before={signed(before.largestDropPct)} after={signed(after.largestDropPct)} />
              <ComparisonTile label="Largest rise" before={signed(before.largestRisePct)} after={signed(after.largestRisePct)} />
              <ComparisonTile label="Typical swing" before={`±${before.typicalSwingPct.toFixed(1)}%`} after={`±${after.typicalSwingPct.toFixed(1)}%`} />
              <ComparisonTile
                label="Daily high vs low"
                before={before.typicalDailyRangePct == null ? '—' : `${before.typicalDailyRangePct.toFixed(0)}%`}
                after={after.typicalDailyRangePct == null ? '—' : `${after.typicalDailyRangePct.toFixed(0)}%`}
              />
            </div>
            <div role="img" aria-label={`Difficulty deviation from the 24-hour median. Before NU7 it ranged from ${signed(before.largestDropPct)} to ${signed(before.largestRisePct)}. Since NU7 it has ranged from ${signed(after.largestDropPct)} to ${signed(after.largestRisePct)}.`}>
              <ResponsiveContainer initialDimension={{ width: 500, height: 280 }} width="100%" height={280}>
                <ComposedChart data={chartRows} margin={{ top: 20, right: 28, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} strokeDasharray="2 6" stroke={colors.grid} opacity={0.5} />
                  <XAxis
                    dataKey="timestamp" type="category" ticks={dayTicks} minTickGap={40}
                    stroke={colors.axis} tick={{ fill: colors.axis, fontSize: 12 }} tickFormatter={utcDay}
                  />
                  <YAxis stroke={colors.axis} tick={{ fill: colors.axis, fontSize: 12 }} width={56} tickFormatter={(v: number) => `${v > 0 ? '+' : ''}${v}%`} />
                  <ReferenceLine y={0} stroke={colors.axis} strokeWidth={1} />
                  <ReferenceLine x={activationMs} stroke={colors.referenceLine} strokeDasharray="4 4" label={{ value: 'NU7', position: 'top', fill: colors.axis, fontSize: 12 }} />
                  <Tooltip
                    labelFormatter={(value) => `${new Date(Number(value)).toISOString().slice(0, 16).replace('T', ' ')} UTC`}
                    formatter={(value) => {
                      const range = value as unknown as [number, number] | null;
                      return range ? [`${signed(range[0])} to ${signed(range[1])}`, 'From 24h median'] : ['Unavailable', 'From 24h median'];
                    }}
                  />
                  <Area type="linear" dataKey="range" stroke={colors.gold} strokeWidth={1} fill={colors.gold} fillOpacity={0.3} connectNulls={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <p className="text-caption text-muted">
              Band shows the lowest and highest block in each 30 minutes. Before covers the 14 days up to block {activation.height.toLocaleString('en-US')}
              ; since NU7 covers {after.days.toFixed(1)} days so far, up to the latest 14.
              {before.missingBlocks + after.missingBlocks > 0 && ` ${(before.missingBlocks + after.missingBlocks).toLocaleString('en-US')} blocks lacked difficulty data.`}
            </p>
          </div>
        )}
      </ChartCard>
    </div>
  );
}
