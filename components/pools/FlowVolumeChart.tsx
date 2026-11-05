'use client';
import { ChartSkeleton } from '@/components/ui/Skeleton';

import { useMemo, useState } from 'react';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,

  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors, getChartTooltipStyle } from '@/lib/chart-theme';
import { formatChartDate } from '@/lib/chart-dates';
import { getFlowColors } from '@/lib/flow-colors';
import { formatZecCompact } from '@/lib/format-numbers';
import { useApiQuery } from '@/hooks/useApiQuery';
import { ShareableCard } from '@/components/ShareableCard';
import { PeriodPillTags } from '@/components/ui/PeriodPillTags';
import { useUrlState } from '@/lib/use-url-state';

type Period = '30d' | '90d' | '1y' | 'all';
type PoolFilter = 'all' | 'ironwood' | 'sapling' | 'orchard';

interface FlowPoint {
  date: string;
  shield: number;
  deshield: number;
  net: number;
}

const CHART_HEIGHT = 320;

const POOL_OPTIONS: { key: PoolFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ironwood', label: 'Ironwood' },
  { key: 'orchard', label: 'Orchard' },
  { key: 'sapling', label: 'Sapling' },
];

const PERIOD_OPTIONS: { key: Period; label: string }[] = [
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
  { key: '1y', label: '1Y' },
  { key: 'all', label: 'ALL' },
];

function FlowTooltip({
  active,
  payload,
  label,
  colors,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string; payload?: Record<string, unknown> }>;
  label?: string;
  colors: ReturnType<typeof getChartColors>;
}) {
  if (!active || !payload?.length) return null;

  const row = payload[0]?.payload as FlowPoint | undefined;
  const dateStr = row?.date ?? String(label ?? '');

  return (
    <div
      className="rounded-lg border px-3 py-2 text-xs font-mono shadow-lg"
      style={getChartTooltipStyle(colors)}
    >
      <p className="mb-2 text-caption uppercase tracking-wider text-muted">{formatChartDate(dateStr)}</p>
      {payload.map((entry) => {
        const key = String(entry.name ?? '');
        const abs = Math.abs(Number(entry.value ?? 0));
        const entryLabel =
          key === 'deshield' ? 'Deshielded' : key === 'shield' ? 'Shielded' : 'Net Flow';
        return (
          <p key={key} className="tabular-nums text-secondary">
            <span style={{ color: entry.color }}>{entryLabel}</span>
            {': '}
            {abs.toFixed(2)} ZEC
          </p>
        );
      })}
    </div>
  );
}

export function FlowVolumeChart() {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const flowColors = getFlowColors(theme);
  const [period, setPeriod] = useUrlState<Period>('flows', '30d', PERIOD_OPTIONS.map((option) => option.key));
  const [poolFilter, setPoolFilter] = useState<PoolFilter>('all');
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());

  const { data: apiRes, loading } = useApiQuery<{ points: FlowPoint[] }>(
    '/v1/shielded-pools/flows',
    { period, pool: poolFilter },
  );
  const points = useMemo(
    () => (apiRes?.points ?? []).map((p) => ({ ...p, deshield: -Math.abs(p.deshield) })),
    [apiRes],
  );

  const poolLabel = POOL_OPTIONS.find((p) => p.key === poolFilter)?.label ?? 'All';
  const shareText = `Zcash shielding and deshielding flow (${poolLabel}, ${period.toUpperCase()}) on ZecBlock.\n\nhttps://zecblock.com/pools#flows`;

  const barSize = useMemo(
    () => Math.max(4, Math.floor(600 / Math.max(points.length, 1))),
    [points.length],
  );

  const controls = (
    <div className="mb-4 flex flex-wrap items-center justify-end gap-2" data-html2canvas-ignore="true">
      <PeriodPillTags
        options={POOL_OPTIONS}
        value={poolFilter}
        onChange={setPoolFilter}
        aria-label="Pool filter"
      />
      <PeriodPillTags
        options={PERIOD_OPTIONS}
        value={period}
        onChange={setPeriod}
        aria-label="Flow chart period"
      />
    </div>
  );

  const chartBody = loading ? (
    <ChartSkeleton height={CHART_HEIGHT} />
  ) : points.length === 0 ? (
    <div
      className="flex items-center justify-center text-xs font-mono text-muted"
      style={{ height: CHART_HEIGHT }}
    >
      No flow data available
    </div>
  ) : (
    <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={CHART_HEIGHT}>
      <ComposedChart data={points} barSize={barSize} barGap={-barSize}>
        <CartesianGrid strokeDasharray="2 6" stroke={colors.grid} opacity={0.5} />
        <XAxis
          dataKey="date"
          stroke={colors.axis}
          tick={{ fill: colors.axis, fontSize: 12 }}
          tickFormatter={(v) => formatChartDate(String(v))}
          interval="preserveStartEnd"
        />
        <YAxis
          stroke={colors.axis}
          tick={{ fill: colors.axis, fontSize: 12 }}
          tickFormatter={(v) => formatZecCompact(Math.abs(v))}
          width={54}
        />
        <Tooltip content={<FlowTooltip colors={colors} />} />
        <Legend
          wrapperStyle={{ fontSize: 12, paddingTop: 8, cursor: 'pointer' }}
          onClick={(data) => {
            const key = String(data.dataKey ?? '');
            if (!key) return;
            setHiddenSeries((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            });
          }}
          formatter={(value) => {
            const label =
              value === 'shield' ? 'Shielded' : value === 'deshield' ? 'Deshielded' : 'Net Flow';
            const hidden = hiddenSeries.has(String(value));
            return (
              <span
                style={{
                  opacity: hidden ? 0.35 : 1,
                  textDecoration: hidden ? 'line-through' : 'none',
                }}
              >
                {label}
              </span>
            );
          }}
        />
        <ReferenceLine y={0} stroke={colors.grid} strokeDasharray="2 6" />
        <Bar
          dataKey="shield"
          fill={flowColors.shielding}
          fillOpacity={0.7}
          radius={[2, 2, 0, 0]}
          name="shield"
          hide={hiddenSeries.has('shield')}
        />
        <Bar
          dataKey="deshield"
          fill={flowColors.deshielding}
          fillOpacity={0.55}
          radius={[0, 0, 2, 2]}
          name="deshield"
          hide={hiddenSeries.has('deshield')}
        />
        <Line
          type="monotone"
          dataKey="net"
          stroke={colors.tooltipText}
          strokeWidth={2}
          strokeDasharray="4 3"
          dot={false}
          name="net"
          hide={hiddenSeries.has('net')}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );

  return (
    <ShareableCard
      title="Public flows into and out of pools"
      sourceHeight={0}
      isLive={false}
      shareText={shareText}
      fileName="zecblock-flow-volume.png"
      watermark
      className=""
      footerNote={`${poolLabel} · ${period.toUpperCase()}`}
    >
      <p className="mb-4 max-w-2xl text-xs leading-relaxed text-secondary font-sans">
        Shielding means moving ZEC into a private pool. Deshielding means moving it back to a public address. Bars up
        = into privacy. Bars down = out of privacy.
      </p>
      {controls}
      {chartBody}
    </ShareableCard>
  );
}
