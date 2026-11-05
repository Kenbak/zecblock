'use client';

import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { ChartWatermark } from '@/components/ChartWatermark';
import { ChartTooltip } from '@/components/charts/ChartTooltip';
import { MarketSectionIcon } from '@/components/icons/home-section';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { PeriodPillTags } from '@/components/ui/PeriodPillTags';
import { ChartSkeleton } from '@/components/ui/Skeleton';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { btcPercentage, periodChange, type ZecBtcPeriod, type ZecBtcSnapshot } from '@/lib/zec-btc';

const PERIODS = [
  { key: '7d', label: '7D' }, { key: '30d', label: '30D' },
  { key: '90d', label: '90D' }, { key: '1y', label: '1Y' },
] as const;
const day = (timestamp: number) => new Date(timestamp).toLocaleDateString('en-US', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
});
const instant = (timestamp: number) => new Date(timestamp).toLocaleString('en-GB', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
}) + ' UTC';
const percentage = (value: number) => value.toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: value < 0.01 ? 6 : 2,
}) + '%';

function useZecBtc(period: ZecBtcPeriod) {
  const [state, setState] = useState<{ data: ZecBtcSnapshot | null; failedPeriod: ZecBtcPeriod | null }>({ data: null, failedPeriod: null });
  const [now, setNow] = useState(0);

  useEffect(() => {
    let disposed = false;
    let pending = false;
    let controller: AbortController | undefined;
    async function refresh() {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      controller = new AbortController();
      const deadline = setTimeout(() => controller?.abort(), 20_000);
      try {
        const response = await fetch(`/api/market/zec-btc?period=${period}`, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Market source unavailable');
        const data: ZecBtcSnapshot = await response.json();
        if (data.period !== period || (!data.quote && !data.history)) throw new Error('Incomplete market response');
        if (!disposed) setState({ data, failedPeriod: null });
      } catch {
        if (!disposed) setState(previous => ({ ...previous, failedPeriod: period }));
      } finally {
        clearTimeout(deadline);
        pending = false;
        if (!disposed) setNow(Date.now());
      }
    }
    setNow(Date.now());
    void refresh();
    const interval = setInterval(() => { setNow(Date.now()); void refresh(); }, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [period]);

  return {
    now, failed: state.failedPeriod === period,
    quote: state.data?.quote ?? null,
    data: state.data?.period === period ? state.data : null,
  };
}

export function ZecBtcCard() {
  const [period, setPeriod] = useState<ZecBtcPeriod>('30d');
  const { data, quote, failed, now } = useZecBtc(period);
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const history = data?.history;
  const points = useMemo(() => history?.points.map(point => ({
    ...point, percentage: point.btcPerZec === null ? null : btcPercentage(point.btcPerZec),
  })) ?? [], [history]);
  const valid = points.filter(point => point.percentage !== null);
  const first = valid[0];
  const last = valid.at(-1);
  const change = periodChange(valid);
  const quotePercentage = btcPercentage(quote?.btcPerZec);
  const quoteDelayed = failed || quote?.delayed || (quote && now - quote.fetchedAt > 60_000)
    || !quote?.observedAt || now - quote.observedAt > 300_000 || quote.observedAt > now + 60_000;
  const historyDelayed = failed || history?.delayed || (history && now - history.fetchedAt > 300_000);
  const loading = !data && !failed;
  const historyStatus = loading ? null : !history ? 'History unavailable'
    : historyDelayed ? 'Delayed history' : valid.length < points.length ? 'Limited history' : null;

  return <section id="zec-btc" className="scroll-mt-64 lg:scroll-mt-44 mb-12">
    <SectionHeader label="ZEC_BTC" icon={<MarketSectionIcon />} actions={
      <PeriodPillTags options={PERIODS} value={period} onChange={setPeriod} aria-label="ZEC / BTC history period" />
    } />
    <div className="card card-static min-w-0"><div className="card-body">
      <div className="flex flex-wrap justify-between gap-x-10 gap-y-6 mb-7">
        <div>
          <h3 className="text-sm text-secondary mb-3">One ZEC as a percentage of one BTC</h3>
          <p className="text-4xl font-semibold font-mono tracking-tight text-primary tabular-nums" aria-live="polite">
            {quotePercentage !== null ? percentage(quotePercentage) : '—'}
          </p>
          <p className="text-sm font-mono text-secondary mt-2">{quote ? `${quote.btcPerZec.toFixed(8)} BTC per ZEC` : loading ? 'Loading quote…' : 'Quote unavailable'}</p>
          <p className="text-caption text-muted mt-2">
            {quote ? `${quoteDelayed ? 'Delayed quote' : 'Current quote'} · ${quote.observedAt ? instant(quote.observedAt) : 'Provider time unavailable'}` : 'CoinGecko · BTC-denominated quote'}
          </p>
        </div>
        <div className="sm:text-right self-end">
          <p className="text-caption font-mono text-muted mb-2">CHANGE OVER SHOWN DATES</p>
          <p className={`text-xl font-mono tabular-nums ${change === null ? 'text-muted' : change >= 0 ? 'text-cipher-green' : 'text-cipher-orange'}`}>
            {change === null ? '—' : `${change > 0 ? '+' : ''}${change.toFixed(2)}%`}
          </p>
          <p className="text-caption text-muted mt-2">{first && last ? `${day(first.timestamp)} – ${day(last.timestamp)}` : 'Daily history unavailable'}</p>
        </div>
      </div>
      <div role="img" aria-label={`ZEC price as a percentage of Bitcoin, ${period.toUpperCase()} daily chart. ${first && last ? `From ${percentage(first.percentage!)} on ${day(first.timestamp)} to ${percentage(last.percentage!)} on ${day(last.timestamp)}.` : 'No observations available.'}`}>
        {loading ? <ChartSkeleton height={300} /> : !valid.length ? <div className="h-[300px] flex items-center justify-center text-sm text-muted" role="status">Daily ZEC / BTC history is unavailable.</div> : <>
          <ResponsiveContainer width="100%" height={300} initialDimension={{ width: 500, height: 300 }}>
            <LineChart data={points} margin={{ top: 12, right: 12, left: 0, bottom: 8 }}>
              <CartesianGrid vertical={false} stroke={colors.gridStroke} />
              <XAxis dataKey="timestamp" type="number" domain={['dataMin', 'dataMax']} minTickGap={55} tickFormatter={value => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} tick={{ fill: colors.axis, fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis width={66} domain={[0, (maximum: number) => Math.max(5, Math.ceil(maximum))]} tickCount={6} tickFormatter={percentage} tick={{ fill: colors.axis, fontSize: 12 }} axisLine={false} tickLine={false} />
              <ChartTooltip labelFormatter={value => `${day(Number(value))} · 00:00 UTC`} formatter={value => [percentage(Number(value)), 'One ZEC / one BTC']} />
              <Line dataKey="percentage" name="ZEC / BTC" type="linear" stroke={colors.gold} strokeWidth={2} connectNulls={false} isAnimationActive={false} dot={({ cx, cy, index }: { cx?: number; cy?: number; index?: number }) => {
                const isolated = index !== undefined && !points[index - 1]?.percentage && !points[index + 1]?.percentage;
                return <circle key={index} cx={cx} cy={cy} r={isolated || points.length <= 8 ? 2.5 : 0} fill={colors.gold} strokeWidth={0} />;
              }} />
            </LineChart>
          </ResponsiveContainer>
          <ChartWatermark />
        </>}
      </div>
      <div className="flex flex-wrap justify-between gap-x-6 gap-y-2 mt-5 border-t border-cipher-border pt-4 text-caption text-muted">
        <p>Price data by <a href="https://www.coingecko.com/en/api" target="_blank" rel="noopener noreferrer" className="text-cipher-gold hover:underline">CoinGecko</a></p>
        {historyStatus && <p role="status">{historyStatus}</p>}
      </div>
    </div></div>
  </section>;
}
