'use client';
import { formatDateUTC } from '@/lib/utils';
import { nonCoinbaseActivity, shieldedListParams } from '@/lib/transaction-list';
import { readApiData } from '@/lib/api-client';
import { ChartWatermark } from '@/components/ChartWatermark';
import { ChartSkeleton } from '@/components/ui/Skeleton';

import { useState, useEffect, useRef, useMemo } from 'react';
import Link from 'next/link';
import { RelativeTime } from '@/components/RelativeTime';
import { parseTransactionListItems, type TransactionListItem as Transaction } from '@/lib/transaction-list';
import { formatZecPrecise, zatToZec } from '@/lib/format-numbers';
import { getApiUrl } from '@/lib/api-config';
import { Pagination } from '@/components/Pagination';
import { ShieldFlowBadge } from '@/components/ShieldFlowBadge';
import { resolveShieldFlowType } from '@/components/icons/shield-flow';
import { PageHeader, MetricCard, Tabs, DataTable, HashLink, RedactedAmount, TxTypeBadge, FilterGroup, FilterButton, type DataTableColumn, type TxCategory } from '@/components/ui';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { usePaginatedList, type BasePaginationState } from '@/hooks/usePaginatedList';
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Legend,
} from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { useUrlState } from '@/lib/use-url-state';
import { PanelShareControl } from '@/components/charts/PanelShareControl';

// ─── Types ────────────────────────────────────────────────────────────────────

type TxType = 'all' | 'shielded' | 'transparent' | 'coinbase';
type FlowFilter = 'all' | 'shield' | 'deshield' | 'fully_shielded';
type PoolFilter = 'all' | 'ironwood' | 'sapling' | 'orchard' | 'mixed';
type ViewTab = 'recent' | 'trends';


