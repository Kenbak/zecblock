'use client';
import { MiningSoftwareSection } from '@/components/mining/MiningSoftwareSection';
import { OrphanRateSection } from '@/components/mining/OrphanRateSection';
import { readApiData } from '@/lib/api-client';
import { ChartWatermark } from '@/components/ChartWatermark';
import { ChartSkeleton } from '@/components/ui/Skeleton';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AreaChart, Area, BarChart, Bar,
  LineChart, Line,
  XAxis, YAxis, CartesianGrid, ResponsiveContainer, Legend,
} from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { getApiUrl } from '@/lib/api-config';
import { useTheme } from '@/contexts/ThemeContext';
import { categoryColor } from '@/lib/category-colors';
import { getChartColors } from '@/lib/chart-theme';
import { Card, CardBody } from '@/components/ui/Card';
import { PageHeader, SectionHeader, DataTable, SkeletonTable } from '@/components/ui';
import { ChartCard } from '@/components/network/ChartCard';
import { PageSectionNav } from '@/components/PageSectionNav';
import { MiningMetricsChart } from '@/components/network/MiningMetricsChart';
import { NetworkHashrateChart } from '@/components/network/NetworkHashrateChart';
import { zatToZec } from '@/lib/format-numbers';

const SECTIONS = [
  { id: 'metrics', label: 'Network' },
  { id: 'orphans', label: 'Orphan rates' },
  { id: 'distribution', label: 'Distribution' },
  { id: 'ranking', label: 'Ranking' },
  { id: 'software', label: 'Mining software' },
  { id: 'hashrate', label: 'Share history' },
  { id: 'economics', label: 'Block economics' },
  { id: 'behavior', label: 'Reward spending' },
  { id: 'methodology', label: 'Methodology' },
] as const;

const PERIODS = ['24h', '3d', '7d', '30d', '90d', '1y', 'all'] as const;
type Period = typeof PERIODS[number];



interface PoolDist {
  address: string;
  name: string;
  blocks: number;
  share: number;
  totalFeesZat: string;
}

interface PoolRank {
  rank: number;
  address: string;
  name: string;
  url: string | null;
  region: string | null;
  blocks: number;
  share: number;
  totalFeesZat: string;
  avgBlockInterval: number | null;
}

interface HashratePoint {
  date: string;
  totalBlocks: number;
  pools: Record<string, number>;
}

interface BehaviorPoint {
  date: string;
  earnedZat: string;
  spentZat: string;
  heldZat: string;
  sellRatio: number;
}

interface BehaviorSummary {
  totalEarnedZat: string;
  totalSpentZat: string;
  totalHeldZat: string;
  overallSellRatio: number;
}

function formatZec(zatStr: string | number): string {
  const zat = typeof zatStr === 'string' ? parseInt(zatStr) : zatStr;
  if (isNaN(zat)) return '0';
  const zec = zatToZec(zat);
  if (zec >= 1000) return `${(zec / 1000).toFixed(1)}K`;
  if (zec >= 1) return zec.toFixed(2);
  return zec.toFixed(4);
}

