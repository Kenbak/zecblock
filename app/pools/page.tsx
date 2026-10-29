'use client';

import Link from 'next/link';
import { PoolCurrencyProvider } from '@/components/pools/PoolCurrency';
import { useApiQuery } from '@/hooks/useApiQuery';
import { PageHeader, SectionHeader } from '@/components/ui';
import { HashLink } from '@/components/ui/HashLink';
import { PoolDistributionChart } from '@/components/network/PoolDistributionChart';
import { FlowVolumeChart } from '@/components/pools/FlowVolumeChart';
import { PoolActivityChart } from '@/components/pools/PoolActivityChart';
import { FlowLegend } from '@/components/pools/FlowLegend';
import {
  PoolOverviewHero,
  PoolOverviewSkeleton,
  type PoolOverviewData,
} from '@/components/pools/PoolOverviewHero';
import { Card, CardBody } from '@/components/ui/Card';
import { DataTable } from '@/components/ui';
import { ShieldFlowBadge } from '@/components/ShieldFlowBadge';

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'supply', label: 'Supply history' },
  { id: 'activity', label: 'Transaction activity' },
  { id: 'flows', label: 'Public flows' },
  { id: 'recent-flows', label: 'Recent transactions' },
  { id: 'methodology', label: 'Data & definitions' },
] as const;

interface RecentFlow {
  txid: string;
  flowType: string;
  amountZec: number | null;
  pool: string;
  blockTime: number;
}

function formatTimeAgo(unixSec: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function RelatedPoolPages() {
  const links = [
    { href: '/turnstile', title: 'Turnstile tracker', description: 'Follow observable activity after ZEC leaves a shielded pool.' },
    { href: '/privacy', title: 'Privacy score', description: 'Explore shielded participation and the inputs to the privacy index.' },
    { href: '/ironwood', title: 'Ironwood migration', description: 'Track migration into the newest shielded pool.' },
    { href: '/network#issuance', title: 'Issuance & halving', description: 'Understand block subsidies and the remaining issuance schedule.' },
  ];
  return <nav aria-label="Related pool analytics" className="mt-10">
    <p className="text-caption font-mono text-muted mb-3">EXPLORE FURTHER</p>
    <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">{links.map(link => <Link key={link.href} href={link.href} className="rounded-lg border border-cipher-border p-4 hover:bg-glass-3 transition-colors">
      <span className="flex justify-between gap-3 text-sm font-mono text-secondary">{link.title}<span aria-hidden="true">→</span></span>
      <span className="block mt-2 text-xs leading-relaxed text-muted">{link.description}</span>
    </Link>)}</div>
  </nav>;
}

function RecentLargeFlows() {
  const { data, loading } = useApiQuery<RecentFlow[]>('/v1/transactions/shielded', { limit: 10, min_zec: 10 });
  const flows = Array.isArray(data) ? data : [];
  const status = loading ? 'loading' : Array.isArray(data) ? 'ready' : 'unavailable';

  return (
    <Card variant="glass">
      <CardBody>
        <SectionHeader
          label="RECENT_PUBLIC_FLOWS"
          actions={
            <Link
              href="/txs?type=shielded"
              className="inline-flex items-center gap-2 rounded-sm py-1 text-caption font-mono text-secondary underline-offset-4 transition-colors hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-current"
            >
              View all shielded transactions <span aria-hidden="true">→</span>
            </Link>
          }
        />
        <p className="mb-5 text-xs leading-relaxed text-muted">Latest indexed shielding and deshielding flows of at least 10 ZEC. Fully shielded amounts are private and are not included.</p>
        <DataTable
          loading={status === 'loading'}
          skeletonRows={10}
          empty={<p className="p-6 text-xs text-muted" role="status">{status === 'unavailable' ? 'Recent public-flow data is temporarily unavailable.' : 'No matching public flows are available.'}</p>}
          bare
          columns={[
            { id: 'txid', header: 'Transaction', cell: (f: RecentFlow) => <HashLink value={f.txid} responsive copy={false} href={`/tx/${f.txid}`} /> },
            {
              id: 'type',
              header: 'Type',
              cell: (f: RecentFlow) => (
                f.flowType === 'shield' || f.flowType === 'deshield' ? <ShieldFlowBadge type={f.flowType === 'shield' ? 'shielding' : 'unshielding'} variant="full" /> : <span className="text-muted">{f.flowType || 'Unknown'}</span>
              ),
            },
            {
              id: 'pool',
              header: 'Pool',
              cell: (f) => <span className="font-mono text-xs text-muted capitalize">{f.pool}</span>,
            },
            {
              id: 'amount',
              header: 'Amount',
              align: 'right',
              cell: (f) => (
                <span className="font-mono text-xs tabular-nums text-primary">
                  {f.amountZec != null && Number.isFinite(f.amountZec) ? `${f.amountZec.toLocaleString(undefined, { maximumFractionDigits: 2 })} ZEC` : '—'}
                </span>
              ),
            },
            {
              id: 'time',
              header: 'Time',
              align: 'right',
              cell: (f) => (
                <span className="font-mono text-xs text-muted">
                  {f.blockTime ? formatTimeAgo(f.blockTime) : '—'}
                </span>
              ),
            },
          ]}
          rows={flows}
          rowKey={(f, i) => `${f.txid}-${i}`}
        />
        <FlowLegend className="mt-4 border-t border-glass-4 pt-4" />
      </CardBody>
    </Card>
  );
}