interface ShieldedFlow {
  id: number;
  txid: string;
  blockHeight: number;
  blockTime: number;
  flowType: string;
  amountZec: number | null;
  actions?: number;
  pool: string;
  addresses: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function knownAmountZec(tx: Transaction): number | null {
  const sap = Number(tx.value_balance_sapling) || 0;
  const orc = Number(tx.value_balance_orchard) || 0;
  const irn = Number(tx.value_balance_ironwood) || 0;
  const transparentOutZat = Number(tx.total_output) || 0;

  if (tx.vin_count === 0 && tx.vout_count === 0) {
    const source = orc > 0 ? 'orchard' : sap > 0 ? 'sapling' : irn > 0 ? 'ironwood' : null;
    if (source) {
      const destZat = irn < 0 ? Math.abs(irn) : orc < 0 ? Math.abs(orc) : sap < 0 ? Math.abs(sap) : 0;
      if (destZat > 0) return zatToZec(destZat);
    }
  }

  const valueBalanceZat = sap + orc + irn;
  const shieldedDepositZat = valueBalanceZat < 0 ? Math.abs(valueBalanceZat) : 0;
  const totalZat = transparentOutZat + shieldedDepositZat;
  if (totalZat > 0) return zatToZec(totalZat);
  if (tx.is_coinbase) return zatToZec(totalZat);
  return null;
}

function getTxBadge(tx: Transaction) {
  const category: TxCategory = tx.is_coinbase
    ? 'coinbase'
    : tx.has_ironwood
      ? 'ironwood'
      : tx.has_orchard && tx.has_sapling
        ? 'orchard_sapling'
        : tx.has_orchard
          ? 'orchard'
          : tx.has_sapling
            ? 'sapling'
            : 'transparent';
  return <TxTypeBadge category={category} />;
}

function getFlowBadge(tx: Transaction) {
  if (tx.is_coinbase) {
    return (
      <span className="inline-flex items-center text-cipher-green text-sm" title="Coinbase (mining reward)">
        ⛏
      </span>
    );
  }

  const type = resolveShieldFlowType({
    flowType: tx.flow_type,
    vinCount: tx.vin_count,
    voutCount: tx.vout_count,
    valueBalanceSapling: Number(tx.value_balance_sapling),
    valueBalanceOrchard: Number(tx.value_balance_orchard),
    valueBalanceIronwood: Number(tx.value_balance_ironwood),
  });

  if (!tx.has_orchard && !tx.has_sapling && !tx.has_ironwood && !tx.flow_type) {
    return (
      <span className="inline-flex items-center text-muted" title="Transparent">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </span>
    );
  }

  return <ShieldFlowBadge type={type} variant="compact" />;
}

function getShieldedFlowBadge(flowType: string) {
  return <ShieldFlowBadge type={resolveShieldFlowType({ flowType })} variant="compact" />;
}

function getPoolBadge(pool: string) {
  if (pool === 'ironwood' || pool === 'orchard' || pool === 'sapling' || pool === 'mixed') {
    return <TxTypeBadge category={pool} />;
  }
  return <TxTypeBadge category="transparent" label={pool.toUpperCase()} />;
}

// ─── Column Definitions ───────────────────────────────────────────────────────

const txColumns: DataTableColumn<Transaction>[] = [
  {
    id: 'txid',
    header: 'TxID',
    skeletonWidth: 'w-28',
    cell: (tx) => (
      <HashLink value={tx.txid} href={`/tx/${tx.txid}`} lead={12} tail={6} responsive />
    ),
  },
  { id: 'type', header: 'Type', cell: (tx) => getTxBadge(tx) },
  {
    id: 'flow',
    header: 'Flow',
    className: 'hidden lg:table-cell',
    skeletonWidth: 'w-16',
    cell: (tx) => getFlowBadge(tx),
  },
  {
    id: 'amount',
    header: 'Amount',
    align: 'right',
    skeletonWidth: 'w-16',
    cell: (tx) => {
      const amount = knownAmountZec(tx);
      if (amount === null) return <RedactedAmount className="!text-xs" />;
      return <span className="font-mono text-xs text-primary font-semibold tabular-nums whitespace-nowrap">{formatZecPrecise(amount)} <span className="text-muted font-normal">ZEC</span></span>;
    },
  },
  {
    id: 'block',
    header: 'Block',
    align: 'right',
    className: 'hidden sm:table-cell',
    cell: (tx) => (
      <Link href={`/block/${tx.block_height}`} prefetch={false} className="font-mono text-xs text-muted hover:text-primary transition-colors">
        #{tx.block_height.toLocaleString()}
      </Link>
    ),
  },
  {
    id: 'size',
    header: 'Size',
    align: 'right',
    className: 'hidden md:table-cell',
    skeletonWidth: 'w-14',
    cell: (tx) => (
      <span className="font-mono text-xs text-muted">{tx.size ? `${(tx.size / 1024).toFixed(1)} KB` : '—'}</span>
    ),
  },
  {
    id: 'age',
    header: 'Age',
    align: 'right',
    skeletonWidth: 'w-16',
    cell: (tx) => (
      <RelativeTime timestamp={tx.block_time} className="text-xs text-muted whitespace-nowrap" />
    ),
  },
];

const shieldedColumns: DataTableColumn<ShieldedFlow>[] = [
  {
    id: 'txid',
    header: 'TxID',
    skeletonWidth: 'w-28',
    cell: (flow) => (
      <HashLink value={flow.txid} href={`/tx/${flow.txid}`} lead={12} tail={6} responsive />
    ),
  },
  {
    id: 'pool',
    header: 'Pool',
    skeletonWidth: 'w-16',
    cell: (flow) => getPoolBadge(flow.pool),
  },
  {
    id: 'flow',
    header: 'Flow',
    className: 'hidden lg:table-cell',
    skeletonWidth: 'w-16',
    cell: (flow) => getShieldedFlowBadge(flow.flowType),
  },
  {
    id: 'amount',
    header: 'Amount',
    align: 'right',
    cell: (flow) => (
      <span className="font-mono text-xs text-primary">
        {flow.amountZec != null
          ? <span className="font-semibold tabular-nums whitespace-nowrap">{flow.amountZec.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} <span className="text-muted font-normal">ZEC</span></span>
          : <RedactedAmount className="!text-xs" />
        }
      </span>
    ),
  },
  {
    id: 'block',
    header: 'Block',
    align: 'right',
    className: 'hidden sm:table-cell',
    cell: (flow) => (
      <Link href={`/block/${flow.blockHeight}`} prefetch={false} className="font-mono text-xs text-muted hover:text-primary transition-colors">
        #{flow.blockHeight.toLocaleString()}
      </Link>
    ),
  },
  {
    id: 'age',
    header: 'Age',
    align: 'right',
    skeletonWidth: 'w-16',
    cell: (flow) => (
      <RelativeTime timestamp={flow.blockTime} className="text-xs text-muted whitespace-nowrap" />
    ),
  },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

interface TxPaginationState extends BasePaginationState {
  nextCursorIdx: number | null;
  prevCursorIdx: number | null;
}

interface ShieldedPaginationState extends BasePaginationState {
  nextCursorId: number | null;
  prevCursorId: number | null;
}

const PAGE_SIZE = 25;

function useTransactionsList({
  typeFilter,
  initialTxs,
  initialPagination,
  initialPage,
  initialCursor,
  initialCursorIdx,
  initialDirection,
  initialUnavailable,
}: {
  typeFilter: TxType;
  initialTxs: Transaction[];
  initialPagination: Partial<TxPaginationState> | null;
  initialPage: number;
  initialCursor: string | null;
  initialCursorIdx: number | null;
  initialDirection: 'next' | 'prev';
  initialUnavailable: boolean;
}) {
  const previousTypeFilter = useRef<TxType>(typeFilter);

  const {
    items: txs,
    page,
    pagination,
    loading,
    dataAvailable,
    firstHref,
    prevHref,
    nextHref,
    fetchPage,
    setPage,
  } = usePaginatedList<Transaction, TxPaginationState>({
    endpoint: '/v1/transactions',
    pageSize: PAGE_SIZE,
    archiveBasePath: '/txs',
    buildParams: () => ({ type: typeFilter }),
    parseItems: parseTransactionListItems,
    getLatestKey: (tx) => tx.txid,
    buildArchiveHref: (cursor, cursorIdx, direction, targetPage) => {
      const params = new URLSearchParams();
      if (typeFilter !== 'all') params.set('type', typeFilter);
      if (targetPage > 1 && cursor !== null) {
        params.set('cursor', String(cursor));
        params.set('direction', direction);
        params.set('page', String(targetPage));
      }
      const query = params.toString();
      return query ? `/txs?${query}` : '/txs';
    },
    initialItems: initialTxs,
    initialPagination,
    initialPage,
    initialCursor,
    initialDirection,
    initialUnavailable,
  });

  useEffect(() => {
    if (previousTypeFilter.current === typeFilter) return;
    previousTypeFilter.current = typeFilter;
    setPage(1);
    fetchPage({ cursor: null, secondaryCursor: null, targetPage: 1 });
  }, [typeFilter, fetchPage, setPage]);

  return {
    txs, page, pagination, loading, dataAvailable,
    firstHref, prevHref, nextHref,
  };
}

function useShieldedFlowsList({
  flowFilter,
  poolFilter,
  minZec,
  initialFlows,
  initialPagination,
  initialPage,
  initialCursor,
  initialCursorId,
  initialDirection,
  initialUnavailable,
}: {
  flowFilter: FlowFilter;
  poolFilter: PoolFilter;
  minZec: number;
  initialFlows: ShieldedFlow[];
  initialPagination: Partial<ShieldedPaginationState> | null;
  initialPage: number;
  initialCursor: string | null;
  initialCursorId: number | null;
  initialDirection: 'next' | 'prev';
  initialUnavailable: boolean;
}) {
  const previousFilters = useRef({ flow: flowFilter, pool: poolFilter, minZec });

  const {
    items: flows,
    page,
    pagination,
    loading,
    dataAvailable,
    firstHref,
    prevHref,
    nextHref,
    fetchPage,
    setPage,
  } = usePaginatedList<ShieldedFlow, ShieldedPaginationState>({
    endpoint: '/v1/transactions/shielded',
    pageSize: PAGE_SIZE,
    archiveBasePath: '/txs',
    buildParams: () => shieldedListParams(flowFilter, poolFilter, minZec),
    getLatestKey: (flow) => `${flow.txid}:${flow.flowType}`,
    buildArchiveHref: (cursor, cursorId, direction, targetPage) => {
      const params = new URLSearchParams();
      params.set('type', 'shielded');
      if (flowFilter !== 'all') params.set('flow_type', flowFilter);
      if (poolFilter !== 'all') params.set('pool', poolFilter);
      if (minZec > 0) params.set('min_zec', String(minZec));
      if (targetPage > 1 && cursor !== null) {
        params.set('cursor', String(cursor));
        params.set('direction', direction);
        params.set('page', String(targetPage));
      }
      const query = params.toString();
      return query ? `/txs?${query}` : '/txs?type=shielded';
    },
    initialItems: initialFlows,
    initialPagination,
    initialPage,
    initialCursor,
    initialDirection,
    initialUnavailable,
  });

  useEffect(() => {
    const prev = previousFilters.current;
    if (prev.flow === flowFilter && prev.pool === poolFilter && prev.minZec === minZec) return;
    previousFilters.current = { flow: flowFilter, pool: poolFilter, minZec };
    setPage(1);
    fetchPage({ cursor: null, secondaryCursor: null, targetPage: 1 });
  }, [flowFilter, poolFilter, minZec, fetchPage, setPage]);

  return {
    flows, page, pagination, loading, dataAvailable,
    firstHref, prevHref, nextHref,
  };
}

// ─── Trends Chart ─────────────────────────────────────────────────────────────

interface TrendDay {
  date: string;
  shielded: number;
  transparent: number;
  shieldedPercentage: number;
}

type TrendPeriod = '7' | '30' | '365' | 'all';

function formatDateShort(dateStr: string): string {
  const raw = String(dateStr).split('T')[0];
  const d = new Date(raw + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const PERIOD_OPTIONS: { id: TrendPeriod; label: string }[] = [
  { id: '7', label: '7D' },
  { id: '30', label: '30D' },
  { id: '365', label: '1Y' },
  { id: 'all', label: 'All' },
];

function TrendsChart() {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [period, setPeriod] = useUrlState<TrendPeriod>('trend', '30', PERIOD_OPTIONS.map((option) => option.id));
  const [data, setData] = useState<TrendDay[]>([]);
  const [loading, setLoading] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Ignore a slower response for a period that is no longer selected.
    let cancelled = false;
    setLoading(true);
    const base = getApiUrl();
    const days = period === 'all' ? 'all' : Number(period);
    fetch(`${base}/v1/privacy/stats?days=${days}`)
      .then(res => res.ok ? readApiData(res) : null)
      .then(json => {
        if (!cancelled && json?.trends?.daily) setData(json.trends.daily);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period]);

  const chartData = useMemo(
    () => [...data].reverse().map(d => ({
      date: formatDateShort(d.date),
      shielded: d.shielded,
      transparent: d.transparent,
      shieldedPct: d.shieldedPercentage,
    })),
    [data],
  );

  const derived = useMemo(() => {
    if (data.length === 0) return { totalTxs: 0, avgDaily: 0, peakDay: null };
    const totalTxs = data.reduce((s, d) => s + d.shielded + d.transparent, 0);
    const avgDaily = Math.round(totalTxs / data.length);
    const peakDay = data.reduce((best, d) => (d.shielded + d.transparent) > (best.shielded + best.transparent) ? d : best, data[0]);
    return { totalTxs, avgDaily, peakDay };
  }, [data]);

  const periodLabel = period === 'all' ? 'All Time' : period === '365' ? '1 Year' : `${period} Days`;

  return (
    <div>
      <div ref={panelRef} className="card p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <h3 className="text-sm font-mono text-muted uppercase tracking-wider">Daily Transaction Volume</h3>
          <div className="flex flex-wrap items-center gap-2">
            <FilterGroup inline>
              {PERIOD_OPTIONS.map(p => (
                <FilterButton key={p.id} active={period === p.id} onClick={() => setPeriod(p.id)}>
                  {p.label}
                </FilterButton>
              ))}
            </FilterGroup>
            <PanelShareControl
              title={`Zcash daily shielded and transparent transactions (${periodLabel})`}
              fileName={`zecblock-daily-transactions-${period}`}
              panelRef={panelRef}
              disabled={loading || data.length === 0}
              csv={() => data.length ? {
                headers: ['Date (UTC)', 'Shielded transactions', 'Transparent transactions', 'Shielded share (%)'],
                rows: [...data].reverse().map(d => [d.date, d.shielded, d.transparent, d.shieldedPercentage]),
              } : null}
            />
          </div>
        </div>
        {loading ? (
          <ChartSkeleton height={320} />
        ) : (
        <div className="h-[320px]">
          <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 12, fill: colors.axis }}
                tickLine={false}
                axisLine={{ stroke: colors.grid }}
                interval="preserveStartEnd"
              />
              <YAxis
                yAxisId="left"
                tick={{ fontSize: 12, fill: colors.axis }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 12, fill: colors.axis }}
                tickLine={false}
                axisLine={false}
                domain={[0, 100]}
                tickFormatter={(v: number) => `${v}%`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: colors.tooltipBg,
                  border: `1px solid ${colors.tooltipBorder}`,
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: colors.tooltipText, fontWeight: 600, marginBottom: 4 }}
                itemStyle={{ color: colors.tooltipText }}
                formatter={(value: unknown, name: unknown) => {
                  const v = Number(value);
                  const n = String(name);
                  if (n === 'shieldedPct') return [`${v.toFixed(1)}%`, 'Shielded %'];
                  return [v.toLocaleString(), n === 'shielded' ? 'Shielded Txs' : 'Transparent Txs'];
                }}
              />
              <Legend
                wrapperStyle={{ fontSize: 12, cursor: 'pointer' }}
                onClick={(entry) => {
                  const key = (entry as { dataKey?: string }).dataKey;
                  if (key) setHidden(prev => ({ ...prev, [key]: !prev[key] }));
                }}
                formatter={(value: string) => {
                  const labels: Record<string, string> = { shielded: 'Shielded Txs', transparent: 'Transparent Txs', shieldedPct: 'Shielded %' };
                  return <span style={{ opacity: hidden[value] ? 0.4 : 1 }}>{labels[value] || value}</span>;
                }}
              />
              <Area
                yAxisId="left"
                type="monotone"
                dataKey="transparent"
                stackId="txs"
                fill={colors.transparent}
                fillOpacity={0.3}
                stroke={colors.transparent}
                strokeWidth={1.5}
                hide={!!hidden['transparent']}
              />
              <Area
                yAxisId="left"
                type="monotone"
                dataKey="shielded"
                stackId="txs"
                fill={colors.shielded}
                fillOpacity={0.4}
                stroke={colors.shielded}
                strokeWidth={1.5}
                hide={!!hidden['shielded']}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="shieldedPct"
                stroke={colors.gold}
                strokeWidth={2}
                dot={false}
                hide={!!hidden['shieldedPct']}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        )}
        <ChartWatermark />
      </div>

      <div className="grid grid-cols-3 gap-3 mt-4">
        <MetricCard size="compact"
          label={`Total (${periodLabel})`}
          value={derived.totalTxs.toLocaleString()}
        />
        <MetricCard size="compact"
          label="Avg Daily"
          value={derived.avgDaily.toLocaleString()}
        />
        <MetricCard size="compact"
          label="Peak Day"
          value={derived.peakDay ? `${formatDateShort(derived.peakDay.date)} — ${(derived.peakDay.shielded + derived.peakDay.transparent).toLocaleString()}` : '—'}
        />
      </div>
    </div>
  );
}

