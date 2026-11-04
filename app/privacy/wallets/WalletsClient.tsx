'use client';
import { formatDateLabelUTC } from '@/lib/utils';
import { CHART_DATE_AXIS } from '@/lib/chart-theme';
import { ChartWatermark } from '@/components/ChartWatermark';
import { PageLoadingBody } from '@/components/ui/PageLoading';

import { useState } from 'react';
import Link from 'next/link';
import { useApiQuery } from '@/hooks/useApiQuery';
import {
  AreaChart, Area,
  XAxis, YAxis, CartesianGrid,
  ResponsiveContainer, Legend,
} from 'recharts';
import { ChartTooltip as RechartsTooltip } from '@/components/charts/ChartTooltip';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { Card, CardBody } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/SectionHeader';
import { PageSectionNav } from '@/components/PageSectionNav';
import { useUrlState } from '@/lib/use-url-state';

const SECTIONS = [
  { id: 'fee-lanes', label: 'Fee Lanes' },
  { id: 'usage', label: 'Pattern matches' },
  { id: 'fingerprints', label: 'Wallet signals' },
  { id: 'methodology', label: 'Methodology' },
] as const;

const PERIODS = ['7d', '30d', '90d', '1y'] as const;
type Period = (typeof PERIODS)[number];

interface FeeLaneData {
  period: string;
  totalShieldedTxs: number;
  buckets: {
    standard: { count: number; pct: number };
    priority: { count: number; pct: number };
    non_standard: { count: number; pct: number };
  };
  history: { date: string; standard: number; priority: number; non_standard: number }[];
}

interface WalletSignal {
  value: string;
  confidence: 'high' | 'medium' | 'low';
  source: string;
  matchCount?: number;
}

interface WalletFingerprint {
  name: string;
  description?: string;
  note?: string;
  familyMembers?: string[];
  nym?: 'supported' | 'partial' | 'none';
  nymNote?: string;
  signals: {
    fee: WalletSignal;
    expiry: WalletSignal;
    locktime: WalletSignal;
    actionPadding: WalletSignal;
  };
}

interface FingerprintData {
  period: string;
  totalShielded: number;
  totalFullyShieldedOrchard: number;
  wallets: WalletFingerprint[];
}

const formatDate = formatDateLabelUTC;

const formatNumber = (n: number) => n.toLocaleString();