export default function PoolsPage() {
  const { data: overview, loading } = useApiQuery<PoolOverviewData>('/v1/shielded-pools/overview');
  const overviewStatus = loading ? 'loading' : overview?.current ? 'ready' : 'unavailable';

  return (
    <PoolCurrencyProvider><div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <PageHeader
        eyebrow="POOL_ANALYTICS"
        title="Zcash Shielded Pools"
        subtitle="Supply held in shielded pools, transaction activity, and the public flows moving ZEC in and out."
      />

      <nav aria-label="Pool analytics sections" className="flex flex-wrap items-center gap-x-5 gap-y-3 text-caption font-mono text-muted border-b border-cipher-border pb-5 mb-8">
        {SECTIONS.map(section => <a key={section.id} href={`#${section.id}`} className="hover:text-primary">{section.label}</a>)}
      </nav>

      <section id="overview" className="scroll-mt-56 sm:scroll-mt-36 mb-14">
        {overviewStatus === 'loading' ? (
          <PoolOverviewSkeleton />
        ) : overviewStatus === 'ready' && overview ? (
          <PoolOverviewHero data={overview} />
        ) : (
          <Card variant="glass">
            <CardBody>
              <p className="py-12 text-center text-xs text-muted font-mono" role="status">
                Shielded-pool overview data is temporarily unavailable.
              </p>
            </CardBody>
          </Card>
        )}
      </section>

      <section id="supply" className="scroll-mt-56 sm:scroll-mt-36 mb-14">
        <PoolDistributionChart />
      </section>

      <section id="activity" className="scroll-mt-56 sm:scroll-mt-36 mb-14">
        <PoolActivityChart />
      </section>

      <section id="flows" className="scroll-mt-56 sm:scroll-mt-36 mb-14">
        <FlowVolumeChart />
      </section>

      <section id="recent-flows" className="scroll-mt-56 sm:scroll-mt-36 mb-14">
        <RecentLargeFlows />
      </section>

      <section id="methodology" className="scroll-mt-56 sm:scroll-mt-36">
        <details className="group rounded-lg border border-cipher-border overflow-hidden">
          <summary className="list-none cursor-pointer flex items-center justify-between gap-4 p-5 sm:p-6 hover:bg-glass-3">
            <span><span className="block text-sm font-mono text-primary">Data &amp; definitions</span><span className="block mt-2 text-xs text-muted">Supply denominators, snapshot coverage and what public flows can show.</span></span>
            <span className="text-muted group-open:rotate-90 transition-transform" aria-hidden="true">›</span>
          </summary>
          <div className="grid sm:grid-cols-2 gap-6 p-5 sm:p-6 border-t border-cipher-border text-xs leading-relaxed text-secondary">
            <div><h3 className="font-mono text-primary mb-2">Supply &amp; percentages</h3><p>The overview uses the latest indexed pool statistics. The map compares balances with the 21 million ZEC cap; the summary compares shielded balances with issued chain supply. Each pool’s legend percentage uses total shielded supply.</p><p className="mt-3">On mainnet, the ZEC/USD controls convert pool balances at the current ZEC quote, including historical snapshots. Unmined ZEC is not issued and is never assigned a USD value. They do not use historical exchange rates. Percentages and map proportions stay based on ZEC; public-flow charts and transaction amounts remain in ZEC. Quotes refresh every 30 seconds; USD is unavailable when the quote is missing or older than five minutes.</p><p className="mt-3">Public supply groups transparent balances with other issued value, including the separate deferred-development lockbox. Other issued is chain supply minus transparent and shielded balances; historical snapshots do not store a separate lockbox balance. Remaining issuance is the cap minus chain supply. The three map segments partition the 21 million ZEC cap.</p></div>
            <div><h3 className="font-mono text-primary mb-2">History &amp; public flows</h3><p>The timeline uses recorded daily snapshots with a supply total and pool breakdown. Gaps are skipped; the latest snapshot is separate from daily history. Dates are shown in UTC. Mainnet activation markers jump to the first available daily snapshot on or after the activation block.</p><p className="mt-3">Shielding and deshielding show public value entering and leaving pools. Net flow is inflow minus outflow; it is not a count of users or a measure of individual privacy. Pool balance changes can also include issuance and migrations. Fully shielded transfer amounts remain hidden.</p></div>
          </div>
        </details>
      </section>
      <RelatedPoolPages />
    </div></PoolCurrencyProvider>
  );
}
