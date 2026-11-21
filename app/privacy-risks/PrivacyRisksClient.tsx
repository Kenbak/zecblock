'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { readApiData } from '@/lib/api-client';
import { getApiUrl } from '@/lib/api-config';
import { RiskyTxCard } from '@/components/RiskyTxCard';
import { BatchPatternCard, type BatchPattern } from '@/components/BatchPatternCard';
import { Tabs } from '@/components/ui/Tabs';
import { FilterGroup, FilterButton } from '@/components/ui/FilterGroup';
import { RiskResultsSkeleton, riskButtonClass } from '@/components/privacy/RiskEvidence';
import type { RiskyTransaction } from '@/components/privacy/types';

type Tab = 'roundtrip' | 'batch';
type Period = '24h' | '7d' | '30d' | '90d';
type Level = 'ALL' | 'HIGH' | 'MEDIUM';
type Sort = 'score' | 'recent';
type Cursor = { score?: number; amount?: number; time?: number };
type Stats = { total: number; highRisk: number; mediumRisk: number; lowRisk?: number };
type CommonAmount = { amountZec: number; txCount: number; percentage: string };

export default function PrivacyRisksClient() {
  const params = useSearchParams();
  const initialTab = params.get('tab') === 'batch' ? 'batch' : 'roundtrip';
  const requestedPeriod = params.get('period');
  const allowedPeriods = initialTab === 'batch' ? ['7d', '30d', '90d'] : ['24h', '7d', '30d'];
  const [tab, setTab] = useState<Tab>(initialTab);
  const [period, setPeriod] = useState<Period>(allowedPeriods.includes(requestedPeriod || '') ? requestedPeriod as Period : '7d');
  const [level, setLevel] = useState<Level>('ALL');
  const [sort, setSort] = useState<Sort>('score');
  const [transactions, setTransactions] = useState<RiskyTransaction[]>([]);
  const [patterns, setPatterns] = useState<BatchPattern[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [refreshed, setRefreshed] = useState<string | null>(null);
  const [common, setCommon] = useState<CommonAmount[] | null>(null);
  const pagination = useRef<{ offset: number; cursor: Cursor | null }>({ offset: 0, cursor: null });
  const request = useRef<AbortController | null>(null);

  const fetchResults = useCallback(async (append = false) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    if (append) setLoadingMore(true);
    else {
      setLoading(true); setLoadingMore(false); setStats(null); setHasMore(false); setRefreshed(null);
      setTransactions([]); setPatterns([]); pagination.current = { offset: 0, cursor: null };
    }
    try {
      const query = new URLSearchParams({ limit: '20', period, riskLevel: level, sort });
      if (tab === 'roundtrip') query.set('offset', String(pagination.current.offset));
      else if (append && pagination.current.cursor) {
        const cursor = pagination.current.cursor;
        if (sort === 'score' && cursor.score != null && cursor.amount != null) {
          query.set('afterScore', String(cursor.score)); query.set('afterAmount', String(cursor.amount));
        } else if (sort === 'recent' && cursor.time != null) query.set('afterScore', String(cursor.time));
      }
      const response = await fetch(`${getApiUrl()}/v1/privacy/${tab === 'roundtrip' ? 'risks' : 'batch-risks'}?${query}`, { signal: controller.signal });
      if (!response.ok) throw new Error('The observations could not be loaded. Please try again.');
      const data = await readApiData(response);
      if (!data?.stats || !data.pagination) throw new Error('The observations are unavailable. Please try again.');
      if (controller.signal.aborted) return;
      if (tab === 'roundtrip') {
        const rows: RiskyTransaction[] = data.transactions;
        setTransactions(previous => {
          const merged = append ? [...previous, ...rows] : rows;
          return [...new Map(merged.map(row => [`${row.shieldTxid}:${row.deshieldTxid}`, row])).values()];
        });
        pagination.current.offset += rows.length;
      } else {
        const rows: BatchPattern[] = data.patterns;
        setPatterns(previous => [...new Map((append ? [...previous, ...rows] : rows).map(row => [row.clusterHash || row.txids[0], row])).values()]);
        pagination.current.cursor = data.pagination.nextCursor;
      }
      setStats(data.stats); setHasMore(Boolean(data.pagination.hasMore));
      setRefreshed(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Unable to load observations.');
    } finally {
      if (!controller.signal.aborted) { setLoading(false); setLoadingMore(false); }
    }
  }, [tab, period, level, sort]);

  useEffect(() => { void fetchResults(); return () => request.current?.abort(); }, [fetchResults]);
  useEffect(() => {
    const controller = new AbortController();
    setCommon(null);
    void (async () => {
      try {
        const response = await fetch(`${getApiUrl()}/v1/privacy/common-amounts?period=${period}&limit=6`, { signal: controller.signal });
        if (!response.ok) return;
        const data = await readApiData(response);
        if (!controller.signal.aborted) setCommon(data?.amounts ?? null);
      } catch { /* Supplemental context is explicitly unavailable without a response. */ }
    })();
    return () => controller.abort();
  }, [period]);

  const changeTab = (next: Tab) => {
    setTab(next);
    if (next === 'batch' && period === '24h') setPeriod('7d');
    if (next === 'roundtrip' && period === '90d') setPeriod('30d');
  };
  const count = tab === 'roundtrip' ? transactions.length : patterns.length;
  return <div className="space-y-6">
    <Tabs tabs={[{ id: 'roundtrip', label: 'Potential round trips' }, { id: 'batch', label: 'Withdrawal batches' }]} active={tab} onChange={changeTab} />
    <div className="flex flex-wrap justify-between gap-4 items-end">
      <div className="flex flex-wrap gap-x-6 gap-y-4">
        <div><p className="text-xs text-muted mb-2">Observation window</p><FilterGroup>{(tab === 'roundtrip' ? ['24h', '7d', '30d'] : ['7d', '30d', '90d']).map(value => <FilterButton key={value} active={period === value} onClick={() => setPeriod(value as Period)}>{value.toUpperCase()}</FilterButton>)}</FilterGroup></div>
        <div><p className="text-xs text-muted mb-2">Signal level</p><FilterGroup>{(['ALL', 'HIGH', 'MEDIUM'] as const).map(value => <FilterButton key={value} active={level === value} onClick={() => setLevel(value)}>{value === 'ALL' ? 'All' : value === 'HIGH' ? 'High' : 'Medium'}</FilterButton>)}</FilterGroup></div>
        <div><p className="text-xs text-muted mb-2">Order</p><FilterGroup>{(['score', 'recent'] as const).map(value => <FilterButton key={value} active={sort === value} onClick={() => setSort(value)}>{value === 'score' ? 'Highest score' : 'Newest first'}</FilterButton>)}</FilterGroup></div>
      </div>
      <button className={riskButtonClass} onClick={() => void fetchResults()} disabled={loading || loadingMore}>Refresh observations</button>
    </div>
    <section aria-label="Observation summary" className="rounded-xl border border-cipher-border overflow-hidden">
      <dl className="grid grid-cols-3 divide-x divide-cipher-border">
        {[{ label: tab === 'roundtrip' ? 'Candidate pairs' : 'Withdrawal batches', value: stats?.total }, { label: 'High signal', value: stats?.highRisk }, { label: 'Medium signal', value: stats?.mediumRisk }].map(item => <div key={item.label} className="p-4 sm:p-6"><dt className="text-xs text-muted">{item.label}</dt><dd className="mt-2 font-mono text-2xl sm:text-3xl text-primary tabular-nums">{loading ? <span className="block h-8 w-16 skeleton-bg rounded motion-safe:animate-pulse" /> : item.value?.toLocaleString() ?? '—'}</dd></div>)}
      </dl>
      <div className="border-t border-cipher-border px-4 sm:px-6 py-3 flex flex-wrap justify-between gap-2 text-xs text-muted"><span>Counts match the selected window and signal filter. Pairs and batches can overlap.</span><span>{refreshed ? `Fetched at ${refreshed} · precomputed observations` : 'Precomputed observations'}</span></div>
    </section>
    <div className="flex flex-wrap justify-between gap-3 items-start">
      <div><h2 className="text-lg font-semibold text-primary">{tab === 'roundtrip' ? 'Candidate links' : 'Repeated withdrawal patterns'}</h2><p className="mt-2 text-sm text-secondary max-w-3xl">{tab === 'roundtrip' ? 'A public shielding event paired with a later deshielding event by the model. Compare the public input and output addresses, then inspect the score evidence.' : 'Withdrawals grouped by amount and timing. A candidate shielding event may be present; it is not a verified source of the withdrawals.'}</p></div>
      <a href="#risk-methodology" className="text-xs text-secondary underline underline-offset-4 py-2">How to read this analysis ↓</a>
    </div>
    {error && <div role="alert" className="rounded-xl border border-cipher-border p-5 text-sm text-secondary"><p>{error}</p><button className={`${riskButtonClass} mt-3`} onClick={() => void fetchResults(count > 0)}>Try again</button></div>}
    {loading ? <RiskResultsSkeleton /> : count === 0 && !error ? <div className="rounded-xl border border-cipher-border py-12 px-6 text-center"><h3 className="text-base text-primary font-medium">No observations match these filters</h3><p className="mt-2 text-sm text-muted">Try a different window or signal level. An empty result is not a guarantee of privacy.</p></div> : <div className="space-y-4">{tab === 'roundtrip' ? transactions.map(tx => <RiskyTxCard key={`${tx.shieldTxid}:${tx.deshieldTxid}`} tx={tx} />) : patterns.map(pattern => <BatchPatternCard key={pattern.clusterHash || pattern.txids[0]} pattern={pattern} />)}</div>}
    {!loading && count > 0 && <div className="flex flex-wrap items-center justify-between gap-4 text-xs text-muted"><p>Showing {count.toLocaleString()} of {stats?.total.toLocaleString() ?? '—'} observations</p>{hasMore && <button className={riskButtonClass} disabled={loadingMore} onClick={() => void fetchResults(true)}>{loadingMore ? 'Loading…' : 'Load more observations'}</button>}</div>}
    <section id="risk-methodology" className="scroll-mt-24 border-t border-cipher-border pt-8 space-y-5">
      <h2 className="text-lg font-semibold text-primary">How to read this analysis</h2>
      <div className="grid md:grid-cols-3 gap-6 text-sm text-secondary leading-relaxed">
        <div><h3 className="text-primary font-medium mb-2">1. Public observations</h3><p>Amounts and times of ZEC entering and leaving shielded pools.</p></div>
        <div><h3 className="text-primary font-medium mb-2">2. Candidate relationships</h3><p>Round-trip scoring considers amount similarity, timing, rarity and competing candidates. Batch scoring considers repeated amounts, timing and candidate shielding events.</p></div>
        <div><h3 className="text-primary font-medium mb-2">3. Inspect the evidence</h3><p>Open the score inputs and compare the public addresses and transactions. For batches, explore the graph; dashed connections are inferred.</p></div>
      </div>
      <details className="rounded-xl border border-cipher-border p-5">
        <summary className="cursor-pointer text-sm text-secondary">Observed common amounts · {period.toUpperCase()}</summary>
        <div className="pt-5"><p className="text-xs text-muted mb-4">Public flow amounts are rounded to 0.01 ZEC. Counts and percentages cover flow records of at least 0.01 ZEC in this window, independent of the signal filter. Frequency is not an anonymity guarantee or a recommended transfer size.</p>{common ? <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">{common.map(row => <div key={row.amountZec}><p className="font-mono text-sm text-primary">{row.amountZec.toLocaleString(undefined, { maximumFractionDigits: 8 })} ZEC</p><p className="text-xs text-muted mt-1">{row.txCount.toLocaleString()} observations · {row.percentage}%</p></div>)}</div> : <p className="text-sm text-muted">Amount-frequency data is unavailable.</p>}</div>
      </details>
      <nav aria-label="Related privacy tools" className="flex flex-wrap gap-3"><Link className={riskButtonClass} href="/privacy">Network privacy metrics →</Link><Link className={riskButtonClass} href="/pools">Shielded pools →</Link><Link className={riskButtonClass} href="/txs">Transaction explorer →</Link></nav>
    </section>
  </div>;
}
