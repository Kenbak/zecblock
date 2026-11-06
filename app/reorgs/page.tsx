'use client';

import { useCallback, useState } from 'react';
import { formatRelativeTime } from '@/lib/utils';
import { getApiUrl } from '@/lib/api-config';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useUrlState } from '@/lib/use-url-state';
import { PageHeader, SectionHeader, DataTable, HashLink, type DataTableColumn } from '@/components/ui';
import { BLOCK_FIRST_SEEN_EXPLANATION } from '@/components/BlockFirstSeen';
import { CompetingBlocks, type ForkEvent, type ObservedOrphan, type OrphanedBlock } from '@/components/reorgs/CompetingBlocks';
import { ForkEventsTable } from '@/components/reorgs/ForkEventsTable';
import { ForkSummary, WINDOWS, type NodesSummary, type OrphanRates, type ReorgStats, type Window } from '@/components/reorgs/ForkSummary';

const API_URL = getApiUrl();

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

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'blocks', label: 'Competing blocks' },
  { id: 'reorg-history', label: 'Reorg history' },
  { id: 'nodes', label: 'Monitored nodes' },
  { id: 'methodology', label: 'Data & definitions' },
];

const REFRESH = { refreshInterval: 30_000 };

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

export default function ForkWatchPage() {
  const [window, setWindow] = useUrlState<Window>('window', '30d', WINDOWS);
  const [miner, setMiner] = useState<string | null>(null);

  const { data: rates } = useApiQuery<OrphanRates>('/v1/mining/orphan-rates', undefined, { refreshInterval: 60_000 });
  const { data: stats } = useApiQuery<ReorgStats>('/v1/uncles/stats', undefined, REFRESH);
  const { data: orphanData, loading: orphansLoading } = useApiQuery<{ orphanedBlocks: OrphanedBlock[] }>('/v1/uncles', { limit: 200 }, REFRESH);
  const { data: observedData, loading: observedLoading } = useApiQuery<{ orphanedBlocks: ObservedOrphan[] }>('/v1/uncles/observed', { limit: 200 }, REFRESH);
  const { data: forkData } = useApiQuery<{ forks: ForkEvent[] }>('/v1/uncles/forks', { limit: 100 }, REFRESH);
  const { data: nodeData } = useApiQuery<{ nodes: MonitoredNode[]; summary: NodesSummary | null }>('/v1/uncles/nodes', undefined, REFRESH);

  const nodes = nodeData?.nodes ?? [];
  const selectMiner = useCallback((name: string) => {
    setMiner(name);
    document.getElementById('blocks')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <PageHeader
        eyebrow="FORK_WATCH"
        title="Fork Watch"
        subtitle="When two miners find a block at the same height, the network keeps one and the other becomes an orphan. This page tracks those competing blocks, reorgs on our node, and whether monitored nodes agree on the tip."
      />

      <nav aria-label="Fork Watch sections" className="sticky top-14 z-10 -mx-4 mb-8 flex gap-5 overflow-x-auto border-b border-cipher-border bg-cipher-bg/90 px-4 py-3 text-caption font-mono text-muted backdrop-blur sm:mx-0 sm:px-0">
        {SECTIONS.map(section => <a key={section.id} href={`#${section.id}`} className="shrink-0 hover:text-primary">{section.label}</a>)}
      </nav>

      <section id="overview" className="scroll-mt-56 sm:scroll-mt-36 mb-14">
        <ForkSummary rates={rates ?? null} stats={stats ?? null} nodes={nodeData?.summary ?? null} window={window} onWindowChange={setWindow} onSelectMiner={selectMiner} />
      </section>

      <section id="blocks" className="scroll-mt-56 sm:scroll-mt-36 mb-14">
        <SectionHeader label={`COMPETING_BLOCKS · ${window.toUpperCase()}`} />
        <CompetingBlocks
          orphans={orphanData?.orphanedBlocks ?? []}
          observed={observedData?.orphanedBlocks ?? []}
          forks={forkData?.forks ?? []}
          miner={miner}
          onMinerChange={setMiner}
          loading={orphansLoading || observedLoading}
          window={window}
        />
      </section>

      <section id="reorg-history" className="scroll-mt-56 sm:scroll-mt-36 mb-6">
        <details className="group card p-0 overflow-hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 sm:px-6">
            <span className="flex items-center gap-3">
              <span className="font-mono text-sm text-primary">Reorg history</span>
              {stats && <span className="text-caption font-mono text-muted">{stats.totalForkEvents.toLocaleString('en-US')} fork events · longest {stats.deepestReorg} block{stats.deepestReorg === 1 ? '' : 's'}</span>}
            </span>
            <span className="text-muted group-open:rotate-90 transition-transform" aria-hidden="true">›</span>
          </summary>
          <div className="border-t border-cipher-border">
            <ForkEventsTable forks={forkData?.forks ?? []} />
          </div>
        </details>
      </section>

      <section id="nodes" className="scroll-mt-56 sm:scroll-mt-36 mb-6">
        <details className="group card p-0 overflow-hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 sm:px-6">
            <span className="flex items-center gap-3">
              <span className="font-mono text-sm text-primary">Monitored nodes</span>
              {nodeData?.summary && (
                <span className="inline-flex items-center gap-1.5 text-caption font-mono text-muted">
                  <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${nodeData.summary.forking > 0 ? 'bg-cipher-orange' : 'bg-cipher-green'}`} />
                  {nodeData.summary.online}/{nodeData.summary.total} online{nodeData.summary.forking > 0 ? ` · ${nodeData.summary.forking} on a fork` : ''}
                </span>
              )}
            </span>
            <span className="text-muted group-open:rotate-90 transition-transform" aria-hidden="true">›</span>
          </summary>
          <div className="border-t border-cipher-border">
            <p className="px-5 sm:px-6 py-3 text-caption text-muted">Public nodes we poll to compare their tip hash with ours. A node on a different hash at the same height is shown as a fork with its split height.</p>
            <DataTable columns={nodeColumns} rows={nodes} rowKey={(node) => node.name} />
          </div>
        </details>
      </section>

      <section id="methodology" className="scroll-mt-56 sm:scroll-mt-36">
        <details className="group card p-0 overflow-hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 sm:px-6">
            <span className="font-mono text-sm text-primary">Data &amp; definitions</span>
            <span className="text-muted group-open:rotate-90 transition-transform" aria-hidden="true">›</span>
          </summary>
          <div className="grid sm:grid-cols-2 gap-6 p-5 sm:p-6 border-t border-cipher-border text-xs leading-relaxed text-secondary">
            <div>
              <h3 className="font-mono text-primary mb-2">Counts</h3>
              <p>The headline, daily chart and pool list use the same observed orphan rate as Mining: competing blocks from both sources, grouped by block header time over rolling 24-hour, 7-day and 30-day windows. Rate is orphaned blocks divided by canonical plus orphaned blocks.</p>
              <p className="mt-3">All-time totals: {stats ? <><span className="font-mono">{stats.totalOrphanedBlocks.toLocaleString('en-US')}</span> blocks reorged on our node across <span className="font-mono">{stats.totalForkEvents.toLocaleString('en-US')}</span> fork events, and <span className="font-mono">{stats.observerOnlyOrphanedBlocks?.toLocaleString('en-US') ?? '—'}</span> seen only by observers</> : 'unavailable'}. The two sets never contain the same block. The list shows the latest 200 of each.</p>
              <p className="mt-3">Reorg depth is the number of blocks our node rolled back in one fork event. Observer-only blocks never reorged our node, so they have no depth. Pool labels come from public coinbase data; Unknown stays included.</p>
            </div>
            <div>
              <h3 className="font-mono text-primary mb-2">First seen &amp; reporting</h3>
              <p>{BLOCK_FIRST_SEEN_EXPLANATION}</p>
              <p className="mt-3">Node operators can report their tip hash. A different block at the same height is recorded as a potential fork.</p>
              <div tabIndex={0} role="region" aria-label="Competing-tip report request example" className="mt-3 max-w-full overflow-x-auto rounded-lg border border-cipher-border bg-cipher-surface p-4">
                <code className="mb-2 block font-mono text-xs text-cipher-gold">POST {API_URL}/v1/uncles/reports</code>
                <pre className="font-mono text-xs text-muted">{`{
  "height": 3363000,
  "hash": "0000000000...",
  "node_id": "my-zebra-node"  // optional
}`}</pre>
              </div>
            </div>
          </div>
        </details>
      </section>
    </div>
  );
}
