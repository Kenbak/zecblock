'use client';
import { useState } from 'react';
import Link from 'next/link';
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, CartesianGrid } from 'recharts';
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

function zec(value: number | string | null | undefined) {
  if (value == null || (typeof value === 'number' && !Number.isSafeInteger(value)) || !/^-?\d+$/.test(String(value))) return 'Unavailable';
  const n = BigInt(value); const abs = n < BigInt(0) ? -n : n;
  return `${n < BigInt(0) ? '-' : ''}${(abs / BigInt(100000000)).toLocaleString('en-US')}.${String(abs % BigInt(100000000)).padStart(8, '0')} ${CURRENCY}`;
}

type HistoryPoint = { height: number; feesPaidZat: string | null; feesToNsmZat: string | null;
  minerFeeAllocationZat: string | null; minerReceiptsZat: string | null; nsmBalanceZat: string | null };
type History = { points: HistoryPoint[]; coverage: { blocks: number; feeBlocks: number; nsmSamples: number }; nodeHeight: number; indexedHeight: number | null };
const historySeries = {
  fees: [['feesPaidZat', 'Fees paid', 'transparent'], ['feesToNsmZat', 'Minimum removal', 'deshielding'], ['minerFeeAllocationZat', 'Maximum miner fees', 'shielding']],
  reserve: [['nsmBalanceZat', 'NSM reserve', 'orchard']],
  receipts: [['minerReceiptsZat', 'Miner receipts', 'gold']],
} as const;

