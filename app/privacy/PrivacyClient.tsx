'use client';
import { readApiData } from '@/lib/api-client';
import { PageLoadingBody } from '@/components/ui/PageLoading';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { PageHeader, SectionHeader } from '@/components/ui';
import { getApiUrl } from '@/lib/api-config';
import { useWebSocket } from '@/hooks/useWebSocket';
import { RecentShieldedTxs } from '@/components/RecentShieldedTxs';
import { useTheme } from '@/contexts/ThemeContext';
import { Card, CardBody } from '@/components/ui/Card';
import { AnonymitySetChart } from '@/components/privacy/AnonymitySetChart';
import { ShieldingDistributionChart } from '@/components/privacy/ShieldingDistributionChart';
import { PrivacyTrendsSection, type TrendChartView } from '@/components/privacy/PrivacyTrendsSection';
import { formatRelativeUpdated } from '@/lib/privacy-trend-dates';
import { PRIVACY_PERIODS, type Period } from '@/components/privacy/PeriodSelector';
import { useUrlState } from '@/lib/use-url-state';

const INPUTS = [
  { key: 'usage', title: 'Shielded participation', window: '30 days', description: 'Shielded transactions as a share of shielded plus non-coinbase transparent transactions.' },
  { key: 'quality', title: 'Fully shielded share', window: '30 days', description: 'Among shielded transactions, those with no transparent inputs or outputs, excluding coinbase.' },
  { key: 'depth', title: 'Shielded supply', window: 'Snapshot', description: 'Supply held in shielded pools as a share of issued chain supply.' },
  { key: 'hygiene', title: 'Reshielded volume', window: '90 days', description: 'Tracked reshielded ZEC divided by deshielded ZEC over the same window.' },
] as const;
const RELATED = [
  { href: '/pools', title: 'Shielded pools', description: 'Pool balances, supply history and volume.' },
  { href: '/turnstile', title: 'Turnstile', description: 'Observed destinations after deshielding.' },
  { href: '/tools/blend-check', title: 'Blend Check', description: 'Explore how common a public amount is.' },
];

interface PrivacyStats {
  lastUpdated: string;
  lastBlockScanned: number;
  totals: {
    blocks: number;
    shieldedTx: number;
    transparentTx: number;
    coinbaseTx: number;
    totalTx: number;
    mixedTx: number;
    fullyShieldedTx: number;
  };
  shieldedPool: {
    currentSize: number;
    sprout?: number;
    sapling?: number;
    orchard?: number;
    ironwood?: number;
    transparent?: number;
    chainSupply?: number;
  };
  metrics: {
    shieldedPercentage: number;
    privacyScore: number;
    scoreUpdatedAt?: string;
    scoreSource?: string;
    scoreBreakdown?: Record<
      string,
      { label: string; score: number; max: number; percent: number; detail: string }
    > | null;
    scoreVersion?: number;
    avgShieldedPerDay: number;
    adoptionTrend: 'growing' | 'stable' | 'declining';
  };
  trends: {
    daily: Array<{
      date: string;
      shielded: number;
      transparent: number;
      poolSize: number;
      shieldedPercentage: number;
      privacyScore: number;
    }>;
  };
}