// ─── Filter Definitions ───────────────────────────────────────────────────────

const TYPE_FILTERS: { id: TxType; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'shielded', label: 'Shielded' },
  { id: 'transparent', label: 'Transparent' },
  { id: 'coinbase', label: 'Coinbase' },
];

const FLOW_FILTERS: { id: FlowFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'shield', label: 'Shielding' },
  { id: 'deshield', label: 'Unshielding' },
  { id: 'fully_shielded', label: 'Fully Shielded' },
];

const POOL_FILTERS: { id: PoolFilter; label: string }[] = [
  { id: 'all', label: 'All Pools' },
  { id: 'ironwood', label: 'Ironwood' },
  { id: 'orchard', label: 'Orchard' },
  { id: 'sapling', label: 'Sapling' },
  { id: 'mixed', label: 'Mixed' },
];

const AMOUNT_PRESETS = [
  { value: 0, label: 'Any' },
  { value: 10, label: '> 10 ZEC' },
  { value: 100, label: '> 100 ZEC' },
  { value: 1000, label: '> 1K ZEC' },
];

// ─── Main Component ───────────────────────────────────────────────────────────

export interface TxsClientProps {
  initialTxs?: Transaction[];
  initialFlows?: ShieldedFlow[];
  initialPagination?: Partial<TxPaginationState & ShieldedPaginationState> | null;
  initialPage?: number;
  initialType?: TxType;
  initialFlowFilter?: FlowFilter;
  initialPoolFilter?: PoolFilter;
  initialMinZec?: number;
  initialCursor?: string | null;
  initialCursorIdx?: number | null;
  initialCursorId?: number | null;
  initialDirection?: 'next' | 'prev';
  initialUnavailable?: boolean;
}

