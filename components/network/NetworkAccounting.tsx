'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ComposedChart, Bar, Line, XAxis, YAxis, ResponsiveContainer, CartesianGrid } from 'recharts';
import { CURRENCY, NETWORK } from '@/lib/config';
import { useApiQuery } from '@/hooks/useApiQuery';
import { Card, CardBody } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';

type Accounting = { schedule: { network: string; nu7Height: number | null } | null; nodeHeight: number; nsmBalanceZat: number | string | null; observedAt: string;
  block: { height: number; feesPaidZat: number | string | null; feesToNsmZat: number | string | null; minerFeeAllocationZat: number | string | null;
    minerSubsidyZat: number | string | null; minerReceiptsZat: number | string | null; reissuanceZat: number | string | null } | null };

type Totals = { blocks: number; feeBlocks: number; nsmSamples: number; missingBlocks: number; feesPaidZat: string | null;
  feesToNsmZat: string | null; minerFeeAllocationZat: string | null; firstHeight: number | null; lastHeight: number | null;
  firstTimestamp: number | null; lastTimestamp: number | null };
type Point = { timestamp: number; firstHeight: number; lastHeight: number; blocks: number; feeBlocks: number; nsmSamples: number;
  missingBlocks: number; feesPaidZat: string | null; feesToNsmZat: string | null; minerFeeAllocationZat: string | null;
  minerReceiptsZat: string | null; nsmBalanceZat: string | null; cumulativeRemovalZat: string | null };
type Period = '1d' | '7d' | '30d' | 'all';
type History = { period: Period; schedule: Accounting['schedule']; nodeHeight: number; indexedHeight: number | null;
  bucketSeconds: number; points: Point[]; totals: Totals; selected: Totals;
  reserve: { height: number | null; baselineHeight: number | null; baselineZat: string | null; balanceZat: string | null; growthSinceNu7Zat: string | null } };
const periods = { '1d': '1D', '7d': '7D', '30d': '30D', all: 'Since NU7' } as const;
const historySeries = {
  fees: [['feesToNsmZat', 'Minimum removal', 'deshielding'], ['minerFeeAllocationZat', 'Maximum miner fees', 'shielding']],
  reserve: [['nsmBalanceZat', 'NSM reserve', 'orchard']],
  cumulative: [['cumulativeRemovalZat', 'Cumulative minimum removal', 'deshielding']],
  receipts: [['minerReceiptsZat', 'Miner receipts', 'gold']],
} as const;
const metricLabels = { fees: 'Fee allocation', reserve: 'NSM reserve', cumulative: 'Cumulative removal', receipts: 'Miner receipts' } as const;

function zec(value: number | string | null | undefined) {
  if (value == null || (typeof value === 'number' && !Number.isSafeInteger(value)) || !/^-?\d+$/.test(String(value))) return 'Unavailable';
  const n = BigInt(value); const abs = n < BigInt(0) ? -n : n;
  return `${n < BigInt(0) ? '-' : ''}${(abs / BigInt(100000000)).toLocaleString('en-US')}.${String(abs % BigInt(100000000)).padStart(8, '0')} ${CURRENCY}`;
}
function utc(timestamp: number, timeOnly = false) {
  return new Date(timestamp*1000).toLocaleString('en-US', { timeZone: 'UTC', ...(timeOnly
    ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) });
}