export default function PrivacyClient() {
  const [stats, setStats] = useState<PrivacyStats | null>(null);
  const [trendHistory, setTrendHistory] = useState<PrivacyStats['trends']['daily']>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trendView, setTrendView] = useState<TrendChartView>('score');
  const [trendPeriod, setTrendPeriod] = useUrlState<Period>('trends', '30d', PRIVACY_PERIODS);
  const { theme } = useTheme();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${getApiUrl()}/v1/privacy/stats`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('Privacy statistics could not load.');
      const response = await readApiData(res);
      const data = response;
      if (!data?.metrics || data.error) throw new Error('Privacy statistics are unavailable.');
      setStats(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Privacy statistics could not load.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const controller = new AbortController();
    fetch(`${getApiUrl()}/v1/privacy/stats?days=all`, { signal: controller.signal })
      .then(res => res.ok ? readApiData(res) : null)
      .then(response => {
        const data = response;
        if (data?.trends?.daily) setTrendHistory(data.trends.daily);
      }).catch(() => {});
    return () => controller.abort();
  }, [refresh]);
  useWebSocket({ onMessage: data => {
    if (data.type === 'privacy_stats') void refresh();
  } });

  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
    <PageHeader eyebrow="PRIVACY_SCORE" title="Zcash Privacy Score" subtitle="Shielded participation, transaction patterns and supply. A network-level index of observed usage—not a rating of individual privacy." />
    <nav aria-label="Privacy page sections" className="flex flex-wrap gap-x-5 gap-y-3 font-mono text-caption text-muted mb-8">
      <a href="#score" className="hover:text-primary">Score & inputs</a>
      <a href="#trends" className="hover:text-primary">Trends</a>
      <a href="#distribution" className="hover:text-primary">Public amounts</a>
      <a href="#activity" className="hover:text-primary">Recent activity</a>
      <a href="#how-it-works" className="hover:text-primary">Methodology</a>
    </nav>
    {error && <p role="status" className="text-caption text-warning mb-6">{error} {stats ? 'Showing the last received snapshot. ' : ''}<button onClick={refresh} className="underline underline-offset-4">Retry</button></p>}
    {loading && !stats && <PageLoadingBody layout="privacy" />}
    {!loading && !stats && <Card><CardBody><p className="text-secondary text-sm">The score is unavailable until an indexed snapshot can be loaded.</p></CardBody></Card>}
    {stats && <>
      <section id="score" className="scroll-mt-36 mb-10">
        <Card className="card-static">
          <CardBody>
            <div className="grid gap-6 pb-6 sm:grid-cols-[220px_minmax(0,1fr)] sm:gap-8">
              <div>
                <h2 className="font-mono text-caption text-muted uppercase">Privacy Score</h2>
                <p className="mt-3 font-mono tabular-nums text-primary"><span className="text-5xl font-medium">{stats.metrics.privacyScore ?? '—'}</span><span className="text-lg text-muted"> / 100</span></p>
                <p className="mt-3 text-caption text-muted">{stats.metrics.scoreVersion ? `Model v${stats.metrics.scoreVersion} · ` : ''}<a href="#how-it-works" className="underline underline-offset-4 hover:text-primary">Methodology</a></p>
              </div>
              <div className="sm:border-l border-cipher-border sm:pl-8">
                <h3 className="text-sm font-semibold text-primary">Four inputs, one weighted index</h3>
                <p className="mt-2 max-w-2xl text-sm text-secondary leading-relaxed">The score combines shielded participation, fully shielded transaction share, shielded supply and tracked reshielding. Expand the score inputs below to inspect each observation and its contribution.</p>
                <p className="mt-3 text-caption text-muted">The index describes aggregate usage. It does not estimate the probability that an individual transaction is private.</p>
              </div>
            </div>
          </CardBody>
          <div className="border-t border-cipher-border px-5 sm:px-6 py-3 flex flex-wrap gap-x-6 gap-y-2 font-mono text-caption text-muted">
            <time dateTime={stats.metrics.scoreUpdatedAt || stats.lastUpdated} title={stats.metrics.scoreUpdatedAt || stats.lastUpdated}>Score updated {formatRelativeUpdated(stats.metrics.scoreUpdatedAt || stats.lastUpdated)}</time>
            <span>Indexed through block {stats.lastBlockScanned.toLocaleString()}</span>
            <span>{stats.metrics.scoreSource === 'rolling-fallback' ? 'Recomputed inputs · supply from snapshot' : 'Hourly snapshot'}</span>
          </div>
        </Card>
        <details className="privacy-inputs network-detail-panel network-detail-disclosure mt-5 rounded-lg border border-cipher-border">
          <summary className="network-detail-toggle"><span><span className="block text-sm font-mono text-primary">Score inputs</span><span className="block text-caption text-muted mt-1">Four observations, their time windows and weighted contributions.</span></span><svg className="network-detail-chevron w-4 h-4 text-muted shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" /></svg></summary>
          <div className="border-t border-cipher-border p-5 sm:p-6">
            <p className="text-caption text-muted mb-5">Input percentages use different denominators. Points are weighted contributions to the total.</p>
            <div className="overflow-x-auto" role="region" tabIndex={0} aria-label="Privacy score input table">
              <table className="w-full text-caption">
                <thead><tr className="border-b border-cipher-border text-muted font-mono"><th className="text-left px-3 py-3">Input / window</th><th className="text-left px-3 py-3">What is measured</th><th className="text-right px-3 py-3">Observed</th><th className="text-right px-3 py-3 whitespace-nowrap">Points / max</th></tr></thead>
                <tbody className="divide-y divide-cipher-border">{INPUTS.map(input => {
                  const row = stats.metrics.scoreBreakdown?.[input.key];
                  return <tr key={input.key}>
                    <th scope="row" className="px-3 py-4 text-left font-normal min-w-40"><span className="block text-primary font-mono">{input.title}</span><span className="block mt-1 text-muted">{input.window}</span></th>
                    <td className="px-3 py-4 text-muted min-w-56 max-w-md leading-relaxed">{input.description}</td>
                    <td className="px-3 py-4 text-right text-primary font-mono tabular-nums whitespace-nowrap">{row ? `${row.percent.toFixed(1)}%` : '—'}</td>
                    <td className="px-3 py-4 text-right text-secondary font-mono tabular-nums whitespace-nowrap">{row ? `${row.score.toFixed(1)} / ${row.max}` : '—'}</td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
            <p className="text-caption text-muted mt-5">The inputs combine 30-day activity, current supply and 90-day public flow tracking. Rounded contributions may differ slightly from the rounded total.</p>
          </div>
        </details>
      </section>
      <section id="trends" className="scroll-mt-36 mb-10">
        <SectionHeader label="TRENDS" />
        <PrivacyTrendsSection trendHistory={trendHistory.length > 0 ? trendHistory : stats.trends.daily} privacyScore={stats.metrics.privacyScore} lastBlockScanned={stats.lastBlockScanned} theme={theme} view={trendView} onViewChange={setTrendView} period={trendPeriod} onPeriodChange={setTrendPeriod} />
      </section>
      <section id="distribution" className="scroll-mt-36 mb-10">
        <SectionHeader label="PUBLIC_AMOUNT_PATTERNS" />
        <p className="text-sm text-muted mb-5 max-w-3xl">Public amounts at shielding and deshielding boundaries provide context. These charts do not measure the anonymity of a wallet or expose fully shielded amounts.</p>
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2"><AnonymitySetChart /><ShieldingDistributionChart /></div>
      </section>
      <section id="activity" className="scroll-mt-36 mb-10">
        <SectionHeader label="RECENT_SHIELDED_ACTIVITY" />
        <Card><CardBody>
          <p className="text-caption text-muted mb-5">Latest indexed transactions involving shielded pools. This feed updates separately from the score snapshot.</p>
          <RecentShieldedTxs nested limit={5} />
          <Link href="/txs?type=shielded" className="inline-flex py-3 mt-3 text-caption font-mono text-secondary hover:text-primary">All shielded transactions →</Link>
        </CardBody></Card>
      </section>
      <section><SectionHeader label="EXPLORE_FURTHER" /><div className="grid sm:grid-cols-3 gap-5">{RELATED.map(item => <Link key={item.href} href={item.href} className="network-related-link block rounded-lg border border-cipher-border p-5"><span className="flex justify-between gap-3 text-sm font-mono text-primary">{item.title}<span aria-hidden="true">→</span></span><p className="text-caption text-muted mt-2">{item.description}</p></Link>)}</div></section>
    </>}
  </div>;
}