export default function TxsClient({
  initialTxs = [],
  initialFlows = [],
  initialPagination = null,
  initialPage = 1,
  initialType = 'all',
  initialFlowFilter = 'all',
  initialPoolFilter = 'all',
  initialMinZec = 0,
  initialCursor = null,
  initialCursorIdx = null,
  initialCursorId = null,
  initialDirection = 'next',
  initialUnavailable = false,
}: TxsClientProps) {
  const [typeFilter, setTypeFilter] = useState<TxType>(initialType);
  const [flowFilter, setFlowFilter] = useState<FlowFilter>(initialFlowFilter);
  const [poolFilter, setPoolFilter] = useState<PoolFilter>(initialPoolFilter);
  const [minZec, setMinZec] = useState<number>(initialMinZec);
  const [viewTab, setViewTab] = useState<ViewTab>('recent');

  const isShielded = typeFilter === 'shielded';

  // Summary stats — fetched once, covers both modes
  const [generalSummary, setGeneralSummary] = useState<{
    totalTxs: number | null;
    txs24h: number | null;
    shieldedPctToday: number | null;
    txsPerBlock: number | null;
  }>({ totalTxs: null, txs24h: null, shieldedPctToday: null, txsPerBlock: null });

  const [shieldedSummary, setShieldedSummary] = useState<{
    shieldedPct: number | null;
    avgPerDay: number | null;
    poolSize: string | null;
  }>({ shieldedPct: null, avgPerDay: null, poolSize: null });

  useEffect(() => {
    const base = getApiUrl();
    Promise.allSettled([
      fetch(`${base}/v1/network/stats`),
      fetch(`${base}/v1/privacy/stats`),
    ]).then(async ([networkRes, privacyRes]) => {
      let txs24h: number | null = null;
      let txsPerBlock: number | null = null;
      if (networkRes.status === 'fulfilled' && networkRes.value.ok) {
        const data = await readApiData(networkRes.value);
        ({ txs24h, txsPerBlock } = nonCoinbaseActivity(data.blockchain, data.mining));
      }
      let totalTxs: number | null = null;
      let shieldedPctToday: number | null = null;
      let avgPerDay: number | null = null;
      let poolSize: string | null = null;
      if (privacyRes.status === 'fulfilled' && privacyRes.value.ok) {
        const data = await readApiData(privacyRes.value);
        totalTxs = data.totals?.totalTx != null ? Number(data.totals.totalTx) : null;
        const today = new Date().toISOString().slice(0, 10);
        const dailyTrends = (data.trends?.daily || []).filter((row: { date: string }) => row.date.slice(0, 10) === today);
        if (dailyTrends.length > 0) {
          shieldedPctToday = dailyTrends[0].shieldedPercentage;
        }
        const pct = data.metrics?.shieldedPercentage != null ? Number(data.metrics.shieldedPercentage) : null;
        avgPerDay = data.metrics?.avgShieldedPerDay != null ? Math.round(Number(data.metrics.avgShieldedPerDay)) : null;
        const poolVal = data.shieldedPool?.currentSize;
        poolSize = poolVal != null
          ? Number(poolVal) >= 1_000_000
            ? `${(Number(poolVal) / 1_000_000).toFixed(2)}M ZEC`
            : `${Math.round(Number(poolVal)).toLocaleString()} ZEC`
          : null;
        setShieldedSummary({ shieldedPct: pct, avgPerDay, poolSize });
      }
      setGeneralSummary({ totalTxs, txs24h, shieldedPctToday, txsPerBlock });
    });
  }, []);

  // Pagination hooks — both always mounted (React rules)
  const txList = useTransactionsList({
    typeFilter: isShielded ? 'all' : typeFilter,
    initialTxs: isShielded ? [] : initialTxs,
    initialPagination: isShielded ? null : initialPagination,
    initialPage: isShielded ? 1 : initialPage,
    initialCursor: isShielded ? null : initialCursor,
    initialCursorIdx: isShielded ? null : initialCursorIdx,
    initialDirection: isShielded ? 'next' : initialDirection,
    initialUnavailable: isShielded ? false : initialUnavailable,
  });

  const shieldedList = useShieldedFlowsList({
    flowFilter,
    poolFilter,
    minZec,
    initialFlows: isShielded ? initialFlows : [],
    initialPagination: isShielded ? initialPagination : null,
    initialPage: isShielded ? initialPage : 1,
    initialCursor: isShielded ? initialCursor : null,
    initialCursorId: isShielded ? initialCursorId : null,
    initialDirection: isShielded ? initialDirection : 'next',
    initialUnavailable: isShielded ? initialUnavailable : false,
  });

  const activeList = isShielded ? shieldedList : txList;
  const activePage = activeList.page;

  // Reset sub-filters when leaving shielded mode
  const prevType = useRef(typeFilter);
  useEffect(() => {
    if (prevType.current === 'shielded' && typeFilter !== 'shielded') {
      setFlowFilter('all');
      setPoolFilter('all');
      setMinZec(0);
    }
    prevType.current = typeFilter;
  }, [typeFilter]);

  const viewTabs: { id: ViewTab; label: string }[] = [
    { id: 'recent', label: 'Recent Transactions' },
    { id: 'trends', label: 'Trends' },
  ];

  const pageTitle = activePage > 1
    ? `Zcash Transactions - Page ${activePage}`
    : 'Latest Zcash Transactions';

  const eyebrow = 'ALL_TRANSACTIONS';

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-12 animate-fade-in">
      <PageHeader
        eyebrow={eyebrow}
        title={pageTitle}
        actions={
          <span className="text-xs font-mono text-muted">
            {!activeList.dataAvailable
              ? 'Transaction data temporarily unavailable'
              : isShielded ? 'Public shielding flows and shielded activity' : 'Confirmed on-chain activity'}
          </span>
        }
      />

      {/* Metric Cards — switch based on mode */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {isShielded ? (
          <>
            <MetricCard size="compact"
              label="Matching transactions"
              value={activeList.dataAvailable ? activeList.pagination.total.toLocaleString() : '—'}
              hint="Current shielded filters"
            />
            <MetricCard size="compact"
              label="Shielded · all time"
              value={shieldedSummary.shieldedPct != null ? `${shieldedSummary.shieldedPct.toFixed(1)}%` : '—'}
              hint="Of non-coinbase txs"
            />
            <MetricCard size="compact"
              label="Avg Shielded / Day"
              value={shieldedSummary.avgPerDay != null ? shieldedSummary.avgPerDay.toLocaleString() : '—'}
              hint="Last 30 days"
            />
            <MetricCard size="compact"
              label="Shielded Pool"
              value={shieldedSummary.poolSize ?? '—'}
              hint="Current pool balance"
            />
          </>
        ) : (
          <>
            <MetricCard size="compact"
              label="Total Transactions"
              value={generalSummary.totalTxs != null ? generalSummary.totalTxs.toLocaleString() : '—'}
              hint="All time · includes coinbase"
            />
            <MetricCard size="compact"
              label="Transactions (24h)"
              value={generalSummary.txs24h != null ? generalSummary.txs24h.toLocaleString() : '—'}
              hint="Excluding coinbase"
            />
            <MetricCard size="compact"
              label="Shielded · today (UTC)"
              value={generalSummary.shieldedPctToday != null ? `${generalSummary.shieldedPctToday.toFixed(1)}%` : '—'}
              hint="Of non-coinbase txs"
            />
            <MetricCard size="compact"
              label="Txs Per Block · 24h"
              value={generalSummary.txsPerBlock != null ? generalSummary.txsPerBlock.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—'}
              hint="Coinbase not counted"
            />
          </>
        )}
      </div>

      {/* View Tabs + Type Filter */}
      <Tabs tabs={viewTabs} active={viewTab} onChange={setViewTab} className="mb-4">
        {viewTab === 'recent' && (
          <FilterGroup inline>
            {TYPE_FILTERS.map(f => (
              <FilterButton key={f.id} active={typeFilter === f.id} onClick={() => setTypeFilter(f.id)}>
                {f.label}
              </FilterButton>
            ))}
          </FilterGroup>
        )}
      </Tabs>

      {/* Shielded Sub-filters — progressive disclosure */}
      {viewTab === 'recent' && isShielded && (
        <div className="flex flex-wrap gap-3 mb-4 animate-fade-in-up">
          <FilterGroup inline>
            {FLOW_FILTERS.map(f => (
              <FilterButton key={f.id} active={flowFilter === f.id} onClick={() => setFlowFilter(f.id)}>
                {f.label}
              </FilterButton>
            ))}
          </FilterGroup>
          <FilterGroup inline>
            {POOL_FILTERS.map(f => (
              <FilterButton key={f.id} active={poolFilter === f.id} onClick={() => setPoolFilter(f.id)}>
                {f.label}
              </FilterButton>
            ))}
          </FilterGroup>
          <FilterGroup inline>
            {AMOUNT_PRESETS.map(p => (
              <FilterButton key={p.value} active={minZec === p.value} onClick={() => setMinZec(p.value)}>
                {p.label}
              </FilterButton>
            ))}
          </FilterGroup>
        </div>
      )}

      {isShielded && shieldedList.flows[0]?.blockTime != null && (
        <p className="mb-3 text-xs text-muted">
          Newest transaction in this view: {formatDateUTC(Number(shieldedList.flows[0].blockTime))}. Indexed observations can lag the chain tip.
        </p>
      )}

      {/* Data Table */}
      {viewTab === 'recent' && (
        <>
          {isShielded ? (
            <DataTable
              columns={shieldedColumns}
              rows={shieldedList.flows}
              rowKey={(flow) => `${flow.txid}-${flow.flowType}-${flow.id}`}
              loading={shieldedList.loading}
            />
          ) : (
            <DataTable
              columns={txColumns}
              rows={txList.txs}
              rowKey={(tx) => tx.txid}
              loading={txList.loading}
            />
          )}

          <Pagination
            page={activeList.page}
            totalPages={activeList.pagination.totalPages}
            hasNext={activeList.pagination.hasNext}
            hasPrev={activeList.pagination.hasPrev}
            firstHref={activeList.firstHref}
            prevHref={activeList.prevHref}
            nextHref={activeList.nextHref}
            loading={activeList.loading}
          />
        </>
      )}

      {viewTab === 'trends' && <TrendsChart />}
    </div>
  );
}
