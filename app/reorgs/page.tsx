'use client';

import { readApiData } from '@/lib/api-client';
import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { formatRelativeTime, formatDateUTC } from '@/lib/utils';
import { getApiUrl } from '@/lib/api-config';
import { Card, CardBody, Badge, DataTable, HashLink, EmptyState, type DataTableColumn } from '@/components/ui';

import { BlockFirstSeen, BLOCK_FIRST_SEEN_EXPLANATION } from '@/components/BlockFirstSeen';
import { ExportButton } from '@/components/ExportButton';
import { SortableDataTable, type SortableColumn } from '@/components/ui/SortableDataTable';

const API_URL = getApiUrl();

function isUnknownPool(pool: string | null | undefined) {
  return !pool || /^Unknown/i.test(pool);
}

interface OrphanedBlock {
  id: number;
  height: number;
  hash: string;
  firstSeenAt?: string | null;
  canonicalHash: string | null;
  timestamp: number | null;
  transactionCount: number;
  size: number;
  difficulty: string | null;
  minerAddress: string | null;
  minerPool: string | null;
  source: string;
  reportedBy: string | null;
  consensusValid: boolean | null;
  detectedAt: string;
  forkEventId: number | null;
  canonicalBlock?: ReorgBlockSide | null;
}

interface ReorgBlockSide {
  hash: string;
  firstSeenAt?: string | null;
  timestamp: number | null;
  transactionCount: number | null;
  size: number | null;
  minerAddress: string | null;
  minerPool: string | null;
  minerPoolUrl?: string | null;
  minerPoolRegion?: string | null;
  source?: string;
}

interface ReorgComparison {
  height: number;
  orphaned: ReorgBlockSide;
  canonical: ReorgBlockSide | null;
}

interface ForkEvent {
  id: number;
  forkHeight: number;
  depth: number;
  canonicalTip: number | null;
  orphanedCount: number;
  source: string;
  description: string | null;
  detectedAt: string;
  resolvedAt: string | null;
  comparisons?: ReorgComparison[];
}

interface Stats {
  totalOrphanedBlocks: number;
  totalForkEvents: number;
  reportsLast24h: number;
  deepestReorg: number;
}

interface MonitoredNode {
  name: string;
  host: string;
  nodeImpl: string | null;
  version: string | null;
  height: number | null;
  hash: string | null;
  ourHash: string | null;
  status: 'pending' | 'agree' | 'behind' | 'ahead' | 'fork' | 'syncing' | 'offline';
  lastChecked: string | null;
  error: string | null;
  forkHeight: number | null;
  commonAncestor: number | null;
}

interface NodesSummary {
  total: number;
  online: number;
  forking: number;
}

const forkColumns: SortableColumn<ForkEvent>[] = [
  {
    id: 'height',
    header: 'Height',
    sortValue: (fork) => fork.forkHeight,
    cell: (fork) => (
      <Link href={`/block/${fork.forkHeight}`} prefetch={false} className="text-cipher-gold hover:underline font-mono text-xs">
        #{fork.forkHeight.toLocaleString()}
      </Link>
    ),
  },
  {
    id: 'depth',
    header: 'Depth',
    sortValue: (fork) => fork.depth,
    align: 'center',
    cell: (fork) => (
      <Badge color={fork.depth > 3 ? 'orange' : fork.depth > 1 ? 'gold' : 'muted'}>
        {fork.depth} block{fork.depth !== 1 ? 's' : ''}
      </Badge>
    ),
  },
  {
    id: 'blocks',
    header: 'Blocks',
    sortValue: (fork) => fork.orphanedCount || fork.comparisons?.length || null,
    align: 'center',
    cell: (fork) => (
      <span className="font-mono text-xs text-secondary">
        {fork.orphanedCount || fork.comparisons?.length || '—'}
      </span>
    ),
  },
  {
    id: 'source',
    header: 'Source',
    sortValue: (fork) => fork.source,
    cell: (fork) => (
      <Badge color={fork.source === 'external' ? 'purple' : 'gold'}>
        {fork.source}
      </Badge>
    ),
  },
  {
    id: 'description',
    header: 'Description',
    className: 'hidden sm:table-cell',
    cell: (fork) => (
      <span className="text-xs text-secondary truncate block max-w-[250px]">
        {fork.description || '—'}
      </span>
    ),
  },
  {
    id: 'detected',
    header: 'Detected',
    sortValue: (fork) => Date.parse(fork.detectedAt),
    align: 'right',
    cell: (fork) => (
      <span className="text-xs text-muted font-mono whitespace-nowrap">
        {fork.detectedAt ? formatRelativeTime(new Date(fork.detectedAt).getTime() / 1000) : '—'}
      </span>
    ),
  },
];