export function NetworkAccounting() {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const { data, loading, error } = useApiQuery<Accounting>('/v1/network/accounting', undefined, { refreshInterval: 30_000 });
  const activationHeight = data?.schedule?.nu7Height;
  const expectedChain = NETWORK === 'mainnet' ? 'main' : NETWORK === 'testnet' ? 'test' : null;
  const nu7Active = !error && data != null && expectedChain !== null &&
    data.schedule?.network === expectedChain && activationHeight != null &&
    Number.isSafeInteger(activationHeight) && activationHeight > 0 && activationHeight <= 499_999_999 &&
    Number.isSafeInteger(data.nodeHeight) && data.nodeHeight >= activationHeight && data.nodeHeight <= 499_999_999;
  const block = data?.block;
  const [metric, setMetric] = useState<keyof typeof historySeries>('fees');
  const history = useApiQuery<History>('/v1/network/accounting/history', { limit: 120 }, { enabled: nu7Active, refreshInterval: 15_000 });
  const points = (history.data?.points ?? []).flatMap((point, i, all) => {
    const plotted = { ...point, ...Object.fromEntries(Object.entries(point).filter(([key]) => key.endsWith('Zat'))
      .map(([key, value]) => [key + 'Display', value == null || !Number.isFinite(Number(value)) ? null : Number(value) / 1e8])) };
    // Preserve missing indexed ranges instead of drawing an invented continuous history.
    return i > 0 && all[i - 1].height + 1 !== point.height
      ? [{ height: all[i - 1].height + 1 }, plotted] : [plotted];
  });
  const series = historySeries[metric];
  const hasValues = history.data?.points.some(point => series.some(([key]) => point[key] != null && Number.isFinite(Number(point[key]))));
  if (!nu7Active) return null;
  return <Card className="card-static mt-5"><CardBody>
    <SectionHeader label="NU7_ACCOUNTING" />
    <p className="text-caption text-muted mb-5">{block ? <Link href={`/block/${block.height}`} className="text-secondary hover:text-primary underline underline-offset-4">Canonical block #{block.height.toLocaleString()} →</Link> : loading ? 'Loading block accounting…' : 'Block accounting unavailable.'}</p>
    <dl className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-x-6 gap-y-5 mb-6">
      {([
        ['Fees paid', block?.feesPaidZat], ['Minimum fee removal', block?.feesToNsmZat],
        ['Maximum miner fees', block?.minerFeeAllocationZat], ['Actual miner receipts', block?.minerReceiptsZat],
        ['NSM reserve', data?.nsmBalanceZat],
        ...(block?.reissuanceZat != null ? [['Reissuance', block.reissuanceZat] as const] : []),
      ] as const).map(([label, value]) => <div key={label} className="min-w-0">
        <dt className="text-caption text-muted mb-2">{label}</dt>
        <dd className="font-mono text-sm text-primary tabular-nums break-words">{zec(value)}</dd>
        {label === 'NSM reserve' && <p className="text-caption text-muted mt-1">Node height {data.nodeHeight.toLocaleString()}</p>}
      </div>)}
    </dl>
    <div className="border-t border-cipher-border pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h3 className="font-mono text-sm text-primary">Accounting history</h3>
        <div className="flex flex-wrap gap-2" aria-label="Accounting history metric">
          {(['fees', 'reserve', 'receipts'] as const).map(key => <button type="button" key={key} aria-pressed={metric === key}
            className={`filter-btn ${metric === key ? 'filter-btn-active' : ''}`}
            onClick={() => setMetric(key)}>{({ fees: 'Fee allocation', reserve: 'NSM reserve', receipts: 'Miner receipts' })[key]}</button>)}
        </div>
      </div>
      {hasValues ? <ResponsiveContainer width="100%" height={270} initialDimension={{ width: 400, height: 270 }}>
        <LineChart data={points} margin={{ top: 12, right: 32, bottom: 12, left: 0 }}>
          <CartesianGrid vertical={false} stroke={colors.grid} />
          <XAxis dataKey="height" type="number" domain={['dataMin', 'dataMax']} tickFormatter={v => Number(v).toLocaleString()} minTickGap={55} padding={{ left: 16, right: 32 }} tick={{ fill: colors.axis, fontSize: 12 }} tickLine={false} axisLine={false} />
          <YAxis width={78} domain={['auto', 'auto']} tickFormatter={v => Number(v).toLocaleString('en-US', { maximumSignificantDigits: 4 })} tick={{ fill: colors.axis, fontSize: 12 }} tickLine={false} axisLine={false} />
          <Tooltip labelFormatter={height => `Block ${Number(height).toLocaleString()}`}
            formatter={(_value, name, item) => [zec(item.payload[String(item.dataKey).replace(/Display$/, '')]), name]} />
          {series.map(([key, name, color]) => <Line key={key} dataKey={key + 'Display'} name={name} stroke={colors[color]}
            dot={{ r: 2 }} connectNulls={false} isAnimationActive={false} strokeWidth={2} />)}
        </LineChart>
      </ResponsiveContainer> : <p role="status" className="py-12 text-center text-sm text-muted">{history.loading ? 'Loading accounting history…' : history.error ? 'Accounting history unavailable.' : 'No observations for this metric yet.'}</p>}
      {hasValues && <ul className="flex flex-wrap gap-x-5 gap-y-2 mb-3 text-caption text-muted" aria-label="Chart legend">
        {series.map(([key, name, color]) => <li key={key} className="flex items-center gap-2"><span aria-hidden="true" className="inline-block w-3 h-0.5" style={{ backgroundColor: colors[color] }} />{name}</li>)}
      </ul>}
      <p className="text-caption text-muted">Latest {history.data?.coverage.blocks ?? 120} indexed blocks · {CURRENCY} · Exact amounts in tooltips.</p>
      {history.data && <p className="text-caption text-muted mt-1">{history.data.coverage.feeBlocks} complete fee blocks · {history.data.coverage.nsmSamples} reserve samples. Missing observations remain gaps.</p>}
      {(history.error || (history.data?.indexedHeight != null && history.data.nodeHeight > history.data.indexedHeight)) && <p role="status" className="text-caption text-warning mt-2">{history.error ? 'History refresh unavailable. Displayed data may be stale.' : `History is ${history.data!.nodeHeight - history.data!.indexedHeight!} blocks behind the node.`}</p>}
    </div>
    <details className="mt-5 border-t border-cipher-border pt-4 text-caption text-muted">
      <summary className="cursor-pointer text-secondary hover:text-primary">Data &amp; definitions</summary>
      <div className="mt-3 space-y-2">
        <p>Minimum removal is 60% of aggregate block fees, rounded down once per active block. It is not a measurement of total removals. Maximum miner fees are the remaining allocation.</p>
        <p>Actual miner receipts exclude funding and founders’ payouts. Subsidy allocations are shown once in Issuance below.</p>
        <p>The signed NSM reserve is separate from circulating supply. It can start with an existing balance and is not a cumulative fee total. Its node observation can be newer than the canonical block above.</p>
        <p>Reserve and miner-receipt samples begin when collection is enabled. Uncollected values remain unavailable. The RPC does not separately report reissuance.</p>
      </div>
    </details>
  </CardBody></Card>;
}