export default function WalletsClient() {
  const { theme } = useTheme();
  const colors = getChartColors(theme as 'dark' | 'light');
  const [period, setPeriod] = useUrlState<Period>('period', '30d', PERIODS);
  const feeQuery = useApiQuery<FeeLaneData>('/v1/privacy/fee-lanes', { period });
  const fingerprintQuery = useApiQuery<FingerprintData>('/v1/privacy/wallet-fingerprints', { period });
  const feeLanes = feeQuery.data?.period===period && feeQuery.data.buckets ? feeQuery.data : null;
  const fingerprints = fingerprintQuery.data?.period===period && Array.isArray(fingerprintQuery.data.wallets) ? fingerprintQuery.data : null;
  const loading = feeQuery.loading || fingerprintQuery.loading || feeQuery.isRefreshing || fingerprintQuery.isRefreshing;
  const error = feeQuery.error && fingerprintQuery.error ? 'Wallet analysis is temporarily unavailable.' : null;
  const usageData = buildUsageEstimates(fingerprints);

  if (loading && !feeLanes) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
        <PageHeader eyebrow="WALLET_ANALYSIS" title="Zcash Wallet Signals" subtitle="Fee patterns, observable wallet signals and their limits. Matches describe transaction behavior, not identified users." />
        <PageLoadingBody layout="wallets" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
        <h1 className="type-page mb-4">Zcash Wallet Signals</h1>
        <Card variant="standard">
          <CardBody>
            <p className="text-danger">{error}</p>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <PageHeader
        eyebrow="WALLET_ANALYSIS"
        title="Zcash Wallet Signals"
        subtitle="Fee patterns, observable wallet signals and their limits. Matches describe transaction behavior, not identified users."
        actions={
          <div className="filter-group">
            {PERIODS.map(p => (
              <button
                key={p}
                aria-pressed={period === p}
                onClick={() => setPeriod(p)}
                className={`filter-btn ${period === p ? 'filter-btn-active' : ''}`}
              >
                {p}
              </button>
            ))}
          </div>
        }
      />

      <PageSectionNav sections={SECTIONS} ariaLabel="Wallet analysis sections" />

      {/* ================================================================ */}
      {/* COMPONENT 1: FEE LANE ANONYMITY BUCKETS                         */}
      {/* ================================================================ */}
      <section id="fee-lanes" className="mb-12 scroll-mt-[calc(var(--app-nav-height,4rem)+var(--app-stats-height,2.75rem)+var(--app-ironwood-height,0px)+1.5rem)]">
        <h2 className="type-section text-primary mb-3">Fee patterns</h2>
        <p className="text-sm text-secondary mb-6">
          Compare fee patterns across observed shielded transactions. The ZIP-317 standard rate is 5,000 zat per logical action.
        </p>

        {feeLanes && (
          <>
            <FeeDistribution data={feeLanes} period={period} />

            {/* Stacked area chart */}
            <Card variant="standard" className="mb-6">
              <CardBody>
                <h3 className="text-sm font-medium text-secondary mb-4">
                  Fee patterns over time
                </h3>
                <p className="text-xs text-muted mb-3">
                  {feeLanes.history.length ? `Latest observation: ${feeLanes.history.map(row => row.date).sort().at(-1)?.slice(0, 10)} (UTC). Daily samples; today may be incomplete.` : 'Fee history unavailable.'}
                </p>
                <><ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={300}>
                  <AreaChart data={feeLanes.history} margin={{ right: 16, left: 0 }}>
                    <CartesianGrid strokeDasharray="2 6" stroke={colors.grid} opacity={0.5} />
                    <XAxis
                      dataKey="date"
                      {...CHART_DATE_AXIS}
                      stroke={colors.axis}
                      tickFormatter={formatDate}
                      tick={{ fontSize: 12 }}
                    />
                    <YAxis
                      stroke={colors.axis}
                      tick={{ fontSize: 12 }}
                      tickFormatter={(v: number) => v > 999 ? `${(v / 1000).toFixed(1)}k` : String(v)}
                    />
                    <RechartsTooltip
                      contentStyle={{
                        backgroundColor: colors.tooltipBg,
                        border: `1px solid ${colors.tooltipBorder}`,
                        borderRadius: 8,
                        color: colors.tooltipText,
                        fontSize: 12,
                      }}
                      labelFormatter={(label) => formatDate(String(label))}
                    />
                    <Area
                      type="monotone"
                      dataKey="standard"
                      stackId="1"
                      stroke={colors.shielding}
                      fill={colors.shielding}
                      fillOpacity={0.6}
                      name="Standard"
                    />
                    <Area
                      type="monotone"
                      dataKey="priority"
                      stackId="1"
                      stroke={colors.gold}
                      fill={colors.gold}
                      fillOpacity={0.6}
                      name="Priority"
                    />
                    <Area
                      type="monotone"
                      dataKey="non_standard"
                      stackId="1"
                      stroke={colors.deshielding}
                      fill={colors.deshielding}
                      fillOpacity={0.6}
                      name="Non-Standard"
                    />
                    <Legend />
                  </AreaChart>
                </ResponsiveContainer><ChartWatermark /></>
              </CardBody>
            </Card>

          </>
        )}
      </section>

      {/* ================================================================ */}
      {/* COMPONENT 2: WALLET FINGERPRINTING MATRIX                       */}
      {/* ================================================================ */}


      {/* ================================================================ */}
      {/* COMPONENT 3: WALLET USAGE DISTRIBUTION                          */}
      {/* ================================================================ */}
      <section id="usage" className="mb-12 scroll-mt-[calc(var(--app-nav-height,4rem)+var(--app-stats-height,2.75rem)+var(--app-ironwood-height,0px)+1.5rem)]">
        <h2 className="type-section text-primary mb-3">Observed pattern matches</h2>
        <p className="text-sm text-secondary mb-6">
          Counts of transactions matching known implementation patterns. These are not counts of users or verified wallet market shares; patterns can overlap.
        </p>

        {usageData && fingerprints && (
          <div className="rounded-lg border border-cipher-border overflow-hidden">
            <dl className="grid sm:grid-cols-3 border-b border-cipher-border bg-glass-3 divide-y sm:divide-y-0 sm:divide-x divide-cipher-border">
              {[
                { label: `Shielded transactions · ${period}`, value: fingerprints.totalShielded },
                { label: 'Fully-shielded Orchard', value: fingerprints.totalFullyShieldedOrchard },
                { label: 'Pattern matches · may overlap', value: usageData.reduce((sum, entry) => sum + entry.value, 0) },
              ].map(stat => (
                <div key={stat.label} className="px-4 py-4 sm:px-5">
                  <dt className="text-caption text-muted">{stat.label}</dt>
                  <dd className="mt-1 text-xl sm:text-2xl font-mono tabular-nums text-primary">{formatNumber(stat.value)}</dd>
                </div>
              ))}
            </dl>
            <div className="px-4 sm:px-5">
              <div aria-hidden="true" className="hidden sm:grid grid-cols-[minmax(0,1fr)_6rem_6rem] gap-6 py-3 border-b border-cipher-border text-caption font-mono uppercase text-muted">
                <span>Pattern</span><span>Confidence</span><span className="text-right">Matches</span>
              </div>
              <ul aria-label="Observed wallet pattern matches" className="divide-y divide-cipher-border">
                {usageData.map(entry => (
                  <li key={entry.name} className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_6rem_6rem] gap-x-4 sm:gap-x-6 gap-y-2 py-3 items-center">
                    <div className="min-w-0">
                      <p className="text-sm text-primary">{entry.name}</p>
                      <div aria-hidden="true" className="h-1 rounded-full bg-glass-6 overflow-hidden mt-2">
                        <div className="h-full rounded-full bg-cipher-blue" style={{ width: `${Math.min(100, fingerprints.totalShielded ? entry.value / fingerprints.totalShielded * 100 : 0)}%` }} />
                      </div>
                    </div>
                    <span className="text-caption text-muted col-start-1 row-start-2 sm:col-auto sm:row-auto"><span className="capitalize">{entry.confidence}</span><span className="sm:sr-only"> confidence</span></span>
                    <span className="text-sm font-mono tabular-nums text-primary text-right col-start-2 row-start-1 sm:col-auto sm:row-auto">{formatNumber(entry.value)}</span>
                  </li>
                ))}
              </ul>
              {usageData.length === 0 && <p className="py-5 text-sm text-muted">No matching patterns in this period.</p>}
              <p className="text-caption text-muted py-3 border-t border-cipher-border">Bar lengths compare each pattern with all observed shielded transactions. Matches can overlap.</p>
            </div>
            <details className="border-t border-cipher-border px-4 sm:px-5">
              <summary className="min-h-11 py-3 cursor-pointer text-sm text-secondary">What these matches can tell us</summary>
              <ul className="list-disc pl-4 pb-4 space-y-1 text-caption text-muted leading-relaxed">
                <li>Shared SDK patterns cannot distinguish individual wallet apps.</li>
                <li>Sapling-only transactions have no Orchard action count to compare.</li>
                <li>Disabled expiry, missing data and unrecognized implementations limit matching.</li>
              </ul>
            </details>
          </div>
        )}
      </section>

      <section id="fingerprints" className="mb-12 scroll-mt-[calc(var(--app-nav-height,4rem)+var(--app-stats-height,2.75rem)+var(--app-ironwood-height,0px)+1.5rem)]">
        <h2 className="type-section text-primary mb-3">Wallet implementation signals</h2>
        <p className="text-sm text-secondary mb-6">
          Some wallets share the same transaction patterns. Expand a wallet family to inspect evidence and confidence.
        </p>

        {fingerprints && (
          <div className="rounded-lg border border-cipher-border overflow-hidden divide-y divide-cipher-border">
            {fingerprints.wallets.map(wallet => <WalletCard key={wallet.name} wallet={wallet} />)}
          </div>
        )}
      </section>
      <section id="methodology" className="scroll-mt-[calc(var(--app-nav-height,4rem)+var(--app-stats-height,2.75rem)+var(--app-ironwood-height,0px)+1.5rem)] mb-8"><MethodologyAccordion /></section>
      <nav aria-label="Related wallet analysis" className="grid sm:grid-cols-3 gap-3">{[{href:"/privacy",label:"Privacy participation"},{href:"/pools",label:"Shielded supply"},{href:"/tools/decode",label:"Decode a transaction"}].map(l=><Link key={l.href} href={l.href} className="border border-cipher-border rounded-lg p-4 text-xs font-mono text-secondary hover:bg-glass-3">{l.label} →</Link>)}</nav>
    </div>
  );
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