const NODE_STATUS_COLOR: Record<string, string> = {
  agree: 'text-cipher-green',
  behind: 'text-cipher-yellow',
  ahead: 'text-cipher-gold',
  fork: 'text-cipher-orange',
  offline: 'text-danger',
  pending: 'text-muted',
  syncing: 'text-muted',
};

const NODE_STATUS_LABEL: Record<string, string> = {
  agree: 'Agrees',
  behind: 'Behind',
  ahead: 'Ahead',
  fork: 'FORK',
  offline: 'Offline',
  pending: 'Pending',
  syncing: 'Syncing',
};

const nodeColumns: DataTableColumn<MonitoredNode>[] = [
  {
    id: 'node',
    header: 'Node',
    cell: (node) => (
      <span className="font-mono text-xs text-primary font-medium">{node.name}</span>
    ),
  },
  {
    id: 'host',
    header: 'Host',
    className: 'hidden sm:table-cell',
    cell: (node) => <code className="text-xs text-muted font-mono">{node.host}</code>,
  },
  {
    id: 'version',
    header: 'Version',
    align: 'center',
    className: 'hidden sm:table-cell',
    cell: (node) =>
      node.version ? (
        <span className="text-xs font-mono text-secondary">
          {node.nodeImpl ? `${node.nodeImpl} ` : ''}{node.version}
        </span>
      ) : (
        <span className="text-xs text-muted">—</span>
      ),
  },
  {
    id: 'height',
    header: 'Height',
    align: 'center',
    cell: (node) => (
      <span className="font-mono text-xs text-secondary">
        {node.height ? node.height.toLocaleString() : '—'}
      </span>
    ),
  },
  {
    id: 'tipHash',
    header: 'Tip Hash',
    className: 'hidden md:table-cell',
    cell: (node) =>
      node.hash ? (
        <HashLink
          value={node.hash}
          lead={10}
          tail={6}
          linkClassName={`text-xs font-mono ${node.status === 'fork' ? 'text-cipher-orange' : 'text-secondary'}`}
        />
      ) : (
        <span className="text-xs text-muted">—</span>
      ),
  },
  {
    id: 'status',
    header: 'Status',
    align: 'center',
    cell: (node) => (
      <>
        <span className={`text-xs font-mono font-semibold ${NODE_STATUS_COLOR[node.status] || 'text-muted'}`}>
          {NODE_STATUS_LABEL[node.status] || node.status}
        </span>
        {node.status === 'fork' && node.commonAncestor != null && node.height != null && (
          <span className="block text-caption text-muted mt-0.5">
            depth: {node.height - node.commonAncestor} · split @ #{node.commonAncestor.toLocaleString()}
          </span>
        )}
      </>
    ),
  },
  {
    id: 'lastCheck',
    header: 'Last Check',
    align: 'right',
    cell: (node) => (
      <span className="text-xs text-muted font-mono">
        {node.lastChecked ? formatRelativeTime(new Date(node.lastChecked).getTime() / 1000) : '—'}
      </span>
    ),
  },
];

