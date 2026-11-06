'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { zatToZec } from '@/lib/format-numbers';
import { poolDateAxis } from '@/lib/pool-display';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useUrlState } from '@/lib/use-url-state';
import { ShareableCard } from '@/components/ShareableCard';
import { ChartSkeleton } from '@/components/ui/Skeleton';
import { PoolCurrencyNote, usePoolCurrency } from './PoolCurrency';
import type { HistoryPoint } from './supply-history';
import { buildTopLevelSegments, MAX_SUPPLY_ZAT, SHIELDED_POOL_KEYS, type ShieldedPoolKey } from './supply-treemap-layout';
import type { PoolOverviewData } from './PoolOverviewHero';
import { isMainnet } from '@/lib/config';

type Range = '30d' | '90d' | '1y' | 'all';
type Metric = 'total' | 'pools' | 'public' | 'share';

const RANGES: Range[] = ['30d', '90d', '1y', 'all'];
const METRICS: { key: Metric; label: string }[] = [
  { key: 'total', label: 'Total' },
  { key: 'pools', label: 'By pool' },
  { key: 'public', label: 'vs public' },
  { key: 'share', label: '% shielded' },
];
const POOL_LABEL: Record<ShieldedPoolKey, string> = { sprout: 'Sprout', sapling: 'Sapling', orchard: 'Orchard', ironwood: 'Ironwood' };
const POOL_ORDER: ShieldedPoolKey[] = [...SHIELDED_POOL_KEYS].reverse();
const CHART_HEIGHT = 280;

interface Point extends HistoryPoint { shieldedSupplyPct: number | null }

function fullDate(value: string, time = false) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Date unavailable';
  return date.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    ...(time ? { hour: '2-digit', minute: '2-digit' } as const : {}),
  }) + (time ? ' UTC' : '');
}

/** Reports the hovered x value; the page headline is the tooltip. */
function ScrubReporter({ active, label, onScrub }: { active?: boolean; label?: number | string; onScrub: (t: number | null) => void }) {
  const t = active && label != null ? Number(label) : null;
  useEffect(() => { onScrub(Number.isFinite(t) ? t : null); }, [t, onScrub]);
  return null;
}

function Pill({ active, onClick, children, label, disabled }: { active: boolean; onClick: () => void; children: React.ReactNode; label?: string; disabled?: boolean }) {
  return <button type="button" aria-pressed={active} title={label} disabled={disabled} onClick={onClick}
    className={`h-7 rounded-full px-3 text-caption font-mono transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold disabled:cursor-not-allowed disabled:opacity-40 ${active ? 'bg-glass-6 text-primary' : 'text-muted hover:text-primary'}`}>
    {children}
  </button>;
}

function PillGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return <div role="group" aria-label={label} className="inline-flex items-center rounded-full border border-cipher-border p-0.5">{children}</div>;
}