const FEE_CATEGORIES = [
  { key: 'standard', label: 'Standard', rate: '5,000 zat / action', color: 'bg-cipher-green' },
  { key: 'priority', label: 'Priority · 4×', rate: '20,000 zat / action', color: 'bg-cipher-gold' },
  { key: 'non_standard', label: 'Non-standard', rate: 'Other fee patterns', color: 'bg-cipher-orange' },
] as const;

function FeeDistribution({ data, period }: { data: FeeLaneData; period: Period }) {
  const categories = FEE_CATEGORIES.map(category => {
    const count = data.buckets[category.key].count;
    const share = data.totalShieldedTxs > 0 ? count / data.totalShieldedTxs * 100 : 0;
    const label = data.totalShieldedTxs === 0 ? '—' : count === 0 ? '0%' : share < 0.1 ? '<0.1%' : `${share.toFixed(1)}%`;
    return { ...category, count, share, shareLabel: label };
  });

  return (
    <div className="rounded-lg border border-cipher-border mb-6 overflow-hidden">
      <div className="px-4 pt-4 sm:px-5 sm:pt-5">
        <div className="flex flex-wrap justify-between items-baseline gap-2 mb-4">
          <h3 className="text-sm font-medium text-primary">Fee distribution</h3>
          <p className="text-caption text-muted">{formatNumber(data.totalShieldedTxs)} shielded transactions · {period}</p>
        </div>
        <div aria-hidden="true" className="flex h-2 overflow-hidden rounded-full bg-glass-6">
          {categories.map(category => <div key={category.key} className={`h-full shrink-0 ${category.color}`} style={{ width: `${category.share}%` }} />)}
        </div>
      </div>
      <dl className="grid sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-cipher-border mt-4">
        {categories.map(category => (
          <div key={category.key} className="px-4 py-4 sm:px-5 grid grid-cols-[1fr_auto] sm:block gap-x-4">
            <dt className="text-sm text-secondary flex items-center gap-2">
              <span aria-hidden="true" className={`w-2 h-2 rounded-sm shrink-0 ${category.color}`} />{category.label}
            </dt>
            <dd className="text-2xl font-mono tabular-nums text-primary sm:mt-2 row-span-2 text-right sm:text-left">{category.shareLabel}</dd>
            <dd className="text-caption text-muted mt-1">{formatNumber(category.count)} transactions</dd>
            <dd className="text-caption text-muted mt-1 col-span-2">{category.rate}</dd>
          </div>
        ))}
      </dl>
      <p className="border-t border-cipher-border px-4 py-3 sm:px-5 text-caption text-muted leading-relaxed">
        Shared fees do not identify a wallet or measure an anonymity set.
      </p>
    </div>
  );
}

