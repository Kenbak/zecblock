'use client';
import { readApiData } from '@/lib/api-client';
import { SkeletonTable } from '@/components/ui/EmptyState';
import { ChartWatermark } from '@/components/ChartWatermark';
import { ChartCardSkeleton } from '@/components/ui/Skeleton';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { getApiUrl } from '@/lib/api-config';
import { Card, CardBody } from '@/components/ui/Card';
import { PageHeader, SectionHeader } from '@/components/ui/SectionHeader';
import { NodeMapExplorer } from '@/components/network/NodeMapExplorer';
import { clientLabel, clientColor } from '@/lib/network-colors';
import { scoreColor } from '@/components/ui/RadialGauge';
import type { NodeStats } from '@/components/NodeMap';
import { ExportButton } from '@/components/ExportButton';

interface NodeEntry {
  id: number;
  client: string;
  version: string | null;
  protocolVersion: number | null;
  country: string | null;
  countryCode: string | null;
  lat: number | null;
  lon: number | null;
  isTor: boolean;
  torType: string | null;
  pingMs: number | null;
  isActive: boolean;
  firstSeen: string;
  lastSeen: string;
  source: string;
  isp: string | null;
  degree: number | null;
  betweenness: number | null;
  closeness: number | null;
}

interface ClientEntry {
  client: string;
  count: number;
}

interface VersionEntry {
  client: string;
  version: string;
  count: number;
}

function countryFlag(code: string | null): string {
  if (!code || code.length !== 2) return '';
  const codePoints = [...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65);
  return String.fromCodePoint(...codePoints);
}

interface HealthScore {
  healthScore: number | null;
  components: {
    connectivity: { score: number | null; avgDegree: number | null; poorlyConnected: number | null; maxDegree: number | null };
    upgrade: { score: number; latestProtocol: number; adoptionPct: number; latestCount: number };
    clientDiversity: { score: number; topClient: string | null; topClientPct: number; implementations: number };
    geographic: { score: number; countries: number; uniqueSubnets: number };
    reliability: { score: number | null; avgReliabilityPct: number | null; scoredNodes: number };
  };
  totalActive: number;
}

interface Reliability {
  leaderboard: {
    id: number;
    client: string;
    countryCode: string | null;
    country: string | null;
    pingMs: number | null;
    seen: number;
    missed: number;
    reliabilityPct: number | null;
  }[];
  latency: {
    median: number | null;
    measured: number;
    buckets: { label: string; count: number }[];
  };
  services: { known: number; fullNodes: number; fullNodePct: number };
  avgReliabilityPct: number | null;
  maxSeen: number;
}

interface UpgradeReadiness {
  latestProtocol: number;
  referenceUpgrade?: string;
  readinessPct: number | null;
  latestCount: number;
  totalActive: number;
  versions: { protocolVersion: number; nodeCount: number; percentage: number; clients: string[]; isLatest: boolean }[];
}

interface Concentration {
  concentrationRisk: string;
  subnets: { subnet: string; nodeCount: number; clients: string[] }[];
  isps: { isp: string; nodeCount: number; percentage: number }[];
  highDegreeNodes: number | null;
  maxDegree: number | null;
}

