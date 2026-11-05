'use client';
import { ChartSkeleton } from '@/components/ui/Skeleton';

import { useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
} from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { useApiQuery } from '@/hooks/useApiQuery';
import { ChartCard } from './ChartCard';
import { objectRowsCsv } from '@/components/charts/PanelShareControl';

function ChartEmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-[260px] text-xs text-muted text-center px-6">
      {message}
    </div>
  );
}

export interface ChainSizeHistoryResponse {
  points: { time: string; sizeGB: number }[];
}

export function NetworkHistoryCharts({ initialData, initialFetchedAt }: { initialFetchedAt?: number; initialData?: ChainSizeHistoryResponse | null }) {
  const { theme } = useTheme();
  const colors = getChartColors(theme);

  const { data, loading, error } = useApiQuery<ChainSizeHistoryResponse>(
    '/v1/network/chain-size-history',
    { period: '30d' },
    { refreshInterval: 300_000, initialFetchedAt, initialData: initialData ?? undefined },
  );
  const sizePoints = useMemo(
    () => (data?.points ?? []).map((p) => ({
      time: p.time,
      sizeGB: p.sizeGB,
    })),
    [data],
  );

  return (
    <ChartCard title="NODE_STORAGE_HISTORY" height={260} watermarkSize="sm" share={{ title: 'Zcash node storage history', fileName: 'zecblock-node-storage-history', csv: () => objectRowsCsv(sizePoints) }}>
      <p className="text-caption text-muted mb-3">Last 30 days · Explorer node disk snapshots · GiB (1,024³ bytes). Storage depends on the node implementation.</p>
      {loading ? (
        <ChartSkeleton height={260} />
      ) : sizePoints.length > 0 ? (
        <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={260}>
          <LineChart data={sizePoints}>
            <CartesianGrid strokeDasharray="2 6" stroke={colors.grid} opacity={0.5} />
            <XAxis dataKey="time" stroke={colors.axis} tick={{ fill: colors.axis, fontSize: 12 }} minTickGap={48} tickFormatter={value => new Date(value).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })} />
            <YAxis stroke={colors.axis} tick={{ fill: colors.axis, fontSize: 12 }} tickFormatter={(v) => `${v.toFixed(0)} GiB`} domain={['auto', 'auto']} />
            <Tooltip
              labelFormatter={value => new Date(String(value)).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}
              cursor={{ stroke: colors.cursor }}
              contentStyle={{ backgroundColor: colors.tooltipBg, border: `1px solid ${colors.tooltipBorder}`, borderRadius: '8px', fontFamily: 'var(--font-geist-mono), monospace', fontSize: 12 }}
              itemStyle={{ color: colors.tooltipText }}
              labelStyle={{ color: colors.tooltipText }}
              formatter={(v) => [`${Number(v).toFixed(2)} GiB`, 'Node disk usage']}
            />
            <Line type="linear" dataKey="sizeGB" stroke={colors.yellow} strokeWidth={2} dot={sizePoints.length === 1} />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <ChartEmptyState message={error ? "Node storage history is unavailable." : "No node storage snapshots are available for the last 30 days."} />
      )}
    </ChartCard>
  );
}