const SIGNAL_LABELS: Record<keyof WalletFingerprint['signals'], string> = {
  fee: 'Fee', expiry: 'Expiry', locktime: 'Lock time', actionPadding: 'Padding',
};
const CONFIDENCE_LABELS = { high: 'Confirmed', medium: 'Inferred', low: 'Unknown' };

function WalletCard({ wallet }: { wallet: WalletFingerprint }) {
  const signals = Object.entries(wallet.signals) as [keyof WalletFingerprint['signals'], WalletSignal][];
  return (
    <details className="group">
      <summary className="list-none cursor-pointer px-4 py-4 sm:px-5 hover:bg-glass-3 transition-colors [&::-webkit-details-marker]:hidden">
        <div className="flex items-start gap-3">
          <svg aria-hidden="true" className="w-4 h-4 mt-0.5 shrink-0 text-muted transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7" strokeWidth="1.5" /></svg>
          <div className="grid min-w-0 flex-1 gap-3 lg:grid-cols-[minmax(12rem,1.1fr)_2fr] lg:gap-6">
            <div>
              <span className="text-sm font-medium text-primary">{wallet.name}</span>
              {wallet.nym && wallet.nym !== 'none' && <span className="block mt-1 text-caption text-muted">{wallet.nym === 'supported' ? 'Nym supported' : 'Nym · partial support'}</span>}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
              {signals.map(([key, signal]) => (
                <div key={key} className="min-w-0">
                  <span className="block text-caption text-muted mb-1">{SIGNAL_LABELS[key]}</span>
                  <span className="block text-caption font-mono text-secondary break-words">{signal.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </summary>
      <div className="px-4 sm:px-5 pb-5 border-t border-cipher-border pt-4">
        {wallet.description && <p className="text-sm text-secondary mb-3 leading-relaxed">{wallet.description}</p>}
        {!!wallet.familyMembers?.length && <p className="text-caption text-muted mb-3"><span className="text-secondary">Includes:</span> {wallet.familyMembers.join(' · ')}</p>}
        {wallet.nymNote && <p className="text-caption text-muted mb-3"><span className="text-secondary">Nym:</span> {wallet.nymNote}</p>}
        {wallet.note && <p className="text-caption text-muted mb-3 leading-relaxed">{wallet.note}</p>}
        <dl className="divide-y divide-cipher-border">
          {signals.map(([key, signal]) => (
            <div key={key} className="grid gap-2 sm:grid-cols-[6rem_7rem_minmax(0,1fr)] py-3">
              <dt className="text-caption font-medium text-primary">{SIGNAL_LABELS[key]}</dt>
              <dd className="text-caption text-secondary">{CONFIDENCE_LABELS[signal.confidence]}</dd>
              <dd className="text-caption text-muted leading-relaxed break-words">
                {signal.source}
                {signal.matchCount !== undefined && <span className="block mt-1 font-mono tabular-nums text-secondary">{formatNumber(signal.matchCount)} matches</span>}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}

function MethodologyAccordion() {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-cipher-border overflow-hidden">
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex items-center justify-between w-full text-left px-4 py-4 sm:px-5 hover:bg-glass-3 transition-colors"
        >
          <span className="text-sm font-medium">Methodology</span>
          <svg
            className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {open && (
          <div className="border-t border-cipher-border px-4 py-4 sm:px-5 space-y-3 text-xs text-secondary leading-relaxed">
            <p>
              <strong>On-chain fingerprint matching:</strong> We count transactions matching each
              wallet&apos;s known signature. Signals used: Orchard action count (padding),
              expiry_height delta from block_height, nLockTime value, and fee-per-action rate.
            </p>
            <p>
              <strong>Overlap handling:</strong> Wallets using librustzcash (ZODL, Edge, Unstoppable,
              Vizor) share the same on-chain fingerprint (expiry +40, locktime 0, 2-action padding).
              They are grouped as a single &quot;librustzcash family&quot; bucket because they are
              indistinguishable from one another on-chain.
            </p>
            <p>
              <strong>Brave detection:</strong> Brave&apos;s own C++ implementation uses the old
              zcashd default expiry delta (+20 blocks) and sets nLockTime to the current chain tip.
              Both signals confirmed from brave-core source (PR #32580, #37407).
            </p>
            <p><strong>Limitations:</strong> These matches are implementation clues, not verified wallet identities or user counts. Patterns can overlap and change between releases. Unmatched transactions are not assigned to a fabricated remainder category.</p>
          </div>
        )}
    </div>
  );
}

function buildUsageEstimates(fingerprints: FingerprintData | null) {
  if (!fingerprints) return null;

  const walletMap: { name: string; value: number; confidence: 'high' | 'medium' | 'low' }[] = [];

  const find = (name: string) => fingerprints.wallets.find(w => w.name === name);

  const entries: { name: string; key: string; signal: 'expiry' | 'fee' | 'locktime' | 'actionPadding'; confidence: 'high' | 'medium' | 'low' }[] = [
    { name: 'ZODL / Vizor (Ironwood sends)', key: 'ZODL / Vizor (Ironwood sends)', signal: 'expiry', confidence: 'high' },
    { name: 'ZODL / Vizor (ZIP-318 migration)', key: 'ZODL / Vizor (ZIP-318 migration)', signal: 'expiry', confidence: 'high' },
    { name: 'SDK wallets (cross-pool)', key: 'SDK wallets (cross-pool)', signal: 'expiry', confidence: 'medium' },
    { name: 'SDK wallets (Orchard pool)', key: 'SDK wallets (Orchard pool)', signal: 'actionPadding', confidence: 'medium' },
    { name: 'SDK wallets (shielding/deshielding)', key: 'SDK wallets (shielding/deshielding)', signal: 'expiry', confidence: 'medium' },
    { name: 'Cake Wallet (probable)', key: 'Cake Wallet (probable)', signal: 'expiry', confidence: 'medium' },
    { name: 'Brave', key: 'Brave', signal: 'locktime', confidence: 'medium' },
    { name: 'Nozy', key: 'Nozy', signal: 'fee', confidence: 'high' },
    { name: 'Zkool (historical)', key: 'Zkool (historical)', signal: 'expiry', confidence: 'high' },
  ];

  for (const entry of entries) {
    const wallet = find(entry.key);
    const count = wallet?.signals[entry.signal].matchCount || 0;
    if (count > 0) {
      walletMap.push({ name: entry.name, value: count, confidence: entry.confidence });
    }
  }


  return walletMap;
}
