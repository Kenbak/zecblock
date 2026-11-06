'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { readApiData } from '@/lib/api-client';
import { getApiUrl } from '@/lib/api-config';
import { CURRENCY } from '@/lib/config';
import { PeriodPillTags } from '@/components/ui/PeriodPillTags';
import { AddressGraphSkeleton } from './AddressLoadingSkeleton';
import { AddressBubbleMap } from './AddressBubbleMap';
import { connectionNodes, type ConnectionsResponse } from './address-connections';

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const amount = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 8 });

export function AddressGraph({ address }: { address: string }) {
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<'recent' | 'cluster'>('recent');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(false); setData(null); setSelectedId(null);
    fetch(`${getApiUrl()}/v1/addresses/${encodeURIComponent(address)}/graph`, { signal: controller.signal })
      .then(readApiData<ConnectionsResponse>)
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [address, attempt]);
  const nodes = useMemo(() => data ? connectionNodes(data, mode) : [], [data, mode]);
  const visible = useMemo(() => nodes.filter(node => `${node.id} ${node.label || ''}`.toLowerCase().includes(query.trim().toLowerCase())), [nodes, query]);
  const selected = nodes.find(node => node.id === selectedId);
  const cp = selected?.counterparty;
  if (loading) return <AddressGraphSkeleton />;
  if (error || !data) return <div role="status" className="rounded-xl border border-cipher-border p-8 text-center">
    <p className="text-sm text-secondary">Address connections are unavailable right now.</p>
    <button type="button" className="mt-4 rounded border border-cipher-border px-4 py-2 text-sm text-primary hover:bg-cipher-hover" onClick={() => setAttempt(value => value + 1)}>Try again</button>
  </div>;
  const clusterOmitted = Math.max(0, (data.cluster?.memberCount ?? 1) - 1 - data.peers.length);
  return <section aria-label="Address connections" className="rounded-xl border border-cipher-border bg-cipher-surface overflow-hidden">
    <div className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h2 className="text-base font-semibold text-primary">Explore address connections</h2>
          <p className="mt-2 text-sm text-muted max-w-2xl">Inspect public transaction associations and inferred clusters. These connections do not establish identity or ownership.</p></div>
        <PeriodPillTags aria-label="Connection type" value={mode}
          onChange={value => { setMode(value); setSelectedId(null); setQuery(''); }}
          options={(['recent', 'cluster'] as const).map(value => ({ key: value, label: value === 'recent' ? 'Recent connections' : 'Co-spend cluster' }))} />
      </div>
      <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-xs font-mono text-muted">
        <span className="text-secondary">{nodes.length} connected addresses shown</span>
        <span>{mode === 'recent' ? (data.sampledRecentTxs ? `Up to ${data.sampledRecentTxs} recent transactions · top 20 by associated value` : 'Bounded recent transaction sample') : data.cluster ? `${data.cluster.memberCount.toLocaleString('en-US')} addresses in the indexed cluster, including this address` : 'No indexed co-spend cluster'}</span>
      </div>
    </div>
    <div className="grid lg:grid-cols-[minmax(0,1fr)_300px] border-t border-cipher-border">
      <div className="min-w-0 p-3 sm:p-4">
        {nodes.length ? <AddressBubbleMap key={`${address}:${mode}`} nodes={nodes} mode={mode} selectedId={selectedId} onSelect={setSelectedId} /> : <div className="h-[440px] flex flex-col items-center justify-center gap-3 p-6 text-center"><h3 className="text-primary font-medium">No {mode === 'recent' ? 'recent connections' : 'co-spend peers'} found</h3><p className="text-sm text-muted max-w-sm">The index has no connections to display in this view. This does not establish whether the address has other activity.</p></div>}
        <div className="px-2 pt-3 pb-1 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted">
          <span>{mode === 'cluster' ? 'Dashed links · inferred cluster membership' : 'Solid links · shared transaction activity'}</span>
          <span>Drag to rearrange · select to inspect · + / − to zoom</span>
        </div>
      </div>
      <aside aria-label="Connection inspector" className="border-t lg:border-t-0 lg:border-l border-cipher-border p-5 lg:max-h-[520px] lg:overflow-y-auto">
        {selected ? <div>
          <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold text-primary">{selected.label || 'Selected address'}</h3><button type="button" className="px-2 py-1 text-xs text-muted hover:text-primary" onClick={() => setSelectedId(null)}>Clear</button></div>
          <p className="mt-3 font-mono text-xs text-secondary break-all">{selected.id}</p>
          <p className="mt-3 text-xs text-muted">{mode === 'cluster' ? 'Inferred co-spend cluster member' : 'Appears in the recent transaction sample'}{mode === 'recent' && (selected.peer || cp?.sameEntity) ? ' · Also in the inferred cluster' : ''}</p>
          <dl className="mt-4 space-y-3 border-t border-cipher-border pt-4 text-xs">
            {mode === 'recent' && cp ? <>
              <div><dt className="text-muted">Associated input value</dt><dd className="mt-1 text-secondary font-mono">{amount(cp.receivedZec)} {CURRENCY}</dd></div>
              <div><dt className="text-muted">Associated output value</dt><dd className="mt-1 text-secondary font-mono">{amount(cp.sentZec)} {CURRENCY}</dd></div>
              <div><dt className="text-muted">Transactions in sample</dt><dd className="mt-1 text-secondary font-mono">{cp.txCount.toLocaleString('en-US')}</dd></div>
            </> : selected.peer ? <>
              <div><dt className="text-muted">Public balance</dt><dd className="mt-1 text-secondary font-mono">{amount(selected.peer.balanceZec)} {CURRENCY}</dd></div>
              <div><dt className="text-muted">Indexed transactions</dt><dd className="mt-1 text-secondary font-mono">{selected.peer.txCount.toLocaleString('en-US')}</dd></div>
            </> : null}
          </dl>
          <Link href={`/address/${selected.id}`} prefetch={false} className="mt-5 inline-flex rounded border border-cipher-border px-3 py-2 text-xs font-mono text-primary hover:bg-cipher-hover">Open address →</Link>
        </div> : <div><h3 className="text-sm font-semibold text-primary">Inspect a connection</h3><p className="mt-2 text-xs leading-relaxed text-muted">Select a node or choose an address below. Its details stay open while you explore.</p></div>}
        <div className="mt-5 border-t border-cipher-border pt-4">
          <label htmlFor="connection-search" className="text-xs text-muted">Find a displayed address or label</label>
          <input id="connection-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search connections…" className="mt-2 w-full rounded border border-cipher-border bg-cipher-bg px-3 py-2 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-cipher-gold" />
          <div className="mt-2 max-h-48 overflow-y-auto space-y-1" aria-label="Displayed connections">
            {visible.map(node => <button key={node.id} type="button" onClick={() => setSelectedId(node.id)} aria-pressed={selectedId === node.id} className={`w-full text-left rounded px-3 py-2 font-mono text-xs ${selectedId === node.id ? 'text-primary bg-cipher-hover' : 'text-secondary hover:bg-cipher-hover'}`}>
              <span className="block truncate">{node.label || short(node.id)}</span>{node.label && <span className="text-muted">{short(node.id)}</span>}
            </button>)}
            {!visible.length && <p className="py-3 text-xs text-muted">{query ? 'No matching connections.' : 'No addresses in this view.'}</p>}
          </div>
        </div>
      </aside>
    </div>
    <details className="group border-t border-cipher-border">
      <summary className="cursor-pointer px-5 sm:px-6 py-4 text-sm text-secondary hover:bg-cipher-hover">Data &amp; interpretation</summary>
      <div className="px-5 sm:px-6 pt-4 pb-6 text-xs leading-relaxed text-muted space-y-3">
        <p>Recent connections are the top 20 addresses by associated input/output value in a sample of up to {data.sampledRecentTxs ?? 300} recent indexed transactions. Input values belong to other addresses in transactions crediting this address; output values belong to other addresses in transactions spending from it. Multi-input transactions and change prevent these totals from being treated as exact payments between two addresses.</p>
        <p>Co-spend clusters use the common-input heuristic, which groups transparent addresses spent together. Membership can be indirect and is not proof of shared ownership. {clusterOmitted > 0 ? `${clusterOmitted.toLocaleString('en-US')} additional cluster members are not shown; the returned peers are ranked by balance.` : 'The map displays the cluster peers returned by the index.'}</p>
        <p>Node sizes are uniform and positions are for readability. Links do not represent live activity, geography or private shielded transfers.</p>
      </div>
    </details>
  </section>;
}