export default function UnclesPage() {
  const [tab, setTab] = useState<'forks' | 'orphans' | 'nodes'>('forks');
  const [orphans, setOrphans] = useState<OrphanedBlock[]>([]);
  const [forks, setForks] = useState<ForkEvent[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [nodes, setNodes] = useState<MonitoredNode[]>([]);
  const [nodesSummary, setNodesSummary] = useState<NodesSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedOrphan, setExpandedOrphan] = useState<number | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [statsRes, orphansRes, forksRes, nodesRes] = await Promise.all([
        fetch(`${API_URL}/v1/uncles/stats`),
        fetch(`${API_URL}/v1/uncles?limit=50`),
        fetch(`${API_URL}/v1/uncles/forks?limit=100`),
        fetch(`${API_URL}/v1/uncles/nodes`),
      ]);

      if (statsRes.ok) {
        const statsData = await readApiData(statsRes);
        if (statsData) setStats(statsData);
      }

      if (orphansRes.ok) {
        const orphansData = await readApiData(orphansRes);
        if (orphansData) setOrphans(orphansData.orphanedBlocks || []);
      }

      if (forksRes.ok) {
        const forksData = await readApiData(forksRes);
        if (forksData) setForks(forksData.forks || []);
      }

      if (nodesRes.ok) {
        const nodesData = await readApiData(nodesRes);
        if (nodesData) {
          setNodes(nodesData.nodes || []);
          setNodesSummary(nodesData.summary || null);
        }
      }
    } catch (err) {
      console.error('Error fetching reorg data:', err);
      setError('Failed to load reorg data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const PoolBadge = ({ pool, url, variant, minerAddress }: { pool: string | null; url?: string | null; variant: 'orphan' | 'canonical'; minerAddress?: string | null }) => {
    if (isUnknownPool(pool)) {
      if (minerAddress) {
        return (
          <HashLink value={minerAddress} href={`/address/${minerAddress}`} lead={6} tail={4} copy={false} />
        );
      }
      return <span className="text-xs text-muted font-mono">—</span>;
    }
    const colorClass = variant === 'orphan'
      ? 'bg-cipher-orange/10 text-cipher-orange border-cipher-orange/30'
      : 'bg-cipher-green/10 text-cipher-green border-cipher-green/30';
    const content = (
      <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-mono font-semibold border ${colorClass}`}>
        {pool}
      </span>
    );
    if (url) {
      return (
        <a href={url} target="_blank" rel="noopener noreferrer" className="hover:opacity-80 transition-opacity">
          {content}
        </a>
      );
    }
    return content;
  };

  const BlockSideCard = ({
    label,
    block,
    variant,
    height,
  }: {
    label: string;
    block: ReorgBlockSide;
    variant: 'orphan' | 'canonical';
    height: number;
  }) => {
    const isOrphan = variant === 'orphan';
    const borderColor = isOrphan ? 'border-cipher-orange/30' : 'border-cipher-green/30';
    const surface = isOrphan
      ? 'bg-cipher-orange/5'
      : 'bg-cipher-green/5';
    const labelColor = isOrphan ? 'text-cipher-orange' : 'text-cipher-green';

    return (
      <div className={`flex-1 rounded-lg border ${borderColor} ${surface} p-4`}>
        <div className="flex items-center justify-between mb-3">
          <span className={`text-caption font-mono uppercase tracking-wider font-semibold ${labelColor}`}>
            {label}
          </span>
          <Badge color={isOrphan ? 'orange' : 'green'}>
            {isOrphan ? 'Orphaned' : 'Canonical'}
          </Badge>
        </div>
        <div className="space-y-2.5">
          <div>
            <span className="text-caption text-muted font-mono uppercase">Height</span>
            <div className="text-sm font-mono text-primary">#{height.toLocaleString()}</div>
          </div>
          <div>
            <span className="text-caption text-muted font-mono uppercase">Hash</span>
            <Link
              href={isOrphan ? `/block/${block.hash}` : `/block/${height}`} prefetch={false}
              className={`text-xs font-mono break-all hover:underline block mt-0.5 ${isOrphan ? 'text-cipher-orange' : 'text-cipher-green'}`}
            >
              {block.hash}
            </Link>
          </div>
          <div>
            <span className="text-caption text-muted font-mono uppercase">Miner / Pool</span>
            <div className="mt-1">
              <PoolBadge pool={block.minerPool} url={block.minerPoolUrl} variant={variant} minerAddress={block.minerAddress} />
            </div>
          </div>
          <BlockFirstSeen value={block.firstSeenAt} />
          <div className="flex gap-4">
            <div>
              <span className="text-caption text-muted font-mono uppercase">TXs</span>
              <div className="text-xs font-mono text-secondary">{block.transactionCount ?? '—'}</div>
            </div>
            <div>
              <span className="text-caption text-muted font-mono uppercase">Block time</span>
              <div className="text-xs font-mono text-secondary">
                {block.timestamp ? formatRelativeTime(block.timestamp) : '—'}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const StatCard = ({ label, value, color = 'text-primary' }: { label: string; value: string | number; color?: string }) => (
    <Card variant="compact">
      <CardBody className="text-center py-4">
        <div className={`text-2xl font-semibold font-mono ${color}`}>{value}</div>
        <div className="text-caption uppercase tracking-wider text-muted mt-1">{label}</div>
      </CardBody>
    </Card>
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      {/* Header */}
      <div className="mb-8">
        <span className="text-caption font-mono text-muted tracking-wider">&gt; FORK_WATCH</span>
        <h1 className="type-page font-sans text-primary mt-1">
          Fork Watch
        </h1>
        <p className="text-xs text-muted mt-2 max-w-2xl">
          Monitor chain forks, orphaned blocks, and competing tips on the Zcash network.
          When miners produce blocks at the same height, the network resolves to a single chain — losing blocks become orphans.
        </p>
      </div>

      <p className="text-xs text-muted mb-6 max-w-3xl">{BLOCK_FIRST_SEEN_EXPLANATION}</p>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          <StatCard label="Fork Events" value={stats.totalForkEvents} />
          <StatCard label="Orphaned Blocks" value={stats.totalOrphanedBlocks} />
          <StatCard label="Longest Reorg" value={stats.deepestReorg > 0 ? `${stats.deepestReorg} blocks` : '—'} color={stats.deepestReorg > 3 ? 'text-cipher-orange' : 'text-primary'} />
          <StatCard label="Nodes Monitored" value={nodesSummary ? `${nodesSummary.online}/${nodesSummary.total}` : '—'} color={nodesSummary && nodesSummary.forking > 0 ? 'text-cipher-orange' : 'text-primary'} />
        </div>
      )}

      {/* Tab Switcher */}
      <div className="flex gap-1 mb-6 border-b border-cipher-border">
        <button
          onClick={() => setTab('forks')}
          className={`px-4 py-2 text-xs font-mono transition-colors border-b-2 ${
            tab === 'forks'
              ? 'border-cipher-gold text-cipher-gold'
              : 'border-transparent text-muted hover:text-secondary'
          }`}
        >
          Reorg History ({forks.length})
        </button>
        <button
          onClick={() => setTab('orphans')}
          className={`px-4 py-2 text-xs font-mono transition-colors border-b-2 ${
            tab === 'orphans'
              ? 'border-cipher-gold text-cipher-gold'
              : 'border-transparent text-muted hover:text-secondary'
          }`}
        >
          Orphaned Blocks ({orphans.length})
        </button>
        <button
          onClick={() => setTab('nodes')}
          className={`px-4 py-2 text-xs font-mono transition-colors border-b-2 ${
            tab === 'nodes'
              ? 'border-cipher-gold text-cipher-gold'
              : 'border-transparent text-muted hover:text-secondary'
          }`}
        >
          Monitored Nodes ({nodes.length})
        </button>
        <div className="ml-auto self-center pb-1">
          {tab === 'forks' && forks.length > 0 && (
            <ExportButton
              type="csv"
              data={forks}
              filename="zecblock-reorg-history"
              csvHeaders={['Fork event', 'Fork height', 'Depth (blocks)', 'Orphaned blocks', 'Canonical tip', 'Source', 'Detected (UTC)', 'Resolved (UTC)', 'Description']}
              csvMapper={(fork: ForkEvent) => [
                String(fork.id), String(fork.forkHeight), String(fork.depth), String(fork.orphanedCount), String(fork.canonicalTip ?? ''),
                fork.source, fork.detectedAt, fork.resolvedAt ?? '', fork.description ?? '',
              ]}
            />
          )}
          {tab === 'orphans' && orphans.length > 0 && (
            <ExportButton
              type="csv"
              data={orphans}
              filename="zecblock-orphaned-blocks"
              csvHeaders={['Height', 'Orphaned hash', 'Canonical hash', 'Block time (UTC)', 'Transactions', 'Size (bytes)', 'Miner pool', 'Miner address', 'Source', 'Reported by', 'Consensus valid', 'Detected (UTC)', 'Fork event']}
              csvMapper={(block: OrphanedBlock) => [
                String(block.height), block.hash, block.canonicalHash ?? '', block.timestamp ? new Date(block.timestamp * 1000).toISOString() : '',
                String(block.transactionCount), String(block.size), block.minerPool ?? '', block.minerAddress ?? '', block.source, block.reportedBy ?? '',
                block.consensusValid == null ? '' : String(block.consensusValid), block.detectedAt, String(block.forkEventId ?? ''),
              ]}
            />
          )}
        </div>
      </div>

      {loading && (
        <Card>
          <CardBody>
            <EmptyState title="Loading reorg data..." />
          </CardBody>
        </Card>
      )}

      {error && !loading && (
        <Card>
          <CardBody>
            <EmptyState
              title={error}
              action={
                <button onClick={fetchData} className="text-xs font-mono text-cipher-gold hover:underline">
                  Retry
                </button>
              }
            />
          </CardBody>
        </Card>
      )}

      {!loading && !error && orphans.length === 0 && forks.length === 0 && (
        <Card>
          <CardBody>
            <EmptyState
              icon="🛡️"
              title="No Reorg Events Recorded"
              description={<>Chain reorganization events will appear here when detected. External nodes can report competing tips via the <code className="text-cipher-gold">POST /v1/uncles/report</code> endpoint.</>}
            />
          </CardBody>
        </Card>
      )}

      {/* Fork Events — Summary list */}
      {!loading && !error && tab === 'forks' && forks.length > 0 && (
        <SortableDataTable
          caption="Chain reorganization history"
          columns={forkColumns}
          rows={forks}
          rowKey={(fork) => fork.id}
        />
      )}

      {/* Orphaned Blocks Table with expandable comparison */}
      {/* Expandable rows — DataTable doesn't support expansion yet; classes mirror its conventions */}
      {!loading && !error && tab === 'orphans' && orphans.length > 0 && (
        <div className="card p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Height</th>
                  <th className="px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Orphaned Hash</th>
                  <th className="px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border hidden md:table-cell">Canonical Hash</th>
                  <th className="px-4 py-3 text-center text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">TXs</th>
                  <th className="px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border hidden sm:table-cell">Miner</th>
                  <th className="px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Source</th>
                  <th className="px-4 py-3 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Time</th>
                </tr>
              </thead>
              <tbody>
                {orphans.map((block) => (
                  <React.Fragment key={block.id}>
                    <tr
                      className={`group transition-colors duration-100 hover:bg-cipher-hover cursor-pointer ${expandedOrphan === block.id ? 'bg-cipher-hover' : ''}`}
                      onClick={() => setExpandedOrphan(expandedOrphan === block.id ? null : block.id)}
                    >
                      <td className="px-4 h-[44px] border-b border-cipher-border">
                        <Link href={`/block/${block.height}`} prefetch={false} className="text-cipher-gold hover:underline font-mono text-xs" onClick={e => e.stopPropagation()}>
                          #{block.height.toLocaleString()}
                        </Link>
                      </td>
                      <td className="px-4 h-[44px] border-b border-cipher-border" onClick={e => e.stopPropagation()}>
                        <HashLink value={block.hash} href={`/block/${block.hash}`} lead={10} tail={6} copy={false} linkClassName="text-xs font-mono text-cipher-orange hover:underline" />
                      </td>
                      <td className="px-4 h-[44px] border-b border-cipher-border hidden md:table-cell">
                        {(block.canonicalBlock?.hash || block.canonicalHash) ? (
                          <span onClick={e => e.stopPropagation()}>
                            <HashLink
                              value={(block.canonicalBlock?.hash || block.canonicalHash)!}
                              href={`/block/${block.height}`}
                              lead={10}
                              tail={6}
                              copy={false}
                              linkClassName="text-xs font-mono text-cipher-green hover:underline"
                            />
                          </span>
                        ) : (
                          <span className="text-xs text-muted">—</span>
                        )}
                      </td>
                      <td className="px-4 h-[44px] border-b border-cipher-border text-center font-mono text-xs text-secondary">
                        {block.transactionCount ?? '—'}
                      </td>
                      <td className="px-4 h-[44px] border-b border-cipher-border hidden sm:table-cell">
                        {isUnknownPool(block.minerPool) ? (
                          block.minerAddress ? (
                            <span onClick={e => e.stopPropagation()}>
                              <HashLink value={block.minerAddress} href={`/address/${block.minerAddress}`} lead={6} tail={4} copy={false} />
                            </span>
                          ) : (
                            <span className="text-xs text-muted">—</span>
                          )
                        ) : block.minerAddress ? (
                          <Link href={`/address/${block.minerAddress}`} prefetch={false} className="text-xs font-mono text-cipher-gold hover:underline truncate block max-w-[120px]" title={block.minerAddress} onClick={e => e.stopPropagation()}>
                            {block.minerPool}
                          </Link>
                        ) : (
                          <span className="text-xs font-mono text-cipher-gold">{block.minerPool}</span>
                        )}
                      </td>
                      <td className="px-4 h-[44px] border-b border-cipher-border">
                        <Badge color={block.source === 'external' ? 'purple' : block.source === 'reindex' ? 'gold' : 'muted'}>
                          {block.source}
                        </Badge>
                      </td>
                      <td className="px-4 h-[44px] border-b border-cipher-border text-right text-xs text-muted font-mono whitespace-nowrap">
                        {block.timestamp ? formatRelativeTime(block.timestamp) : '—'}
                      </td>
                    </tr>
                    {expandedOrphan === block.id && (
                      <tr>
                        <td colSpan={7} className="px-4 py-4 bg-cipher-surface">
                          <div className="flex flex-col lg:flex-row gap-3">
                            <BlockSideCard
                              label="Orphaned Block"
                              block={{
                                hash: block.hash,
                                firstSeenAt: block.firstSeenAt,
                                timestamp: block.timestamp,
                                transactionCount: block.transactionCount,
                                size: block.size,
                                minerAddress: block.minerAddress,
                                minerPool: block.minerPool,
                              }}
                              variant="orphan"
                              height={block.height}
                            />
                            <div className="hidden lg:flex items-center justify-center px-2">
                              <div className="text-muted font-mono text-xs">vs</div>
                            </div>
                            {block.canonicalBlock ? (
                              <BlockSideCard
                                label="Canonical Block"
                                block={block.canonicalBlock}
                                variant="canonical"
                                height={block.height}
                              />
                            ) : (
                              <div className="flex-1 rounded-lg border border-cipher-border bg-glass-2 p-4 flex items-center justify-center">
                                <span className="text-xs text-muted font-mono">Canonical block not indexed</span>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Monitored Nodes Table */}
      {!loading && !error && tab === 'nodes' && (
        <DataTable
          columns={nodeColumns}
          rows={nodes}
          rowKey={(node) => node.name}
        />
      )}

      {/* Report Endpoint Info */}
      <Card className="mt-8">
        <CardBody>
          <h3 className="text-sm font-semibold font-mono text-primary mb-3">Report Competing Tips</h3>
          <p className="text-xs text-secondary mb-3">
            Node operators can help monitor chain health by reporting their tip block hash.
            If your node sees a different block at the same height, it will be recorded as a potential fork.
          </p>
            <div tabIndex={0} role="region" aria-label="Competing-tip report request example" className="max-w-full overflow-x-auto bg-cipher-surface rounded-lg p-4 border border-cipher-border">
            <code className="text-xs text-cipher-gold font-mono block mb-2">
              POST {API_URL}/v1/uncles/reports
            </code>
            <pre className="text-xs text-muted font-mono">
{`{
  "height": 3363000,
  "hash": "0000000000...",
  "node_id": "my-zebra-node"  // optional
}`}
            </pre>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
