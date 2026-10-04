'use client';

import { useEffect, useState, lazy, Suspense } from 'react';
import Link from 'next/link';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useApiQuery } from '@/hooks/useApiQuery';
import { Card, CardBody } from '@/components/ui/Card';
import { PageHeader, SectionHeader } from '@/components/ui/SectionHeader';
import { isCrosslink, NETWORK, CURRENCY } from '@/lib/config';
import { readUpgradeSnapshot } from '@/lib/network-upgrades';
import type { HashrateSnapshot } from '@/lib/hashrate';
import { blockAgeLabel, observationStatus } from '@/lib/network-overview';
import type { HalvingInfo } from '@/components/network/HalvingPanel';
import type { EmissionResponse } from '@/lib/issuance-curve';
import { MiningIssuance } from '@/components/network/MiningIssuance';
import { NetworkSectionNav } from '@/components/network/NetworkSectionNav';
import { NetworkAccounting } from '@/components/network/NetworkAccounting';
import { BlockTimeChart } from '@/components/network/BlockTimeChart';
import { BlockCadenceChart } from '@/components/network/BlockCadenceChart';
import { FeeDistributionChart, type FeeDistributionResponse } from '@/components/network/FeeDistributionChart';
import type { NodeLocationsResponse, NodeStatsResponse } from '@/components/NodeMap';
import type { RecentBlocksResponse } from '@/components/network/RecentBlocksTable';
const NodeMap = lazy(() => import('@/components/NodeMap'));
const BlockActivityChart = lazy(() => import('@/components/BlockActivityChart').then(m => ({ default: m.BlockActivityChart })));
const NetworkHistoryCharts = lazy(() => import('@/components/network/NetworkHistoryCharts').then(m => ({ default: m.NetworkHistoryCharts })));
const ProtocolStatsChart = lazy(() => import('@/components/network/ProtocolStatsChart').then(m => ({ default: m.ProtocolStatsChart })));

export interface NetworkStats {
  success: boolean;
  mining: {
    networkHashrate: string;
    networkHashrateRaw: number | null;
    hashrateEstimate?: HashrateSnapshot;
    difficulty: number;
    avgBlockTime: number | null;
    targetBlockTime?: number | null;
    blocks24h: number;
    blockReward: number | null;
    minerReward: number | null;
    fundingStreams: number;
    lockbox: number;
    dailyRevenue: number | null;
    dailyMinerRevenue: number | null;
  };
  network: {
    peers: number;
    height: number;
    protocolVersion: number;
    subversion: string;
  };
  blockchain: {
    height: number;
    latestBlockTime: number;
    syncProgress: number;
    sizeBytes: number;
    sizeGB: number;
    tx24h: number;
    tx24hExclCoinbase?: number;
  };
  supply?: {
    chainSupply: number;
    transparent: number;
    sprout: number;
    sapling: number;
    orchard: number;
    ironwood: number;
    lockbox: number;
    totalShielded: number;
    shieldedPercentage: number;
    sizeOnDisk: number;
    activeUpgrade: string | null;
    chain: string;
  };
  cached?: boolean;
  cacheAge?: number;
}

export interface HealthStatus {
  success: boolean;
  zebra: {
    healthy: boolean;
    ready: boolean;
  };
}


export interface NetworkPageInitialData {
  fetchedAt: number;
  stats: NetworkStats | null;
  health: HealthStatus | null;
  nodeLocations: NodeLocationsResponse | null;
  nodeStats: NodeStatsResponse | null;
  recentBlocks: RecentBlocksResponse | null;
  feeDistribution: FeeDistributionResponse | null;
  halving?: HalvingInfo | null;
  emission?: EmissionResponse | null;
}

