'use client';

import { useState } from 'react';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { HashLink } from '@/components/ui/HashLink';
import { TokenChainIcon } from '@/components/TokenChainIcon';
import { RelativeTime } from '@/components/RelativeTime';
import type { CrossChainActivity, CrossChainSwap } from './types';

export function CrossChainTable({ crossChain }: { crossChain: CrossChainActivity }) {
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(crossChain.swaps.length / pageSize));
  const current = Math.min(page, totalPages);
  const rows = crossChain.swaps.slice((current - 1) * pageSize, current * pageSize);
  const leg = (swap: CrossChainSwap, side: 'source' | 'dest') => {
    const token = side === 'source' ? swap.sourceToken : swap.destToken;
    const chain = side === 'source' ? swap.sourceChain : swap.destChain;
    const amount = side === 'source' ? swap.sourceAmount : swap.destAmount;
    return <div className="flex items-center gap-2 py-2 whitespace-nowrap"><TokenChainIcon token={token} chain={chain} size={22} /><div>
      <p className="text-xs font-mono text-primary">{amount.toLocaleString('en-US', { maximumFractionDigits: 8 })} {token}</p><p className="text-xs text-muted mt-0.5">{chain}</p>
    </div></div>;
  };
  const columns: DataTableColumn<CrossChainSwap>[] = [
    { id: 'tx', header: 'Zcash transaction', cell: swap => swap.zecTxid ? <HashLink value={swap.zecTxid} href={`/tx/${swap.zecTxid}`} lead={10} tail={6} responsive copy={false} /> : <span className="text-xs text-muted">Unavailable</span> },
    { id: 'direction', header: 'Direction', cell: swap => <span className={`text-xs font-mono whitespace-nowrap ${swap.direction === 'inflow' ? 'text-cipher-green' : swap.direction === 'outflow' ? 'text-danger' : 'text-muted'}`}>{swap.direction === 'inflow' ? '↓ Into Zcash' : swap.direction === 'outflow' ? '↑ Out of Zcash' : swap.direction}</span> },
    { id: 'source', header: 'From', cell: swap => leg(swap, 'source') },
    { id: 'destination', header: 'To', cell: swap => leg(swap, 'dest') },
    { id: 'value', header: 'Source value (USD)', align: 'right', cell: swap => <span className="text-xs font-mono text-secondary whitespace-nowrap">${swap.sourceAmountUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span> },
    { id: 'age', header: 'Age', align: 'right', cell: swap => <RelativeTime timestamp={swap.timestamp / 1000} className="text-xs text-muted whitespace-nowrap" /> },
  ];
  return <section aria-label="Address bridges" className="space-y-4">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-base font-semibold text-primary">Bridge activity</h2><p className="text-xs text-muted">Recorded cross-chain swaps associated with this address</p></div>
    <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm font-mono text-secondary">
      <span>{crossChain.swaps.length.toLocaleString('en-US')} returned records</span>
      <span>${crossChain.totalVolumeUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })} <span className="text-xs text-muted">recorded volume</span></span>
      <span>{crossChain.entryCount} in <span className="text-muted">/</span> {crossChain.exitCount} out</span>
    </div>
    <DataTable columns={columns} rows={rows} rowKey={swap => swap.id} size="comfortable" empty={<p className="p-8 text-sm text-center text-muted">No bridge records available.</p>}
      footer={<p className="px-4 py-3 text-xs text-muted">Indexed bridge records only, not all cross-chain activity.</p>} />
    {totalPages > 1 && <nav aria-label="Bridge pagination" className="flex flex-wrap items-center justify-between gap-3 py-2">
      <p className="text-xs text-muted">{(current - 1) * pageSize + 1}–{Math.min(current * pageSize, crossChain.swaps.length)} of {crossChain.swaps.length} records</p>
      <div className="flex items-center gap-3 text-xs font-mono">
        <button type="button" disabled={current === 1} onClick={() => setPage(current - 1)} className="rounded border border-cipher-border px-3 py-2 text-secondary hover:bg-cipher-hover disabled:opacity-40">← Previous</button>
        <span className="text-muted">{current} / {totalPages}</span>
        <button type="button" disabled={current === totalPages} onClick={() => setPage(current + 1)} className="rounded border border-cipher-border px-3 py-2 text-secondary hover:bg-cipher-hover disabled:opacity-40">Next →</button>
      </div>
    </nav>}
  </section>;
}