export function NetworkAccounting() {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const { data, error } = useApiQuery<Accounting>('/v1/network/accounting', undefined, { refreshInterval: 30_000 });
  const activationHeight = data?.schedule?.nu7Height;
  const expectedChain = NETWORK === 'mainnet' ? 'main' : NETWORK === 'testnet' ? 'test' : null;
  const nu7Active = !error && data != null && expectedChain !== null &&
    data.schedule?.network === expectedChain && activationHeight != null &&
    Number.isSafeInteger(activationHeight) && activationHeight > 0 && activationHeight <= 499_999_999 &&
    Number.isSafeInteger(data.nodeHeight) && data.nodeHeight >= activationHeight && data.nodeHeight <= 499_999_999;
  const [metric, setMetric] = useState<keyof typeof historySeries>('fees');
  const [period, setPeriod] = useState<Period>('1d');
  const history = useApiQuery<History>('/v1/network/accounting/history', { period }, { enabled: nu7Active, refreshInterval: 30_000 });
  // The hook retains previous query data. Never label an old range or network
  // as the newly selected period while its request is still in flight.
  const historySnapshot = history.data?.schedule?.network === expectedChain && history.data.schedule.nu7Height === activationHeight ? history.data : null;
  const selected = historySnapshot?.period === period ? historySnapshot : null;
  const points = (selected?.points ?? []).flatMap((point, i, all) => {
    const plotted = { ...point, ...Object.fromEntries(Object.entries(point).filter(([key]) => key.endsWith('Zat'))
      .map(([key, value]) => [key + 'Display', value == null || !Number.isFinite(Number(value)) ? null : Number(value) / 1e8])) };
    return i > 0 && point.timestamp - all[i-1].timestamp > selected!.bucketSeconds
      ? [{ timestamp: all[i-1].timestamp + selected!.bucketSeconds }, plotted] : [plotted];
  });
  const series = historySeries[metric];
  const hasValues = selected?.points.some(point => series.some(([key]) => point[key] != null));
  if (!nu7Active) return null;
  const block = data.block;
  const bucketLabel = selected ? selected.bucketSeconds < 3600 ? `${selected.bucketSeconds/60}-minute` : selected.bucketSeconds < 86400
    ? `${Number((selected.bucketSeconds/3600).toFixed(1))}-hour` : `${Number((selected.bucketSeconds/86400).toFixed(1))}-day` : '';
  return <section id="nu7-accounting" className="network-section mt-5" aria-label="NU7 network accounting"><Card className="card-static"><CardBody>
    <SectionHeader label="NU7_ACCOUNTING" actions={block && <Link href={`/block/${block.height}`}
      title={`Latest indexed canonical block ${block.height.toLocaleString('en-US')}`}
      className="inline-flex items-center gap-1 rounded-full border border-cipher-border px-2.5 py-1 text-caption text-muted font-mono hover:text-primary">
      Block #{block.height.toLocaleString('en-US')} <span aria-hidden="true">↗</span>
    </Link>} />
    <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-5 mb-6">
      {([
        ['Minimum removal since NU7', historySnapshot?.totals.feesToNsmZat,
          historySnapshot?.totals.firstHeight != null ? `Blocks ${historySnapshot.totals.firstHeight.toLocaleString()}–${historySnapshot.totals.lastHeight?.toLocaleString()}` : 'Awaiting complete fee history'],
        ['NSM reserve', data.nsmBalanceZat, `Node height ${data.nodeHeight.toLocaleString()}`],
        ['Reserve growth since NU7', historySnapshot?.reserve.growthSinceNu7Zat,
          historySnapshot?.reserve.baselineZat != null ? `From preactivation balance · through block ${historySnapshot.reserve.height?.toLocaleString()}` : 'Preactivation sample unavailable'],
      ] as const).map(([label, value, hint], index) => <div key={label} className={`min-w-0 ${index === 2 ? 'col-span-2 sm:col-span-1' : ''}`}>
        <dt className="text-caption text-muted mb-2">{label}</dt>
        <dd className="font-mono text-sm sm:text-base text-primary tabular-nums break-words">{zec(value)}</dd>
        <p className="text-caption text-muted mt-1">{hint}</p>
      </div>)}
    </dl>
    <div className="border-t border-cipher-border pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h3 className="font-mono text-sm text-primary">Accounting history</h3>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Accounting history period">
          {(Object.keys(periods) as Period[]).map(key => <button type="button" key={key} aria-pressed={period === key}
            className={`filter-btn ${period === key ? 'filter-btn-active' : ''}`} onClick={() => setPeriod(key)}>{periods[key]}</button>)}
        </div>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3 mb-5" aria-label="Selected period totals">
        {([['Fees paid', selected?.selected.feesPaidZat], ['Minimum removal', selected?.selected.feesToNsmZat],
          ['Maximum miner fees', selected?.selected.minerFeeAllocationZat]] as const).map(([label, value], index) => <div key={label} className={index === 2 ? 'col-span-2 sm:col-span-1' : undefined}>
          <dt className="text-caption text-muted mb-1">{label} · {periods[period]}</dt>
          <dd className="font-mono text-sm text-primary tabular-nums break-words">{zec(value)}</dd>
        </div>)}
      </dl>
      <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label="Accounting history metric">
        {(Object.keys(metricLabels) as (keyof typeof metricLabels)[]).map(key => <button type="button" key={key} aria-pressed={metric === key}
          className={`filter-btn ${metric === key ? 'filter-btn-active' : ''}`} onClick={() => setMetric(key)}>{metricLabels[key]}</button>)}
      </div>
      {hasValues ? <ResponsiveContainer width="100%" height={280} initialDimension={{ width: 400, height: 280 }}>
        <ComposedChart data={points} margin={{ top: 12, right: 24, bottom: 12, left: 0 }} barCategoryGap="15%">
          <CartesianGrid vertical={false} stroke={colors.grid} />
          <XAxis dataKey="timestamp" type="number" domain={['dataMin', 'dataMax']} tickFormatter={v => utc(Number(v), period === '1d')}
            minTickGap={45} padding={{ left: 12, right: 32 }} tick={{ fill: colors.axis, fontSize: 12 }} tickLine={false} axisLine={false} />
          <YAxis width={metric === 'reserve' ? 112 : 78} domain={metric === 'reserve' ? ['auto', 'auto'] : [0, 'auto']}
            tickFormatter={v => Number(v).toLocaleString('en-US', metric === 'reserve' ? { maximumFractionDigits: 8 } : { maximumSignificantDigits: 4 })}
            tick={{ fill: colors.axis, fontSize: 12 }} tickLine={false} axisLine={false} />
          <Tooltip labelFormatter={(timestamp, payload) => <div>{utc(Number(timestamp))} UTC
            {payload?.[0]?.payload?.firstHeight != null && <div className="text-caption mt-1">Blocks {payload[0].payload.firstHeight.toLocaleString()}–{payload[0].payload.lastHeight.toLocaleString()}
              {metric === 'fees' && <div>Fees paid: {zec(payload[0].payload.feesPaidZat)}</div>}</div>}
          </div>} formatter={(_value, name, item) => [zec(item.payload[String(item.dataKey).replace(/Display$/, '')]), name]} />
          {series.map(([key, name, color]) => metric === 'fees'
            ? <Bar key={key} dataKey={key + 'Display'} name={name} fill={colors[color]} stackId="fees" isAnimationActive={false} />
            : <Line key={key} dataKey={key + 'Display'} name={name} stroke={colors[color]} type={metric === 'receipts' ? 'linear' : 'stepAfter'}
              dot={false} connectNulls={false} isAnimationActive={false} strokeWidth={2} />)}
        </ComposedChart>
      </ResponsiveContainer> : <p role="status" className="min-h-[280px] flex items-center justify-center text-center text-sm text-muted">{history.loading || (!selected && !history.error)
        ? 'Loading selected accounting period…' : history.error ? 'Accounting history unavailable.' : 'No complete observations for this metric in this period.'}</p>}
      {hasValues && <ul className="flex flex-wrap gap-x-5 gap-y-2 mb-3 text-caption text-muted" aria-label="Chart legend">
        {series.map(([key, name, color]) => <li key={key} className="flex items-center gap-2"><span aria-hidden="true" className="inline-block w-3 h-0.5" style={{ backgroundColor: colors[color] }} />{name}</li>)}
      </ul>}
      <p className="text-caption text-muted">{metric === 'fees' ? 'Total column height = fees paid.' : metric === 'cumulative' ? 'Cumulative minimum removal starts at NU7 activation, including earlier blocks outside the selected range.'
        : metric === 'reserve' ? 'Reserve balance at the last block sampled in each bucket.' : 'Actual miner receipts summed within each bucket.'} Amounts in {CURRENCY}; exact values in tooltips.</p>
      {selected && <div className="text-caption text-muted mt-2 space-y-1">
        <p>{bucketLabel} buckets · Block-header times in UTC · {selected.selected.firstTimestamp != null ? `${utc(selected.selected.firstTimestamp)}–${utc(selected.selected.lastTimestamp!)}` : 'No blocks in this period'}.</p>
        <p>{selected.selected.feeBlocks.toLocaleString()} of {selected.selected.blocks.toLocaleString()} blocks have complete fees · {selected.selected.nsmSamples.toLocaleString()} reserve samples{selected.selected.missingBlocks ? ` · ${selected.selected.missingBlocks.toLocaleString()} missing blocks` : ''}. Missing observations remain gaps.</p>
        {selected.selected.firstHeight === activationHeight && period !== 'all' && <p>Available history begins at NU7 activation; this period is not yet fully elapsed.</p>}
      </div>}
      {(history.error || (selected?.indexedHeight != null && selected.nodeHeight > selected.indexedHeight)) && <p role="status" className="text-caption text-warning mt-2">{history.error ? 'History refresh unavailable. Displayed data may be stale.' : `History is ${selected!.nodeHeight - selected!.indexedHeight!} blocks behind the node.`}</p>}
    </div>
    <details className="mt-5 border-t border-cipher-border pt-4 text-caption text-muted">
      <summary className="cursor-pointer text-secondary hover:text-primary">Latest block accounting{block ? ` · #${block.height.toLocaleString()}` : ' · unavailable'}</summary>
      <dl className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mt-3">
        {([['Fees paid', block?.feesPaidZat], ['Minimum fee removal', block?.feesToNsmZat], ['Maximum miner fees', block?.minerFeeAllocationZat],
          ['Actual miner receipts', block?.minerReceiptsZat], ...(block?.reissuanceZat != null ? [['Reissuance', block.reissuanceZat] as const] : [])] as const)
          .map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="font-mono text-primary mt-1">{zec(value)}</dd></div>)}
      </dl>
    </details>
    <details className="mt-4 border-t border-cipher-border pt-4 text-caption text-muted">
      <summary className="cursor-pointer text-secondary hover:text-primary">Data &amp; definitions</summary>
      <div className="mt-3 space-y-2">
        <p>Minimum removal is 60% of aggregate block fees, rounded down once per active block before period totals are summed. It is not a measurement of total removals. Maximum miner fees are the remaining allocation.</p>
        <p>All ranges include only blocks at or after the serving node’s NU7 activation height. Since NU7 includes the full available activation history. Amounts require complete indexed transactions; missing blocks or fees make the affected total unavailable.</p>
        <p>Actual miner receipts exclude funding and founders’ payouts. Subsidy allocations are shown once in Issuance below.</p>
        <p>The signed NSM reserve is separate from circulating supply and cumulative fees. Reserve growth subtracts the hash-matched sample immediately before activation from the latest indexed block sample. Missing baseline or end samples make growth unavailable. The current node reserve can be newer than the history.</p>
        <p>Reserve and miner-receipt samples begin when collection is enabled. Missing bucket-end reserve samples remain gaps. The RPC does not separately report reissuance.</p>
      </div>
    </details>
  </CardBody></Card></section>;
}