export default function NetworkClient({ initialData }: { initialData: NetworkPageInitialData }) {
  const statsQuery = useApiQuery<NetworkStats>('/v1/network/stats', undefined, {
    refreshInterval: 60_000, initialData: initialData.stats ?? undefined, initialFetchedAt: initialData.fetchedAt,
  });
  const healthQuery = useApiQuery<HealthStatus>('/v1/network/health', undefined, {
    refreshInterval: 60_000, initialData: initialData.health ?? undefined, initialFetchedAt: initialData.fetchedAt,
  });
  const [streamStats, setStreamStats] = useState<NetworkStats | null>(null);
  const [now, setNow] = useState(initialData.fetchedAt);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const stats = streamStats ?? (statsQuery.data ? statsQuery.data : null);
  useWebSocket({ onMessage: message => {
    if (message.type === 'network_stats' && message.data?.success && message.data?.blockchain) setStreamStats(message.data);
  }});
  useEffect(() => { setStreamStats(null); }, [statsQuery.data]);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const reveal = () => {
      if (['#network-technical', '#chain-size', '#protocol-growth'].includes(window.location.hash)) setTechnicalOpen(true);
    };
    reveal();
    window.addEventListener('hashchange', reveal);
    return () => window.removeEventListener('hashchange', reveal);
  }, []);
  useEffect(() => {
    if (!technicalOpen) return;
    const id = window.location.hash.slice(1);
    if (['network-technical', 'chain-size', 'protocol-growth'].includes(id)) {
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
    }
  }, [technicalOpen]);
  const height = stats?.blockchain.height ?? stats?.network.height;
  const upgrade = readUpgradeSnapshot(stats, NETWORK === 'crosslink' ? 'crosslink-testnet' : NETWORK);
  const nu7Active = upgrade?.schedule.nu7Height != null && upgrade.height >= upgrade.schedule.nu7Height;
  const txCount = stats?.blockchain.tx24hExclCoinbase ?? stats?.blockchain.tx24h;
  const nodeStatus = observationStatus(healthQuery.error ? null : healthQuery.data?.zebra);

  return (
    <div className="network-page max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <PageHeader eyebrow="NETWORK_STATUS" title="Zcash Network"
        subtitle="Protocol, issuance, block production and the nodes we observe." />
      <NetworkSectionNav nu7Active={nu7Active} onTechnicalNavigate={() => setTechnicalOpen(true)} />
      <section className="network-section mb-10" aria-label="Network overview">
        <Card className="network-summary-panel card-static">
          <dl id="network-protocol" className="network-section network-summary-grid network-protocol-facts border-b border-cipher-border" aria-label="Protocol parameters">
            {[
              ['Active upgrade', stats?.supply?.activeUpgrade ?? '—'],
              ['Block subsidy', stats?.mining.blockReward != null ? `${stats.mining.blockReward} ${CURRENCY}` : '—'],
              ['Maximum supply', `21,000,000 ${CURRENCY}`],
            ].map(([label, value]) => <div key={label}>
              <dt className="type-label text-muted uppercase">{label}</dt>
              <dd className="font-mono text-sm text-secondary tabular-nums">{value}</dd>
            </div>)}
          </dl>
          <dl id="network-overview" className="network-section network-summary-grid network-live-facts" aria-label="Current chain activity">
            {[
              { label: 'Latest block', value: height != null ? <Link href={`/block/${height}`} className="hover:text-cipher-gold">{height.toLocaleString()}</Link> : '—', hint: stats ? `Block timestamp · ${blockAgeLabel(stats.blockchain.latestBlockTime, now)}` : 'Awaiting chain data' },
              { label: 'Average block interval', value: stats?.mining.avgBlockTime != null ? `${stats.mining.avgBlockTime.toFixed(1)}s` : '—', hint: stats?.mining.targetBlockTime != null ? `Observed · protocol target ${stats.mining.targetBlockTime}s` : 'Observed · protocol target unavailable' },
              { label: 'Transactions · 24h', value: txCount?.toLocaleString() ?? '—', hint: stats?.blockchain.tx24hExclCoinbase != null ? 'Confirmed · coinbase excluded' : 'Confirmed · includes coinbase' },
              { label: 'Estimated hashrate · 24h', value: stats?.mining.hashrateEstimate ? stats.mining.networkHashrate : '—', hint: <Link href="/mining#metrics" className="hover:text-primary underline underline-offset-4">Trailing 24-hour estimate →</Link> },
            ].map(({ label, value, hint }) => <div key={label}>
              <dt className="type-label text-muted uppercase mb-2">{label}</dt>
              <dd><div className="type-metric text-primary">{value}</div><p className="text-caption text-muted mt-2">{hint}</p></dd>
            </div>)}
          </dl>
          {statsQuery.error && <p role="status" className="text-caption text-warning border-t border-cipher-border px-5 py-3">Network summary could not refresh. {stats ? 'Last received values are shown.' : 'Other observations remain available below.'}</p>}
        </Card>
      </section>

      <section id="network-nodes" className="network-section mb-10" aria-label="Observed node distribution">
        <Suspense fallback={<div className="card h-80 flex items-center justify-center text-muted text-sm">Loading node observations…</div>}>
          {isCrosslink ? <BlockActivityChart limit={80} /> : <NodeMap initialFetchedAt={initialData.fetchedAt} initialLocations={initialData.nodeLocations} initialStats={initialData.nodeStats} />}
        </Suspense>
      </section>

      <section id="network-activity" className="network-section mb-10" aria-label="Block cadence and observed fees">
        <SectionHeader label="ACTIVITY" />
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 items-stretch">
          <BlockCadenceChart initialData={initialData.recentBlocks} initialFetchedAt={initialData.fetchedAt} chainHeight={height} now={now} targetSeconds={stats?.mining.targetBlockTime ?? null} />
          <div id="network-fees" className="network-section h-full"><FeeDistributionChart initialFetchedAt={initialData.fetchedAt} initialData={initialData.feeDistribution} /></div>
        </div>
      </section>

      {!isCrosslink && <section id="network-accounting" className="network-section mb-10" aria-label="Block timing and active network accounting">
        <BlockTimeChart />
        <NetworkAccounting />
      </section>}
      <MiningIssuance initialHalving={initialData.halving} initialEmission={initialData.emission} initialFetchedAt={initialData.fetchedAt} />
      <Card className="network-detail-panel card-static">
        <details id="network-technical" className="network-section network-detail-disclosure" open={technicalOpen} onToggle={event => setTechnicalOpen(event.currentTarget.open)}>
          <summary className="network-detail-toggle">
            <span>
              <span className="block font-mono text-sm font-semibold text-primary">technical_details</span>
              <span className="block text-caption text-muted mt-1">Node software, storage and shielded protocol growth.</span>
            </span>
            <svg className="network-detail-chevron w-4 h-4 shrink-0 text-muted" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" /></svg>
          </summary>
          {technicalOpen && <div className="p-4 sm:p-6 space-y-5">
            <Card><CardBody>
              <SectionHeader label="EXPLORER_NODE" />
              <p className="text-caption text-muted mb-4">This is one observation point, not a network-wide health verdict.</p>
              <dl className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm font-mono">
                <div><dt className="text-caption text-muted">Node readiness</dt><dd className={nodeStatus === 'Ready' ? 'text-cipher-green' : nodeStatus === 'Unavailable' ? 'text-muted' : 'text-warning'}>{nodeStatus}</dd></div>
                <div><dt className="text-caption text-muted">Connected peers</dt><dd>{stats?.network.peers ?? '—'}</dd></div>
                <div><dt className="text-caption text-muted">Reported software</dt><dd className="break-all">{stats?.network.subversion?.replace(/^\/|\/$/g, '') ?? '—'}</dd></div>
                <div><dt className="text-caption text-muted">Node disk usage</dt><dd>{stats ? `${stats.blockchain.sizeGB.toFixed(2)} GiB` : '—'}</dd></div>
              </dl>
            </CardBody></Card>
            <Suspense fallback={<p className="text-muted text-sm">Loading technical charts…</p>}>
              <div id="chain-size" className="network-section"><NetworkHistoryCharts /></div>
              <div id="protocol-growth" className="network-section"><ProtocolStatsChart /></div>
            </Suspense>
          </div>}
        </details>
      </Card>
      <nav aria-labelledby="network-related-heading" className="mt-8">
        <h2 id="network-related-heading" className="type-label text-muted uppercase mb-3">Explore further</h2>
        <div className={`network-related-links${isCrosslink ? '' : ' network-related-links--four'}`}>
          {[
            { href: '/mining#metrics', title: 'Mining', description: 'Hashrate, pools and miner rewards' },
            { href: '/pools#supply', title: 'Shielded pools', description: 'Supply distribution and pool flows' },
            { href: '/rich-list#transparent-breakdown', title: 'Transparent balances', description: 'Address categories and script types' },
            ...(!isCrosslink ? [{ href: '/network/attestations', title: 'Indexer attestations', description: 'Zero Indexer enclave and software checks' }] : []),
          ].map(({ href, title, description }) => <Link key={href} href={href} className="network-related-link">
            <span className="flex items-baseline justify-between gap-3 font-mono text-sm text-secondary"><span>{title}</span><span aria-hidden="true" className="text-muted">→</span></span>
            <span className="block text-caption text-muted mt-1">{description}</span>
          </Link>)}
        </div>
      </nav>
    </div>
  );
}