function formatPct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function PeriodSelector({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <div className="inline-flex gap-0 p-0.5 rounded-md bg-glass-3 flex-shrink-0">
      {PERIODS.map(p => (
        <button
          key={p}
          aria-pressed={value === p}
          onClick={() => onChange(p)}
          className={`px-1.5 py-0.5 text-caption font-mono rounded transition whitespace-nowrap ${
            value === p
              ? 'bg-brand-gold/15 text-cipher-gold font-semibold'
              : 'text-muted hover:text-primary'
          }`}
        >
          {p.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function DistributionSection() {
  const { theme } = useTheme();
  const [period, setPeriod] = useState<Period>('7d');
  const [data, setData] = useState<PoolDist[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`${getApiUrl()}/v1/mining/pool-distribution?period=${period}`)
      .then(r => r.ok ? readApiData(r) : null)
      .then(res => {
        if (res?.pools) {
          setData(res.pools);
          setTotal(res.totalBlocks);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [period]);

  // Group small shares into Other; the full ranking remains available below.
  const threshold = 0.02;
  const mainPools = data.filter(p => p.share >= threshold);
  const otherBlocks = data.filter(p => p.share < threshold).reduce((s, p) => s + p.blocks, 0);
  const distributionData = [
    ...mainPools.map(p => ({ name: p.name, value: p.blocks })),
    ...(otherBlocks > 0 ? [{ name: 'Other', value: otherBlocks }] : []),
  ];

  return (
    <section id="distribution" className="scroll-mt-36 mb-12 animate-fade-in-up stagger-2">
      <Card><CardBody>
        <SectionHeader label="MINING_POOL_DISTRIBUTION" actions={<PeriodSelector value={period} onChange={setPeriod} />} />
        {loading ? (
          <ChartSkeleton height={360} />
        ) : (
          <div>
            <p className="text-xs text-muted mb-6">Share of {total.toLocaleString()} observed blocks in {period}, attributed by coinbase payout. Small pools are grouped as Other.</p>
            {distributionData.length === 0 ? <p className="py-12 text-xs text-muted">No pool observations available.</p> : <div className="space-y-5">{distributionData.map(p => <div key={p.name}>
              <div className="flex items-baseline justify-between gap-4 mb-2"><span className="text-xs font-mono text-primary truncate">{p.name}</span><span className="text-xs font-mono text-secondary shrink-0">{total>0?(p.value/total*100).toFixed(1):0}% <span className="text-muted ml-3">{p.value.toLocaleString()} blocks</span></span></div>
              <div className="h-2 rounded-full bg-cipher-hover overflow-hidden"><div className="h-full rounded-full" style={{width:`${total>0?p.value/total*100:0}%`,backgroundColor:categoryColor(p.name,theme)}} /></div>
            </div>)}</div>}
          </div>
        )}
      <ChartWatermark /></CardBody></Card>
    </section>
  );
}

function RankingSection() {
  const { theme } = useTheme();
  const [period, setPeriod] = useState<Period>('7d');
  const [ranking, setRanking] = useState<PoolRank[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`${getApiUrl()}/v1/mining/pool-ranking?period=${period}`)
      .then(r => r.ok ? readApiData(r) : null)
      .then(res => {
        if (res?.ranking) {
          setRanking(res.ranking);
          setTotal(res.totalBlocks);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [period]);

  return (
    <section id="ranking" className="scroll-mt-36 mb-12 animate-fade-in-up stagger-3">
      <Card>
        <CardBody>
          <SectionHeader label="POOL_RANKING" actions={<PeriodSelector value={period} onChange={setPeriod} />} />

          {loading ? (
            <SkeletonTable rows={5} headers={["#", "Pool", "Blocks", "Share", "Avg interval", "Total fees"]} />
          ) : (
            <>
              <DataTable
                bare
                columns={[
                  {
                    id: 'rank',
                    header: '#',
                    cell: (pool: PoolRank) => <span className="font-mono text-xs text-muted">{pool.rank}</span>,
                  },
                  {
                    id: 'pool',
                    header: 'Pool',
                    cell: (pool) => (
                      <div className="flex items-center gap-2">
                        <div
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: categoryColor(pool.name, theme) }}
                        />
                        <span className="font-mono text-xs text-primary font-medium">{pool.name}</span>
                        {pool.region && (
                          <span className="text-caption font-mono text-muted px-1 py-0.5 bg-glass-3 rounded">{pool.region}</span>
                        )}
                      </div>
                    ),
                  },
                  {
                    id: 'blocks',
                    header: 'Blocks',
                    align: 'right',
                    cell: (pool) => (
                      <span className="font-mono text-xs tabular-nums text-primary">{pool.blocks.toLocaleString()}</span>
                    ),
                  },
                  {
                    id: 'share',
                    header: 'Share',
                    align: 'right',
                    cell: (pool) => (
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 h-1.5 bg-glass-3 rounded-full overflow-hidden hidden sm:block">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.min(pool.share * 100, 100)}%`,
                              backgroundColor: categoryColor(pool.name, theme),
                            }}
                          />
                        </div>
                        <span className="font-mono text-xs tabular-nums text-primary">{formatPct(pool.share)}</span>
                      </div>
                    ),
                  },
                  {
                    id: 'interval',
                    header: 'Avg Interval',
                    align: 'right',
                    className: 'hidden sm:table-cell',
                    cell: (pool) => (
                      <span className="font-mono text-xs tabular-nums text-muted">
                        {pool.avgBlockInterval ? `${Math.round(pool.avgBlockInterval)}s` : '—'}
                      </span>
                    ),
                  },
                  {
                    id: 'fees',
                    header: 'Total Fees',
                    align: 'right',
                    className: 'hidden md:table-cell',
                    cell: (pool) => (
                      <span className="font-mono text-xs tabular-nums text-muted">{formatZec(pool.totalFeesZat)} ZEC</span>
                    ),
                  },
                ]}
                rows={ranking}
                rowKey={(pool) => pool.address}
              />
              <p className="text-caption text-muted font-mono mt-3">
                {total.toLocaleString()} total blocks in {period}
              </p>
            </>
          )}
        </CardBody>
      </Card>
    </section>
  );
}

type ChartMode = 'line' | 'area';

function ChartModeToggle({ mode, onChange }: { mode: ChartMode; onChange: (m: ChartMode) => void }) {
  return (
    <div className="flex items-center gap-1 bg-glass-3 rounded-md p-0.5">
      <button
        onClick={() => onChange('line')}
        className={`px-2.5 py-1 rounded text-caption font-mono uppercase tracking-wider transition ${
          mode === 'line'
            ? 'bg-cipher-elevated text-primary font-semibold'
            : 'text-muted hover:text-secondary'
        }`}
      >
        Line
      </button>
      <button
        onClick={() => onChange('area')}
        className={`px-2.5 py-1 rounded text-caption font-mono uppercase tracking-wider transition ${
          mode === 'area'
            ? 'bg-cipher-elevated text-primary font-semibold'
            : 'text-muted hover:text-secondary'
        }`}
      >
        Area
      </button>
    </div>
  );
}

function HashrateShareSection() {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const [period, setPeriod] = useState<Period>('all');
  const [chartMode, setChartMode] = useState<ChartMode>('line');
  const [series, setSeries] = useState<HashratePoint[]>([]);
  const [allPools, setAllPools] = useState<string[]>([]);
  const [hiddenPools, setHiddenPools] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`${getApiUrl()}/v1/mining/hashrate-share?period=${period}`)
      .then(r => r.ok ? readApiData(r) : null)
      .then(res => {
        if (res?.series) {
          setSeries(res.series);
          setAllPools(res.allPools || []);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [period]);

  const poolOrder = [...allPools].sort((a, b) => {
    const aTotal = series.reduce((s, p) => s + (p.pools[a] || 0), 0);
    const bTotal = series.reduce((s, p) => s + (p.pools[b] || 0), 0);
    return bTotal - aTotal;
  });

  const visiblePools = poolOrder.filter(p => !hiddenPools.has(p));

  const chartData = series.map(point => {
    const entry: Record<string, string | number> = { date: point.date };
    for (const pool of poolOrder) {
      entry[pool] = ((point.pools[pool] || 0) * 100);
    }
    return entry;
  });

  const togglePool = (pool: string) => {
    setHiddenPools(prev => {
      const next = new Set(prev);
      if (next.has(pool)) next.delete(pool);
      else next.add(pool);
      return next;
    });
  };

  const chartControls = (
    <div className="flex items-center gap-1.5 flex-wrap justify-end">
      <ChartModeToggle mode={chartMode} onChange={setChartMode} />
      <PeriodSelector value={period} onChange={setPeriod} />
    </div>
  );

  const cursorStyle = { fill: 'rgba(255,255,255,0.03)', stroke: 'rgba(255,255,255,0.1)' };

  return (
    <section id="hashrate" className="scroll-mt-36 mb-12 animate-fade-in-up stagger-4">
      <ChartCard
        title="POOL_NETWORK_BLOCK_SHARE"
        height={380}
        controls={chartControls}
      >
        {loading ? (
          <ChartSkeleton height={380} />
        ) : chartMode === 'area' ? (
          <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={380}>
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="2 6" stroke={colors.grid} opacity={0.5} />
              <XAxis
                dataKey="date"
                stroke={colors.axis}
                tick={{ fill: colors.axis, fontSize: 12 }}
                tickFormatter={(d: string) => {
                  const date = new Date(d);
                  return `${date.getMonth() + 1}/${date.getDate()}`;
                }}
              />
              <YAxis
                stroke={colors.axis}
                tick={{ fill: colors.axis, fontSize: 12 }}
                tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                domain={[0, 100]}
              />
              <Tooltip
                itemSorter={(item) => -Number(item.value)}
                cursor={cursorStyle}
                contentStyle={{
                  backgroundColor: colors.tooltipBg,
                  border: `1px solid ${colors.tooltipBorder}`,
                  borderRadius: 8,
                  fontSize: 12,
                  fontFamily: 'var(--font-geist-mono), monospace',
                }}
                itemStyle={{ color: colors.tooltipText }}
                labelStyle={{ color: colors.tooltipText, marginBottom: 4 }}
                formatter={(value, name) => [`${Number(value).toFixed(1)}%`, name]}
                labelFormatter={(label) => String(label)}
              />
              {visiblePools.map((pool) => {
                return (
                  <Area
                    key={pool}
                    type="monotone"
                    dataKey={pool}
                    stackId="1"
                    fill={categoryColor(pool, theme)}
                    stroke={categoryColor(pool, theme)}
                    fillOpacity={0.7}
                  />
                );
              })}
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={380}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="2 6" stroke={colors.grid} opacity={0.5} />
              <XAxis
                dataKey="date"
                stroke={colors.axis}
                tick={{ fill: colors.axis, fontSize: 12 }}
                tickFormatter={(d: string) => {
                  const date = new Date(d);
                  return `${date.getMonth() + 1}/${date.getDate()}`;
                }}
              />
              <YAxis
                stroke={colors.axis}
                tick={{ fill: colors.axis, fontSize: 12 }}
                tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                domain={[0, 'auto']}
              />
              <Tooltip
                itemSorter={(item) => -Number(item.value)}
                cursor={cursorStyle}
                contentStyle={{
                  backgroundColor: colors.tooltipBg,
                  border: `1px solid ${colors.tooltipBorder}`,
                  borderRadius: 8,
                  fontSize: 12,
                  fontFamily: 'var(--font-geist-mono), monospace',
                }}
                itemStyle={{ color: colors.tooltipText }}
                labelStyle={{ color: colors.tooltipText, marginBottom: 4 }}
                formatter={(value, name) => [`${Number(value).toFixed(1)}%`, name]}
                labelFormatter={(label) => String(label)}
              />
              {visiblePools.map((pool) => {
                return (
                  <Line
                    key={pool}
                    type="monotone"
                    dataKey={pool}
                    stroke={categoryColor(pool, theme)}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 3 }}
                  />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
        )}

        {/* Clickable legend */}
        <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-4 px-1">
          {poolOrder.map((pool) => {
            const isHidden = hiddenPools.has(pool);
            return (
              <button
                key={pool}
                onClick={() => togglePool(pool)}
                className={`flex items-center gap-1.5 text-caption font-mono transition-opacity ${
                  isHidden ? 'opacity-30' : 'opacity-100'
                } hover:opacity-80`}
              >
                <span
                  className="w-3 h-[3px] rounded-full inline-block"
                  style={{
                    backgroundColor: categoryColor(pool, theme),
                    opacity: isHidden ? 0.3 : 1,
                  }}
                />
                <span className={isHidden ? 'text-muted line-through' : 'text-secondary'}>
                  {pool}
                </span>
              </button>
            );
          })}
        </div>
      </ChartCard>
    </section>
  );
}

function MinerBehaviorSection() {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const [period, setPeriod] = useState<Period>('all');
  const [series, setSeries] = useState<BehaviorPoint[]>([]);
  const [summary, setSummary] = useState<BehaviorSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`${getApiUrl()}/v1/mining/miner-behavior?period=${period}`)
      .then(r => r.ok ? readApiData(r) : null)
      .then(res => {
        if (res) {
          setSeries(res.series || []);
          setSummary(res.summary || null);
          setMessage(res.message || null);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [period]);

  const chartData = series.map(p => ({
    date: p.date,
    earned: zatToZec(parseInt(p.earnedZat)),
    spent: zatToZec(parseInt(p.spentZat)),
    held: zatToZec(parseInt(p.heldZat)),
    sellRatio: p.sellRatio * 100,
  }));

  return (
    <section id="behavior" className="scroll-mt-36 mb-12 animate-fade-in-up stagger-5">
      <div className="mb-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted font-mono uppercase tracking-widest opacity-50">{'>'}</span>
            <h2 className="text-lg font-semibold font-sans text-primary">Miner Behavior</h2>
          </div>
          <Link
            href="/zodl"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cipher-border bg-glass-3 text-caption font-mono text-secondary hover:text-primary hover:border-cipher-yellow/40 transition"
          >
            ZODL leaderboard
            <span className="opacity-60">→</span>
          </Link>
        </div>
        <p className="text-xs text-secondary mt-1 font-sans">
          How much of their block rewards miners move vs leave unspent. A high moved ratio means rewards changed address
          quickly; it does not prove they were sold. The{' '}
          <Link href="/zodl" className="text-cipher-gold hover:underline">ZODL leaderboard</Link> breaks each pool&apos;s spending down by destination (shielded vs. exchange vs. transparent), showing observed transfers rather than proving sales.
        </p>
      </div>

      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <Card>
            <CardBody className="py-3">
              <p className="text-caption font-mono text-muted uppercase mb-1">Total Earned</p>
              <p className="text-lg font-semibold font-mono tabular-nums text-primary">
                {formatZec(summary.totalEarnedZat)} ZEC
              </p>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="py-3">
              <p className="text-caption font-mono text-muted uppercase mb-1">Total Moved</p>
              <p className="text-lg font-semibold font-mono tabular-nums text-cipher-orange">
                {formatZec(summary.totalSpentZat)} ZEC
              </p>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="py-3">
              <p className="text-caption font-mono text-muted uppercase mb-1">Still Held</p>
              <p className="text-lg font-semibold font-mono tabular-nums text-cipher-green">
                {formatZec(summary.totalHeldZat)} ZEC
              </p>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="py-3">
              <p className="text-caption font-mono text-muted uppercase mb-1">Sell Ratio</p>
              <p className="text-lg font-semibold font-mono tabular-nums text-primary">
                {(summary.overallSellRatio * 100).toFixed(1)}%
              </p>
            </CardBody>
          </Card>
        </div>
      )}

      <ChartCard
        title="MINER_EARNED_VS_MOVED"
        height={320}
        controls={<PeriodSelector value={period} onChange={setPeriod} />}
      >
        {loading ? (
          <ChartSkeleton height={320} />
        ) : message ? (
          <div className="flex items-center justify-center h-[320px]">
            <div className="text-center">
              <p className="text-sm text-muted font-mono">{message}</p>
              <p className="text-caption text-muted mt-2">Run the snapshot job to populate this data.</p>
            </div>
          </div>
        ) : (
          <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={320}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="2 6" stroke={colors.grid} opacity={0.5} />
              <XAxis
                dataKey="date"
                stroke={colors.axis}
                tick={{ fill: colors.axis, fontSize: 12 }}
                tickFormatter={(d: string) => {
                  const date = new Date(d);
                  return `${date.getMonth() + 1}/${date.getDate()}`;
                }}
              />
              <YAxis
                stroke={colors.axis}
                tick={{ fill: colors.axis, fontSize: 12 }}
                tickFormatter={(v: number) => `${v.toFixed(0)}`}
                label={{ value: 'ZEC', angle: -90, position: 'insideLeft', fill: colors.axis, fontSize: 12 }}
              />
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                contentStyle={{
                  backgroundColor: colors.tooltipBg,
                  border: `1px solid ${colors.tooltipBorder}`,
                  borderRadius: 8,
                  fontSize: 12,
                  fontFamily: 'var(--font-geist-mono), monospace',
                }}
                itemStyle={{ color: colors.tooltipText }}
                labelStyle={{ color: colors.tooltipText, marginBottom: 4 }}
                formatter={(value, name) => {
                  const label = name === 'earned' ? 'Earned' : name === 'spent' ? 'Moved/Sold' : 'Held';
                  return [`${Number(value).toFixed(2)} ZEC`, label];
                }}
                labelFormatter={(label) => String(label)}
              />
              <Legend
                wrapperStyle={{ fontSize: 12, fontFamily: 'var(--font-geist-mono), monospace' }}
                formatter={(value) => value === 'earned' ? 'Earned' : value === 'spent' ? 'Moved/Sold' : 'Held'}
              />
              <Bar dataKey="earned" fill={colors.gold} fillOpacity={0.3} stroke={colors.gold} />
              <Bar dataKey="spent" fill={colors.deshielding} fillOpacity={0.7} />
              <Bar dataKey="held" fill={colors.orchard} fillOpacity={0.7} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </section>
  );
}

export default function MiningPage() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12 overflow-x-hidden">
      <PageHeader
        eyebrow="MINING"
        title="Zcash Mining"
        subtitle="Hashrate, observed orphan rates, block economics, pool distribution, software markers, and miner behavior."
      />

      <PageSectionNav sections={SECTIONS} ariaLabel="Mining pool sections" />

      <section id="metrics" className="scroll-mt-36 mb-12 animate-fade-in-up space-y-6">
        <NetworkHashrateChart />
      </section>

      <OrphanRateSection />
      <DistributionSection />
      <RankingSection />
      <MiningSoftwareSection />
      <HashrateShareSection />
      <section id="economics" className="scroll-mt-36 mb-12"><MiningMetricsChart /></section>
      <MinerBehaviorSection />

      <section id="methodology" className="scroll-mt-36 mb-8">
        <details className="group rounded-lg border border-cipher-border overflow-hidden"><summary className="list-none p-5 sm:p-6 cursor-pointer hover:bg-glass-3 text-sm font-mono flex justify-between">Mining data &amp; attribution<span aria-hidden="true" className="group-open:rotate-90">›</span></summary><div className="p-5 sm:p-6 border-t border-cipher-border">
          <h2 className="text-sm font-semibold font-mono text-secondary mb-3 lowercase tracking-tight">
            About Mining Pool Data
          </h2>
          <div className="space-y-3 text-sm text-muted leading-relaxed">
            <p>
              Zcash is secured by Equihash proof-of-work mining with a block target set by the active network upgrade.
              Pool attribution uses corroborated coinbase payout addresses and recognized public
              pool tags, cross-checked against ZecMiningPool’s network feed. A pool may use
              multiple addresses or a shielded payout. Software markers do not establish pool
              identity, and unidentified miners remain unattributed.
            </p>
            <p>
              Miner behavior tracks transparent coinbase outputs paid to the tracked miner address.
              Shielded rewards and outputs to other payout addresses are outside this measure.
              It records whether those tracked outputs have been spent or remain unspent.
              This is a moved-versus-unspent measure; destination analysis
              is required before describing a movement as shielding, exchange transfer, or sale.
            </p>
          </div>
        </div></details>
      </section>
      <nav aria-label="Related mining analysis" className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">{[{href:'/network#issuance',title:'Issuance & halving',text:'Block subsidy and the remaining schedule.'},{href:'/zodl',title:'Miner reward destinations',text:'Observe the first move of mined rewards.'},{href:'/reorgs',title:'Forks & orphaned blocks',text:'Inspect observed reorgs and competing blocks.'},{href:'/network/nodes',title:'Node explorer',text:'Reachability, clients and geographic coverage.'}].map(l=><Link key={l.href} href={l.href} className="border border-cipher-border rounded-lg p-4 hover:bg-glass-3"><span className="text-sm font-mono">{l.title} →</span><span className="block mt-2 text-xs text-muted">{l.text}</span></Link>)}</nav>
    </div>
  );
}