export default function NodesClient() {
  const [nodes, setNodes] = useState<NodeEntry[]>([]);
  const [stats, setStats] = useState<NodeStats | null>(null);
  const [clients, setClients] = useState<ClientEntry[]>([]);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [versionClient, setVersionClient] = useState('all');
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [sortBy, setSortBy] = useState('last_seen');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const [health, setHealth] = useState<HealthScore | null>(null);
  const [reliability, setReliability] = useState<Reliability | null>(null);
  const [upgrade, setUpgrade] = useState<UpgradeReadiness | null>(null);
  const [concentration, setConcentration] = useState<Concentration | null>(null);

  const apiUrl = getApiUrl();
  const PAGE_SIZE = 50;

  const fetchData = useCallback(async () => {
    try {
      setFetchError(false);
      const [nodeRes, statsRes, healthRes, relRes, upgradeRes, concRes] = await Promise.all([
        fetch(`${apiUrl}/v1/network/nodes/list?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&sort=${sortBy}&dir=${sortDir}`),
        fetch(`${apiUrl}/v1/network/nodes/stats`),
        fetch(`${apiUrl}/v1/network/nodes/health-score`),
        fetch(`${apiUrl}/v1/network/nodes/reliability`),
        fetch(`${apiUrl}/v1/network/nodes/upgrade-readiness`),
        fetch(`${apiUrl}/v1/network/nodes/concentration`),
      ]);

      setFetchError([nodeRes, statsRes, healthRes, relRes, upgradeRes, concRes].some(res => !res.ok));
      if (nodeRes.ok) {
        const nodeData = await readApiData(nodeRes);
        setNodes(nodeData.nodes || []);
        setTotal(nodeData.total || 0);
      }

      if (statsRes.ok) {
        const statsData = await readApiData(statsRes);
        setStats(statsData.stats || null);
        setClients(statsData.clients?.distribution || []);
        setVersions(statsData.clients?.versions || []);
      }

      if (healthRes.ok) setHealth(await readApiData(healthRes));
      if (relRes.ok) setReliability(await readApiData(relRes));
      if (upgradeRes.ok) setUpgrade(await readApiData(upgradeRes));
      if (concRes.ok) setConcentration(await readApiData(concRes));
    } catch (err) {
      setFetchError(true);
      console.error('Failed to fetch node data:', err);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, sortBy, sortDir, page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSort = (col: string) => {
    if (col === sortBy) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(col);
      setSortDir('desc');
    }
    setPage(0);
  };

  const identifiedCount = clients.filter(c => c.client !== 'Unknown').reduce((s, c) => s + c.count, 0);
  const coveragePct = stats?.activeNodes ? ((identifiedCount / stats.activeNodes) * 100).toFixed(0) : '—';
  const torClassificationAvailable = stats != null && stats.torNodes != null &&
    ((stats.censusVersion ?? 0) >= 3 ? stats.torClassificationAvailable === true : stats.torClassificationAvailable !== false);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <PageHeader
        eyebrow="NETWORK_NODES"
        title={<>Zcash Nodes</>}
        subtitle="Explore the nodes we observe: their connections, software, hosting and reachability."
        actions={
          <Link href="/network" className="text-xs text-muted hover:text-secondary font-mono transition-colors">
            &larr; Network Overview
          </Link>
        }
      />

      <nav aria-label="Node page sections" className="flex flex-wrap gap-x-5 gap-y-3 font-mono text-caption text-muted mb-6">
        <a href="#node-explorer" className="hover:text-primary">Map & topology</a>
        <a href="#node-software" className="hover:text-primary">Software & protocol</a>
        <a href="#node-observations" className="hover:text-primary">Reliability & hosting</a>
        <a href="#node-directory" className="hover:text-primary">Node directory</a>
      </nav>
      <Card className="network-summary-panel card-static mb-8">
        <dl className="network-summary-grid network-live-facts">
          {[
            { label: 'Observed active IPs', value: stats?.activeNodes.toLocaleString() ?? '—', hint: (stats?.censusVersion ?? 0) >= 3 ? 'Live peers and crawlers serving Zcash chain headers' : 'Live peers and recent crawler observations' },
            { label: 'Countries', value: stats?.countries ?? '—', hint: stats ? `${stats.cities} observed cities` : 'Geographic coverage' },
            { label: 'Tor classified', value: torClassificationAvailable ? stats.torNodes : '—', hint: torClassificationAvailable ? 'Known exit IPs and hidden-service classifications, not all Tor users' : 'Tor classification unavailable' },
            { label: (stats?.censusVersion ?? 0) >= 2 ? 'Average handshake' : 'Average ping', value: stats?.avgPingMs != null ? `${stats.avgPingMs.toFixed(0)} ms` : '—', hint: 'From crawler observations' },
          ].map(item => <div key={item.label}>
            <dt className="type-label text-muted uppercase mb-2">{item.label}</dt>
            <dd className="type-metric text-primary">{item.value}</dd>
            <dd className="text-caption text-muted mt-2">{item.hint}</dd>
          </div>)}
        </dl>
        <p className="border-t border-cipher-border px-5 py-3 text-caption text-muted">
          {stats ? `${stats.totalNodes.toLocaleString()} historical candidate IPs · Last observation ${stats.lastUpdated ? formatRelativeTime(stats.lastUpdated) : 'unavailable'}` : 'Awaiting node observations.'}
          {' '}Discovery coverage is not a census of the network.
          {stats?.chainQualifiedCrawlerNodes != null && stats.localPeerOnlyNodes != null && <> {stats.chainQualifiedCrawlerNodes.toLocaleString()} crawler-verified IPs and {stats.localPeerOnlyNodes.toLocaleString()} additional local-peer IPs.</>}
        </p>
      </Card>
      {fetchError && <p role="status" className="text-caption text-warning mb-6">Some node observations could not load. Previously received values remain visible. <button onClick={fetchData} className="underline underline-offset-4">Retry</button></p>}
      <section id="node-explorer" className="network-section mb-10">
        <Card className="card-static"><CardBody><NodeMapExplorer /></CardBody></Card>
      </section>

      <section id="node-software" className="network-section mb-10">
        <SectionHeader label="SOFTWARE_PROTOCOL" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <Card className="h-full">
            <CardBody className="h-full flex flex-col">
              <h3 className="text-sm font-semibold text-primary">Client distribution</h3>
              <p className="mt-1 text-caption text-muted">Client identities are self-reported by observed peers.</p>
              <div className="flex items-baseline justify-between gap-4 mt-6 mb-3 text-caption">
                <span className="text-secondary">{stats?.activeNodes.toLocaleString() ?? '—'} observed active nodes</span>
                <span className="font-mono text-muted">{coveragePct}% identified</span>
              </div>
              <div className="flex h-3 gap-0.5 overflow-hidden mb-5" aria-hidden="true">
                {clients.filter(item => item.count > 0).map(item => <span key={item.client} style={{ flex: item.count, backgroundColor: clientColor(item.client) }} />)}
              </div>
              {loading && clients.length === 0 ? <SkeletonTable rows={6} columns={3} /> : clients.length === 0 ? <p className="text-caption text-muted">{loading ? 'Loading client observations…' : 'Client observations are unavailable.'}</p> : <table className="w-full text-caption">
                <thead><tr className="border-b border-cipher-border text-muted"><th scope="col" className="text-left py-3 font-normal">Client</th><th scope="col" className="text-right py-3 font-normal">Nodes</th><th scope="col" className="text-right py-3 font-normal">Share</th></tr></thead>
                <tbody className="divide-y divide-cipher-border">
                  {clients.filter(item => item.count > 0).map(item => <tr key={item.client}>
                    <th scope="row" className="text-left py-3 font-normal text-secondary"><span className="inline-flex items-center gap-2"><span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: clientColor(item.client) }} aria-hidden="true" />{clientLabel(item.client)}</span></th>
                    <td className="text-right py-3 font-mono tabular-nums text-primary">{item.count.toLocaleString()}</td>
                    <td className="text-right py-3 font-mono tabular-nums text-muted">{stats?.activeNodes ? (item.count / stats.activeNodes * 100).toFixed(1) : '—'}%</td>
                  </tr>)}
                </tbody>
              </table>}
            <ChartWatermark /></CardBody>
          </Card>

          <Card className="h-full">
            <CardBody className="h-full flex flex-col">
              <h3 className="text-sm font-semibold text-primary">Reported versions</h3>
              <p className="text-caption text-muted mt-1">The 12 most common client/version pairs, reported by peers.</p>
              <div className="flex items-center justify-between gap-3 mt-6 mb-4">
                <label htmlFor="version-client" className="text-caption text-muted">Filter by client</label>
                <select id="version-client" value={versionClient} onChange={e => setVersionClient(e.target.value)} className="min-w-0 rounded border border-cipher-border bg-cipher-bg px-3 py-2 text-caption font-mono text-primary">
                  <option value="all">All clients</option>
                  {[...new Set(versions.map(v => v.client))].map(client => <option key={client} value={client}>{clientLabel(client)}</option>)}
                </select>
              </div>
              <div className="max-h-80 overflow-auto" tabIndex={0} role="region" aria-label="Reported version records">
                {loading && versions.length === 0 ? <SkeletonTable rows={6} columns={3} /> : versions.length === 0 ? <p className="text-caption text-muted">{loading ? 'Loading version observations…' : 'Version observations are unavailable.'}</p> : <table className="w-full text-caption">
                  <thead className="sticky top-0 bg-cipher-surface"><tr className="border-b border-cipher-border text-muted"><th scope="col" className="text-left py-3 pr-3 font-normal">Client</th><th scope="col" className="text-left py-3 pr-3 font-normal">Version</th><th scope="col" className="text-right py-3 font-normal">Nodes</th></tr></thead>
                  <tbody className="divide-y divide-cipher-border">
                    {versions.filter(v => versionClient === 'all' || v.client === versionClient).map((v, i) => <tr key={`${v.client}-${v.version}-${i}`}>
                      <td className="py-3 pr-3 text-secondary"><span className="inline-flex items-center gap-2"><span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: clientColor(v.client) }} aria-hidden="true" />{clientLabel(v.client)}</span></td>
                      <td className="py-3 pr-3 font-mono text-primary break-all">{v.version}</td>
                      <td className="py-3 text-right font-mono tabular-nums text-primary">{v.count.toLocaleString()}</td>
                    </tr>)}
                  </tbody>
                </table>}
              </div>
              <p className="text-caption text-muted mt-4 pt-4 border-t border-cipher-border">Counts refer to observed active nodes. A version string is self-reported.</p>
            <ChartWatermark /></CardBody>
          </Card>
          {/* Upgrade Readiness */}
          {upgrade && (
            <Card className="lg:col-span-2">
              <CardBody>
                <div className="flex items-start justify-between mb-5 gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-primary">{upgrade.referenceUpgrade ? `${upgrade.referenceUpgrade} readiness` : 'Protocol adoption'}</h3>
                    <p className="text-caption text-muted mt-0.5">Advertising protocol {upgrade.latestProtocol} or newer{upgrade.referenceUpgrade ? ` (${upgrade.referenceUpgrade})` : ''} · among nodes reporting a protocol version</p>
                  </div>
                  <span className="text-2xl font-semibold font-mono tabular-nums" style={upgrade.readinessPct != null ? { color: scoreColor(upgrade.readinessPct) } : undefined}>{upgrade.readinessPct != null ? `${upgrade.readinessPct}%` : '—'}</span>
                </div>
                <p className="text-caption text-muted mb-4">{upgrade.latestCount.toLocaleString()} of {upgrade.totalActive.toLocaleString()} reporting nodes advertise it. A protocol version is self-reported and does not prove a node will follow the upgrade.</p>
                <div className="space-y-2.5">
                  {upgrade.versions.map(v => (
                    <div key={v.protocolVersion} className="flex items-center gap-2 text-caption">
                      <span className={`h-2 w-2 rounded-full shrink-0 ${v.isLatest ? 'bg-cipher-green' : 'bg-warning'}`} />
                      <span className="font-mono text-secondary w-16">{v.protocolVersion}</span>
                      <span className="text-muted truncate">{v.clients.join(', ')}</span>
                      <span className="ml-auto font-mono tabular-nums font-semibold text-primary">{v.nodeCount}</span>
                      <span className="font-mono tabular-nums text-muted w-12 text-right">{v.percentage}%</span>
                    </div>
                  ))}
                </div>
              <ChartWatermark /></CardBody>
            </Card>
          )}

        </div>
      </section>

      <section id="node-observations" className="network-section mb-10">
        <SectionHeader label="RELIABILITY_HOSTING" />
        {loading && !reliability && !concentration && <div className="grid lg:grid-cols-2 gap-5"><ChartCardSkeleton height={260} title="Reachability & latency" /><ChartCardSkeleton height={260} title="Hosting concentration" /></div>}
        {!loading && !reliability && !concentration && <p className="text-sm text-muted mb-5">{loading ? 'Loading crawler observations…' : 'Reliability and hosting observations are unavailable.'}</p>}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {reliability && (
            <Card className="card-static"><CardBody>
              <h3 className="text-sm font-semibold text-primary">Reliability &amp; latency</h3>
              <p className="text-caption text-muted mt-1 mb-6">Successful crawler observations and handshake response times.</p>
              <dl className="grid grid-cols-3 gap-4 border-y border-cipher-border py-5 mb-6">
                {[
                  { label: 'Reachability', value: reliability.avgReliabilityPct != null ? `${reliability.avgReliabilityPct}%` : '—' },
                  { label: (stats?.censusVersion ?? 0) >= 2 ? 'Median handshake' : 'Median ping', value: reliability.latency.median != null ? `${reliability.latency.median} ms` : '—' },
                  { label: 'Full-node flags', value: reliability.services.known > 0 ? `${reliability.services.fullNodePct}%` : '—' },
                ].map(item => <div key={item.label} className="min-w-0">
                  <dt className="text-caption text-muted mb-2">{item.label}</dt>
                  <dd className="type-metric type-metric-compact text-primary">{item.value}</dd>
                </div>)}
              </dl>
              <figure>
                <figcaption className="flex flex-wrap items-baseline justify-between gap-2 text-caption mb-5"><span className="text-secondary font-mono">Handshake latency</span><span className="text-muted">{reliability.latency.measured.toLocaleString()} measured nodes · milliseconds</span></figcaption>
                <div className="grid grid-cols-5 gap-3" role="img" aria-label={`Handshake latency distribution: ${reliability.latency.buckets.map(bucket => `${bucket.label}: ${bucket.count} nodes`).join(', ')}`}>
                  {reliability.latency.buckets.map(bucket => {
                    const max = Math.max(1, ...reliability.latency.buckets.map(item => item.count));
                    return <div key={bucket.label} className="min-w-0 text-center" aria-hidden="true">
                      <div className="h-24 flex flex-col justify-end items-center border-b border-cipher-border">
                        <span className="font-mono text-caption text-primary tabular-nums mb-2">{bucket.count}</span>
                        <div className="w-full max-w-12 bg-cipher-gold" style={{ height: `${bucket.count / max * 64}px` }} />
                      </div>
                      <div className="font-mono text-caption text-muted mt-3">{bucket.label.replace('ms', '')}</div>
                    </div>;
                  })}
                </div>
              </figure>
              <p className="border-t border-cipher-border pt-4 mt-6 text-caption text-muted leading-relaxed">Full-node share uses {reliability.services.known.toLocaleString()} nodes reporting service flags. Most-seen node: {reliability.maxSeen.toLocaleString()} successful crawls.</p>
            <ChartWatermark /></CardBody></Card>
          )}
          {concentration && (
            <Card className="card-static"><CardBody>
              <h3 className="text-sm font-semibold text-primary">Hosting concentration</h3>
              <p className="text-caption text-muted mt-1 mb-6">Hosting providers represented in the crawler observations.</p>
              <div className="flex flex-wrap justify-between items-baseline gap-4 border-y border-cipher-border py-5 mb-4">
                <div><p className="text-caption text-muted mb-2">Largest ISP share</p><p className="type-metric type-metric-compact text-primary">{concentration.isps[0] ? `${concentration.isps[0].percentage}%` : '—'}</p></div>
                <div className="text-right"><p className="text-caption text-muted mb-2">Crawler classification</p><p className="text-sm font-mono text-secondary capitalize">{concentration.concentrationRisk}</p></div>
              </div>
              <table className="w-full text-caption">
                <caption className="sr-only">Top hosting providers by observed node count</caption>
                <thead><tr className="border-b border-cipher-border text-muted"><th className="text-left py-3 pr-3">Provider</th><th className="text-right py-3 px-3">Nodes</th><th className="text-right py-3">Share</th></tr></thead>
                <tbody className="divide-y divide-cipher-border">
                  {concentration.isps.slice(0, 5).map(isp => <tr key={isp.isp}>
                    <td className="text-secondary py-3 pr-3">{isp.isp}</td>
                    <td className="text-primary text-right font-mono tabular-nums py-3 px-3">{isp.nodeCount}</td>
                    <td className="text-muted text-right font-mono tabular-nums py-3">{isp.percentage}%</td>
                  </tr>)}
                </tbody>
              </table>
              {concentration.subnets.length > 0 && <details className="mt-5 border-t border-cipher-border">
                <summary className="cursor-pointer text-caption font-mono text-secondary py-4">Clustered subnets <span className="text-muted">· /24 groups</span></summary>
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 pb-2 text-caption font-mono">
                  {concentration.subnets.slice(0, 6).map(subnet => <div key={subnet.subnet} className="flex justify-between gap-3"><dt className="text-muted">{subnet.subnet}</dt><dd className="text-primary tabular-nums">{subnet.nodeCount} nodes</dd></div>)}
                </dl>
              </details>}
            <ChartWatermark /></CardBody></Card>
          )}
        </div>
        {health && <details className="node-assessment network-detail-panel network-detail-disclosure mt-5 rounded-lg border border-cipher-border">
          <summary className="network-detail-toggle">
            <span>
              <span className="block font-mono text-sm text-primary">Crawler assessment</span>
              <span className="block text-caption text-muted mt-1">{health.healthScore == null ? 'Overall score unavailable without independently validated connectivity measurements.' : 'Five inputs from observed nodes. Expand to inspect the score.'}</span>
            </span>
            <span className="flex items-center gap-4 shrink-0">
              <span className="font-mono text-xl text-primary tabular-nums">{health.healthScore ?? '—'}<span className="text-caption text-muted"> / 100</span></span>
              <svg className="network-detail-chevron w-4 h-4 text-muted" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" /></svg>
            </span>
          </summary>
          <div className="border-t border-cipher-border p-5 sm:p-6">
            <table className="w-full text-caption">
              <caption className="text-left text-caption text-muted pb-4">Crawler-derived scores, not a network-wide health verdict.</caption>
              <thead><tr className="border-b border-cipher-border text-muted"><th className="text-left py-3 pr-3">Input</th><th className="text-left py-3 pr-3">Observation</th><th className="text-right py-3">Score / 100</th></tr></thead>
              <tbody className="divide-y divide-cipher-border">
                {[
                  { label: 'Connectivity', score: health.components.connectivity.score, observation: health.components.connectivity.avgDegree == null ? 'Gossip links unavailable' : `${health.components.connectivity.avgDegree} average peers` },
                  { label: 'Protocol adoption', score: health.components.upgrade.score, observation: `${health.components.upgrade.adoptionPct}% at reference protocol or newer` },
                  { label: 'Client diversity', score: health.components.clientDiversity.score, observation: health.components.clientDiversity.topClient ? `${health.components.clientDiversity.topClient} · ${health.components.clientDiversity.topClientPct}%` : 'Unavailable' },
                  { label: 'Geographic spread', score: health.components.geographic.score, observation: `${health.components.geographic.countries} countries` },
                  { label: 'Crawl reachability', score: health.components.reliability.score, observation: health.components.reliability.avgReliabilityPct != null ? `${health.components.reliability.avgReliabilityPct}% of observations` : 'Unavailable' },
                ].map(item => <tr key={item.label}>
                  <th scope="row" className="text-left font-normal text-secondary py-3 pr-3">{item.label}</th>
                  <td className="text-muted py-3 pr-3">{item.observation}</td>
                  <td className="font-mono tabular-nums text-primary text-right py-3">{item.score ?? '—'}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </details>}
      </section>
      {/* Node Table */}
      <section id="node-directory" className="network-section">
      <SectionHeader label="NODE_DIRECTORY" />
      <Card>
        <CardBody>
          <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
            <div>
              <h3 className="text-sm font-semibold text-primary">Observed nodes</h3>
              <p className="text-caption text-muted mt-1">Reported software, location and the latest crawler measurements.</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {nodes.length > 0 && (
                <ExportButton
                  type="csv"
                  data={nodes}
                  filename={`zecblock-nodes-page-${page + 1}`}
                  csvHeaders={['Client', 'Version', 'Protocol version', 'Country', 'Tor', 'Tor type', 'Ping (ms)', 'Active', 'Peers (degree)', 'Betweenness', 'Closeness', 'ISP', 'Source', 'First seen (UTC)', 'Last seen (UTC)']}
                  csvMapper={(node: NodeEntry) => [
                    node.client, node.version ?? '', String(node.protocolVersion ?? ''), node.country ?? '', node.isTor ? 'yes' : 'no', node.torType ?? '',
                    String(node.pingMs ?? ''), node.isActive ? 'yes' : 'no', String(node.degree ?? ''), String(node.betweenness ?? ''), String(node.closeness ?? ''),
                    node.isp ?? '', node.source, node.firstSeen, node.lastSeen,
                  ]}
                />
              )}
              <DirectoryPagination page={page} total={total} pageSize={PAGE_SIZE} onChange={setPage} />
            </div>
          </div>

          {loading ? (
            <SkeletonTable rows={PAGE_SIZE} rowHeight="h-[64px]" headers={["Client / version", "Location", "Peers", "Ping", "Last seen"]} />
          ) : nodes.length === 0 ? <p className="text-sm text-muted py-8">{fetchError ? 'Node records could not load. Use Retry above.' : 'No node records are available.'}</p> : (
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Node records, scroll horizontally on small screens">
              <table className="w-full text-caption">
                <caption className="sr-only">Observed nodes. Select a column heading to sort.</caption>
                <thead>
                  <tr className="border-b border-cipher-border text-muted font-mono uppercase tracking-wider">
                    <SortHeader label="Client / version" col="client_impl" current={sortBy} dir={sortDir} onClick={handleSort} />
                    <SortHeader label="Location" col="country_code" current={sortBy} dir={sortDir} onClick={handleSort} />
                    <SortHeader label="Gossip links" col="degree" current={sortBy} dir={sortDir} onClick={handleSort} align="right" />
                    <SortHeader label={(stats?.censusVersion ?? 0) >= 2 ? "Handshake" : "Ping"} col="ping_ms" current={sortBy} dir={sortDir} onClick={handleSort} align="right" />
                    <SortHeader label="Last Seen" col="last_seen" current={sortBy} dir={sortDir} onClick={handleSort} align="right" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-cipher-border/40">
                  {nodes.map(node => (
                    <tr key={node.id} className="hover:bg-cipher-hover transition-colors">
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-2 text-primary whitespace-nowrap">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: clientColor(node.client) }} aria-hidden="true" />
                          {clientLabel(node.client)}
                        </span>
                        <span className="block mt-1 pl-4 font-mono text-muted whitespace-nowrap">{node.version || 'Version unavailable'}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-2 text-secondary whitespace-nowrap">
                          {node.countryCode && <span aria-hidden="true">{countryFlag(node.countryCode)}</span>}
                          {node.country || node.countryCode || 'Location unavailable'}
                        </span>
                        {node.isTor && <span className="block mt-1 text-caption text-cipher-purple">{node.torType === 'exit' ? 'Tor exit' : node.torType === 'relay' ? 'Tor hidden service' : 'Tor'}</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-secondary whitespace-nowrap">
                        {node.degree ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-secondary whitespace-nowrap">
                        {node.pingMs != null ? `${node.pingMs.toFixed(0)}ms` : '—'}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-secondary whitespace-nowrap">
                        <time dateTime={node.lastSeen} title={node.lastSeen}>{formatRelativeTime(node.lastSeen)}</time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && nodes.length > 0 && <div className="flex flex-wrap items-center justify-between gap-4 border-t border-cipher-border mt-4 pt-5">
            <p className="text-caption text-muted">— means unavailable. Peers are observed graph relationships.</p>
            <DirectoryPagination page={page} total={total} pageSize={PAGE_SIZE} onChange={setPage} />
          </div>}
        </CardBody>
      </Card>
      </section>
    </div>
  );
}

function DirectoryPagination({ page, total, pageSize, onChange }: { page: number; total: number; pageSize: number; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <div className="flex flex-wrap items-center gap-3 text-caption font-mono">
    <span className="text-muted" aria-live="polite">{total ? `${(page * pageSize + 1).toLocaleString()}–${Math.min((page + 1) * pageSize, total).toLocaleString()}` : '0'} <span className="font-sans">of</span> {total.toLocaleString()}</span>
    {pages > 1 && <div className="flex items-center gap-1">
      <button aria-label="Previous node page" onClick={() => onChange(Math.max(0, page - 1))} disabled={page === 0} className="px-3 py-2 rounded border border-cipher-border text-secondary hover:bg-cipher-hover disabled:opacity-40 disabled:cursor-not-allowed">← Prev</button>
      <button aria-label="Next node page" onClick={() => onChange(Math.min(pages - 1, page + 1))} disabled={page >= pages - 1} className="px-3 py-2 rounded border border-cipher-border text-secondary hover:bg-cipher-hover disabled:opacity-40 disabled:cursor-not-allowed">Next →</button>
    </div>}
  </div>;
}

function SortHeader({
  label, col, current, dir, onClick, align = 'left',
}: {
  label: string; col: string; current: string; dir: string; onClick: (col: string) => void; align?: 'left' | 'right';
}) {
  const active = col === current;
  return (
    <th
      className={`px-4 py-3 whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button onClick={() => onClick(col)} className="py-1 uppercase tracking-wider hover:text-primary focus-visible:outline-cipher-gold">{label}
      <span aria-hidden="true" className={`inline-block w-4 ml-1 ${active ? 'text-cipher-gold' : 'text-muted'}`}>{active ? (dir === 'asc' ? '↑' : '↓') : '↕'}</span></button>
    </th>
  );
}

function formatRelativeTime(iso: string): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