export function ShieldedSupplyHero({ data }: { data: PoolOverviewData }) {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const { currency, setCurrency, price, format } = usePoolCurrency();
  const [range, setRange] = useUrlState<Range>('range', 'all', RANGES);
  const [metric, setMetric] = useState<Metric>('total');
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [focusPool, setFocusPool] = useState<ShieldedPoolKey | null>(null);
  const [chartWidth, setChartWidth] = useState(800);

  const { data: historyRes, loading, error } = useApiQuery<{ points: Point[] }>('/v1/shielded-pools/history', { period: range }, { refreshInterval: 300_000 });
  const points = useMemo(() => (historyRes?.points ?? []).filter(p => Number.isFinite(p.shielded) && Number.isFinite(Date.parse(p.date)))
    .map(p => ({ ...p, t: Date.parse(p.date) })), [historyRes]);
  const axis = useMemo(() => poolDateAxis(points.map(p => p.date), chartWidth - 80), [points, chartWidth]);

  const scrubbed = activeIndex != null ? points[activeIndex] : null;
  const current = data.current;
  const live = {
    shielded: zatToZec(current.shielded),
    chainSupply: zatToZec(current.chainSupply),
    sprout: zatToZec(current.sprout), sapling: zatToZec(current.sapling),
    orchard: zatToZec(current.orchard), ironwood: zatToZec(current.ironwood),
  };
  // Pool rows follow the scrubbed day only when that snapshot has a verified pool breakdown.
  const poolSource = scrubbed?.hasPoolBreakdown ? scrubbed : live;
  const shielded = scrubbed ? scrubbed.shielded : live.shielded;
  const share = scrubbed
    ? scrubbed.shieldedSupplyPct
    : live.chainSupply > 0 ? live.shielded / live.chainSupply * 100 : null;
  const weekDelta = data.deltas.shielded?.['7d'];
  const usdBlocked = currency === 'usd' && price == null;

  const headline = metric === 'share'
    ? share == null ? '—' : `${share.toFixed(2)}%`
    : usdBlocked ? '—'
    : currency === 'usd'
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(shielded * price!)
      : Math.round(shielded).toLocaleString('en-US');

  const topLevel = buildTopLevelSegments({
    transparent: current.transparent, shielded: current.shielded, chainSupply: current.chainSupply,
    colors: { transparent: colors.transparent, shielded: colors.shielded, unmined: colors.transparent },
  });

  const indexByTime = useMemo(() => new Map(points.map((p, i) => [p.t, i])), [points]);
  const onScrub = useCallback((t: number | null) => {
    const index = t == null ? undefined : indexByTime.get(t);
    setActiveIndex(index ?? null);
  }, [indexByTime]);


  const yFormat = (v: number) => metric === 'share' ? `${v}%` : format(v, false);
  const shareText = `${share == null ? '—' : share.toFixed(1) + '%'} of issued ZEC is shielded — ${Math.round(live.shielded).toLocaleString('en-US')} ZEC.\n\nhttps://zecblock.com/pools`;

  const card = 'rounded-xl border border-cipher-border bg-cipher-surface p-4 sm:p-6';
  const cardTitle = 'text-sm font-semibold leading-snug text-primary';

  return <div className="space-y-4">
    <ShareableCard title="Shielded supply" className="" sharePath="/pools" shareText={shareText} fileName="zecblock-shielded-supply.png"
      footerNote={scrubbed ? `Daily snapshot · ${fullDate(scrubbed.date)}` : `Latest snapshot · ${fullDate(current.updatedAt, true)}`}>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="flex items-baseline gap-2 font-light tabular-nums text-primary" aria-live="polite">
            <span className="text-4xl sm:text-6xl tracking-tight">{headline}</span>
            {metric !== 'share' && currency === 'zec' && <span className="text-lg sm:text-xl text-muted">ZEC</span>}
          </p>
          <p className="mt-2 min-h-5 text-xs font-mono text-muted">
            {scrubbed ? <><span className="text-secondary">{fullDate(scrubbed.date)}</span>{metric !== 'share' && share != null && <><span className="mx-2 opacity-40">·</span><span className="text-cipher-gold">{share.toFixed(1)}%</span> of issued ZEC</>}</> : <>
              {metric === 'share'
                ? <span>{format(live.shielded)} in shielded pools</span>
                : <span><span className="text-cipher-gold">{share == null ? '—' : `${share.toFixed(1)}%`}</span> of issued ZEC</span>}
              {weekDelta != null && Number.isFinite(weekDelta) && <>
                <span className="mx-2 opacity-40">·</span>
                <span className={weekDelta >= 0 ? 'text-cipher-green' : 'text-cipher-orange'}>{weekDelta >= 0 && !usdBlocked ? '+' : ''}{format(zatToZec(weekDelta))}</span> this week
              </>}
            </>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2" data-html2canvas-ignore="true">
          <PillGroup label="Chart metric">{METRICS.map(m => <Pill key={m.key} active={metric === m.key} onClick={() => setMetric(m.key)}>{m.label}</Pill>)}</PillGroup>
          <PillGroup label="Time range">{RANGES.map(r => <Pill key={r} active={range === r} onClick={() => { setRange(r); setActiveIndex(null); }}>{r === 'all' ? 'All' : r.toUpperCase()}</Pill>)}</PillGroup>
          {isMainnet && <PillGroup label="Currency">{(['zec', 'usd'] as const).map(c => <Pill key={c} active={currency === c} disabled={c === 'usd' && price == null && currency !== 'usd'}
            label={c === 'usd' ? price == null ? 'A fresh ZEC price is currently unavailable' : 'Value balances at the current ZEC price' : 'Balances in ZEC'}
            onClick={() => setCurrency(c)}>{c.toUpperCase()}</Pill>)}</PillGroup>}
        </div>
      </div>

      <div className="mt-6 [&_.recharts-surface]:outline-none [&_.recharts-wrapper]:outline-none" onMouseLeave={() => setActiveIndex(null)}>
        {loading && !points.length ? <ChartSkeleton height={CHART_HEIGHT} />
          : !points.length ? <p className="flex items-center justify-center text-xs font-mono text-muted" style={{ height: CHART_HEIGHT }} role="status">{error ? 'Supply history is temporarily unavailable.' : 'No supply history for this range.'}</p>
          : usdBlocked && metric !== 'share' ? <p className="flex items-center justify-center text-xs font-mono text-muted" style={{ height: CHART_HEIGHT }} role="status">A fresh quote is needed to display USD. Switch to ZEC.</p>
          : <ResponsiveContainer width="100%" height={CHART_HEIGHT} initialDimension={{ width: 800, height: CHART_HEIGHT }} onResize={w => setChartWidth(w)}>
            <AreaChart data={points} margin={{ top: 8, right: 0, bottom: 0, left: 0 }} onMouseLeave={() => setActiveIndex(null)}>
              <defs>
                <linearGradient id="shieldedFade" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={colors.shielded} stopOpacity={0.2} />
                  <stop offset="100%" stopColor={colors.shielded} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke={colors.grid} strokeDasharray="2 6" opacity={0.5} />
              <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={axis.ticks} tickFormatter={axis.format}
                tickLine={false} axisLine={false} tick={{ fill: colors.axis, fontSize: 12 }} minTickGap={32} interval="preserveStartEnd" />
              <YAxis orientation="right" width={56} tickLine={false} axisLine={false} tick={{ fill: colors.axis, fontSize: 12 }} tickCount={4}
                tickFormatter={yFormat} domain={metric === 'share' ? ['auto', 'auto'] : [0, 'auto']} />
              <Tooltip content={<ScrubReporter onScrub={onScrub} />} cursor={{ stroke: colors.axis, strokeWidth: 1, strokeDasharray: '2 4' }} isAnimationActive={false} />
              {metric === 'total' && <Area type="monotone" dataKey="shielded" stroke={colors.shielded} strokeWidth={1.75} fill="url(#shieldedFade)" dot={false}
                activeDot={{ r: 3, fill: colors.shielded, strokeWidth: 0 }} isAnimationActive={false} />}
              {metric === 'share' && <Area type="monotone" dataKey="shieldedSupplyPct" stroke={colors.shielded} strokeWidth={1.75} fill="url(#shieldedFade)" dot={false}
                activeDot={{ r: 3, fill: colors.shielded, strokeWidth: 0 }} isAnimationActive={false} connectNulls={false} />}
              {metric === 'public' && <Line type="monotone" dataKey="transparent" stroke={colors.transparent} strokeWidth={1.75} dot={false}
                activeDot={{ r: 3, fill: colors.transparent, strokeWidth: 0 }} isAnimationActive={false} />}
              {metric === 'public' && <Area type="monotone" dataKey="shielded" stroke={colors.shielded} strokeWidth={1.75} fill="url(#shieldedFade)" dot={false}
                activeDot={{ r: 3, fill: colors.shielded, strokeWidth: 0 }} isAnimationActive={false} />}
              {metric === 'pools' && POOL_ORDER.map(key => <Line key={key} type="monotone" dataKey={key} stroke={colors[key]} dot={false}
                strokeWidth={focusPool === key ? 2.25 : 1.5} strokeOpacity={focusPool && focusPool !== key ? 0.2 : 1}
                activeDot={{ r: 3, fill: colors[key], strokeWidth: 0 }} isAnimationActive={false} />)}
            </AreaChart>
          </ResponsiveContainer>}
        {(metric === 'public' || metric === 'pools') && points.length > 0 && <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-caption font-mono text-secondary" aria-label="Chart legend">
          {(metric === 'public' ? [['shielded', 'Shielded'], ['transparent', 'Transparent']] as const : POOL_ORDER.map(k => [k, POOL_LABEL[k]] as const)).map(([key, label]) =>
            <span key={key} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: colors[key] }} />{label}</span>)}
        </div>}
      </div>
      <PoolCurrencyNote />
    </ShareableCard>

    <div className="grid gap-4 lg:grid-cols-5">
      {/* Pools */}
      <section aria-labelledby="pools-heading" className={`${card} lg:col-span-3`}>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 id="pools-heading" className={cardTitle}>Inside shielded</h2>
          <span className="text-caption font-mono text-muted">{scrubbed?.hasPoolBreakdown ? fullDate(scrubbed.date) : 'Share of shielded · 7d change'}</span>
        </div>
        <ul>
          {POOL_ORDER.map(key => {
            const value = poolSource[key];
            const denominator = scrubbed?.hasPoolBreakdown ? scrubbed.shielded : live.shielded;
            const pct = denominator > 0 ? value / denominator * 100 : 0;
            const delta = data.deltas[key]?.['7d'];
            const showDelta = !scrubbed?.hasPoolBreakdown && delta != null && Number.isFinite(delta);
            return <li key={key} onMouseEnter={() => setFocusPool(key)} onMouseLeave={() => setFocusPool(null)}
              className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 border-b border-cipher-border/60 py-3 last:border-0 sm:grid-cols-[7rem_1fr_6.5rem_5rem]">
              <span className="flex items-center gap-2.5 text-sm text-primary">
                <span className="h-2 w-2 rounded-full" style={{ background: colors[key] }} aria-hidden="true" />
                {key === 'ironwood' ? <a href="/ironwood" className="underline-offset-4 hover:underline">{POOL_LABEL[key]}</a> : POOL_LABEL[key]}
              </span>
              <span className="text-right text-sm font-mono tabular-nums text-primary sm:order-3">{format(value)}</span>
              <span className="col-span-2 flex items-center gap-3 sm:order-2 sm:col-span-1">
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-glass-6">
                  <span className="block h-full rounded-full" style={{ width: `${Math.max(pct, value > 0 ? 0.6 : 0)}%`, background: colors[key] }} />
                </span>
                <span className="w-12 text-right text-caption font-mono tabular-nums text-secondary">{pct.toFixed(1)}%</span>
              </span>
              <span className={`hidden text-right text-caption font-mono tabular-nums sm:order-4 sm:block ${!showDelta ? 'text-muted' : delta! > 0 ? 'text-cipher-green' : delta! < 0 ? 'text-cipher-orange' : 'text-muted'}`}>
                {showDelta ? `${delta! > 0 && !usdBlocked ? '+' : ''}${format(zatToZec(delta!))}` : '—'}
              </span>
            </li>;
          })}
        </ul>
      </section>

      {/* 21M cap */}
      <section aria-labelledby="cap-heading" className={`${card} lg:col-span-2 flex flex-col`}>
        <div className="mb-5 flex items-baseline justify-between gap-3">
          <h2 id="cap-heading" className={cardTitle}>Where all 21M ZEC sit</h2>
        </div>
        {topLevel.length > 0 ? <>
          <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full" role="img"
            aria-label={topLevel.map(s => `${s.label} ${(s.zat / MAX_SUPPLY_ZAT * 100).toFixed(1)}%`).join(', ')}>
            {topLevel.map(s => <span key={s.key} style={{ width: `${s.zat / MAX_SUPPLY_ZAT * 100}%`, background: s.key === 'unmined' ? 'var(--color-glass-6)' : s.color, opacity: s.key === 'public' ? 0.55 : 1 }} />)}
          </div>
          <dl className="mt-5 space-y-3">
            {topLevel.map(s => <div key={s.key} className="flex items-baseline justify-between gap-3">
              <dt className="flex items-center gap-2 text-caption font-mono text-muted">
                <span className="h-2 w-2 rounded-full" style={{ background: s.key === 'unmined' ? 'var(--color-glass-6)' : s.color, opacity: s.key === 'public' ? 0.55 : 1 }} aria-hidden="true" />
                {s.key === 'public' ? 'Public' : s.key === 'unmined' ? 'Not yet issued' : 'Shielded'}
              </dt>
              <dd className="text-sm font-mono tabular-nums">
                <span className={s.key === 'shielded' ? 'text-cipher-gold' : 'text-primary'}>{format(zatToZec(s.zat))}</span>
                <span className="ml-3 inline-block w-12 text-right text-caption text-muted">{(s.zat / MAX_SUPPLY_ZAT * 100).toFixed(1)}%</span>
              </dd>
            </div>)}
          </dl>
          <p className="mt-auto pt-5 text-caption leading-relaxed text-muted">Public includes transparent balances and other issued value such as the lockbox. Latest snapshot.</p>
        </> : <p className="text-caption text-muted" role="status">Supply totals for this snapshot are missing or inconsistent.</p>}
      </section>
    </div>
  </div>;
}

export function ShieldedSupplySkeleton() {
  return <div aria-busy="true" aria-label="Loading shielded supply" className="space-y-4 animate-pulse">
    <div className="rounded-xl border border-cipher-border bg-cipher-surface p-4 sm:p-6">
      <div className="h-4 w-32 rounded bg-glass-4" />
      <div className="mt-6 h-12 sm:h-14 w-72 rounded-lg bg-glass-4" />
      <div className="mt-3 h-4 w-56 rounded bg-glass-4" />
      <div className="mt-6 rounded-lg bg-glass-3" style={{ height: CHART_HEIGHT }} />
    </div>
    <div className="grid gap-4 lg:grid-cols-5">
      <div className="h-64 rounded-xl border border-cipher-border bg-cipher-surface lg:col-span-3" />
      <div className="h-64 rounded-xl border border-cipher-border bg-cipher-surface lg:col-span-2" />
    </div>
  </div>;
}
