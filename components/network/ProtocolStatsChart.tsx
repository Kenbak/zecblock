'use client';
import { ChartSkeleton } from '@/components/ui/Skeleton';

import { useState, useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Legend, Brush,
} from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { useApiQuery } from '@/hooks/useApiQuery';
import { ChartCard } from './ChartCard';
import { useUrlState } from '@/lib/use-url-state';
import { objectRowsCsv } from '@/components/charts/PanelShareControl';

export interface RawPoint {
  month: string;
  saplingCommitments: number;
  saplingNullifiers: number;
  orchardCommitments: number;
  orchardNullifiers: number;
  ironwoodCommitments: number;
  ironwoodNullifiers: number;
}

interface ChartPoint extends RawPoint {
  label: string;
}

function formatMillions(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return v.toString();
}

type Period = '30d' | '2y' | '4y' | 'all';

export interface ProtocolStatsResponse {
  success: boolean;
  current: RawPoint;
  history: RawPoint[];
}

export function ProtocolStatsChart({ initialData, initialFetchedAt }: { initialFetchedAt?: number; initialData?: ProtocolStatsResponse | null }) {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const [view, setView] = useState<'commitments' | 'nullifiers'>('commitments');
  const [period, setPeriod] = useUrlState<Period>('protocol', '30d', ['30d', '2y', '4y', 'all']);

  const { data: apiData, loading } = useApiQuery<ProtocolStatsResponse>(
    '/v1/network/protocol-stats',
    undefined,
    { refreshInterval: 300_000, initialFetchedAt, initialData: initialData ?? undefined },
  );
  const current = apiData?.current ?? null;
  const rawData = useMemo(
    () => (apiData?.history ?? []).filter((p) =>
      p.saplingCommitments > 0 || p.orchardCommitments > 0 || p.ironwoodCommitments > 0
    ),
    [apiData],
  );

  const data: ChartPoint[] = useMemo(() => {
    if (!rawData.length) return [];

    let filtered = rawData;
    if (period !== 'all') {
      const now = Date.now();
      const cutoff = new Date(now);
      if (period === '30d') cutoff.setTime(now - 30 * 86_400_000);
      else cutoff.setUTCFullYear(cutoff.getUTCFullYear() - (period === '2y' ? 2 : 4));
      filtered = rawData.filter(p => {
        const timestamp = Date.parse(p.month);
        if (timestamp > now) return false;
        if (period !== '30d') return timestamp >= cutoff.getTime();
        const month = new Date(timestamp);
        const nextMonth = Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1);
        return nextMonth > cutoff.getTime();
      });
    }

    return filtered.map(p => ({
      ...p,
      label: new Date(p.month).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
    }));
  }, [rawData, period]);

  const controls = (
    <div className="flex flex-wrap gap-1">
      {(['commitments', 'nullifiers'] as const).map(v => (
        <button
          type="button"
          key={v}
          onClick={() => setView(v)}
          aria-pressed={view === v}
          className={`px-2 py-0.5 text-caption font-mono rounded transition-colors ${
            view === v ? 'bg-brand-gold/20 text-cipher-gold' : 'text-muted hover:text-secondary'
          }`}
        >
          {v === 'commitments' ? 'Trees' : 'Nullifiers'}
        </button>
      ))}
      <span className="w-px bg-cipher-border-alpha/30 mx-1" />
      {(['30d', '2y', '4y', 'all'] as const).map(p => (
        <button
          type="button"
          key={p}
          onClick={() => setPeriod(p)}
          aria-pressed={period === p}
          className={`px-2 py-0.5 text-caption font-mono rounded transition-colors ${
            period === p ? 'bg-brand-gold/20 text-cipher-gold' : 'text-muted hover:text-secondary'
          }`}
        >
          {p === 'all' ? 'All' : p.toUpperCase()}
        </button>
      ))}
    </div>
  );

  if (loading) {
    return (
      <ChartCard title="PROTOCOL_GROWTH" height={280} watermarkSize="sm" controls={controls}>
        <ChartSkeleton height={280} />
      </ChartCard>
    );
  }

  if (!data.length) {
    return (
      <ChartCard title="PROTOCOL_GROWTH" height={280} watermarkSize="sm" controls={controls}>
        <div className="flex items-center justify-center h-[280px] text-xs text-muted">
          No monthly protocol buckets overlap this range
        </div>
      </ChartCard>
    );
  }

  return (
    <ChartCard title="PROTOCOL_GROWTH" height={280} watermarkSize="sm" controls={controls} share={{ title: `Zcash protocol growth (${period})`, fileName: `zecblock-protocol-growth-${period}`, csv: () => objectRowsCsv(data) }}>
      {current && (
        <div className="mb-3">
          <div className="flex gap-4 flex-wrap">
            {view === 'commitments' ? (
              <>
                <div className="text-caption font-mono">
                  <span className="text-muted">Sapling tree: </span>
                  <span className="text-cipher-green font-semibold">{formatMillions(current.saplingCommitments)}</span>
                </div>
                <div className="text-caption font-mono">
                  <span className="text-muted">Orchard tree: </span>
                  <span className="text-cipher-purple font-semibold">{formatMillions(current.orchardCommitments)}</span>
                </div>
                {(current.ironwoodCommitments || 0) > 0 && (
                  <div className="text-caption font-mono">
                    <span className="text-muted">Ironwood tree: </span>
                    <span className="text-cipher-ironwood font-semibold">{formatMillions(current.ironwoodCommitments)}</span>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="text-caption font-mono">
                  <span className="text-muted">Sapling nullifiers: </span>
                  <span className="text-cipher-green font-semibold">{formatMillions(current.saplingNullifiers)}</span>
                </div>
                <div className="text-caption font-mono">
                  <span className="text-muted">Orchard nullifiers: </span>
                  <span className="text-cipher-purple font-semibold">{formatMillions(current.orchardNullifiers)}</span>
                </div>
                {(current.ironwoodNullifiers || 0) > 0 && (
                  <div className="text-caption font-mono">
                    <span className="text-muted">Ironwood nullifiers: </span>
                    <span className="text-cipher-ironwood font-semibold">{formatMillions(current.ironwoodNullifiers)}</span>
                  </div>
                )}
              </>
            )}
          </div>
          <p className="text-caption font-mono text-muted mt-1.5">
            {view === 'commitments'
              ? 'Cumulative note commitments in each pool’s Merkle tree. These are protocol records, not transaction counts or a privacy score.'
              : 'Nullifiers revealed when notes are spent. Sapling counts real spends only. Orchard includes padding (each Action = 1 spend + 1 output for uniform privacy).'}
          </p>
        </div>
      )}
      <p className="text-caption text-muted mb-3">Monthly buckets overlapping the selected UTC window; 30D can include partial months.</p>
      <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={240}>
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="2 6" stroke={colors.grid} opacity={0.5} />
          <XAxis
            dataKey="label"
            stroke={colors.axis}
            tick={{ fill: colors.axis, fontSize: 12 }}
            interval="preserveStartEnd"
          />
          <YAxis
            stroke={colors.axis}
            tick={{ fill: colors.axis, fontSize: 12 }}
            tickFormatter={formatMillions}
            width={56}
            domain={period === 'all' || period === '4y' ? [0, 'auto'] : ['dataMin', 'auto']}
          />
          <Tooltip
            contentStyle={{ backgroundColor: 'var(--color-surface-solid)', border: '1px solid var(--color-border-subtle)', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-geist-mono)', fontSize: 12 }}
            formatter={(value) => formatMillions(Number(value))}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, fontFamily: 'var(--font-geist-mono)' }}
          />
          {view === 'commitments' ? (
            <>
              <Area
                type="linear"
                dataKey="saplingCommitments"
                name="Sapling notes"
                stroke={colors.sapling}
                fill={colors.sapling}
                fillOpacity={0.15}
                strokeWidth={1.5}
                dot={data.length === 1 ? { r: 3 } : false}
              />
              <Area
                type="linear"
                dataKey="orchardCommitments"
                name="Orchard notes"
                stroke={colors.orchard}
                fill={colors.orchard}
                fillOpacity={0.15}
                strokeWidth={1.5}
                dot={data.length === 1 ? { r: 3 } : false}
              />
              <Area
                type="linear"
                dataKey="ironwoodCommitments"
                name="Ironwood notes"
                stroke={colors.ironwood}
                fill={colors.ironwood}
                fillOpacity={0.15}
                strokeWidth={1.5}
                dot={data.length === 1 ? { r: 3 } : false}
              />
            </>
          ) : (
            <>
              <Area
                type="linear"
                dataKey="saplingNullifiers"
                name="Sapling nullifiers"
                stroke={colors.sapling}
                fill={colors.sapling}
                fillOpacity={0.15}
                strokeWidth={1.5}
                dot={data.length === 1 ? { r: 3 } : false}
              />
              <Area
                type="linear"
                dataKey="orchardNullifiers"
                name="Orchard nullifiers"
                stroke={colors.orchard}
                fill={colors.orchard}
                fillOpacity={0.15}
                strokeWidth={1.5}
                dot={data.length === 1 ? { r: 3 } : false}
              />
              <Area
                type="linear"
                dataKey="ironwoodNullifiers"
                name="Ironwood nullifiers"
                stroke={colors.ironwood}
                fill={colors.ironwood}
                fillOpacity={0.15}
                strokeWidth={1.5}
                dot={data.length === 1 ? { r: 3 } : false}
              />
            </>
          )}
          <Brush
            dataKey="label"
            height={20}
            stroke="var(--color-border-subtle)"
            fill="var(--color-surface-solid)"
            travellerWidth={8}
            tickFormatter={() => ''}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
