import { useMemo } from 'react';
import { AddressHeader } from '@/app/address/[address]/components/AddressHeader';
import { AddressHeroCard } from '@/app/address/[address]/components/AddressHeroCard';
import { TransactionTable } from '@/app/address/[address]/components/TransactionTable';
import type { AddressData, Transaction } from '@/app/address/[address]/components/types';

export type PrivateAddressTx = { txid: string; block_height: number; block_time: number; value_in: string; value_out: string };
export type PrivateAddress = {
  address: string; balance: string; total_received: string; total_sent: string; tx_count: number;
  first_seen: number; last_seen: number; pages: number; loadedPages: number; recentTruncated: boolean;
  transactions: PrivateAddressTx[];
};

const zec = (zat: bigint) => Number(zat) / 1e8;

// Shaped like the public page's AddressData, from the locally verified record.
function toAddressData(a: PrivateAddress): AddressData {
  const transactions: Transaction[] = a.transactions.map(tx => {
    const change = BigInt(tx.value_out) - BigInt(tx.value_in);
    return { txid: tx.txid, blockHeight: tx.block_height, timestamp: tx.block_time, amount: Math.abs(zec(change)), type: change < 0n ? 'sent' : 'received' };
  });
  return {
    address: a.address, balance: zec(BigInt(a.balance)), type: 'transparent', transactions, transactionCount: a.tx_count,
    firstSeen: a.first_seen || null, lastSeen: a.last_seen || null,
  };
}

// Mirrors the public address page: header, balance card, history. Older
// history loads one page per private request, only when asked.
export function AddressView({ address, loadingMore, onLoadMore }: { address: PrivateAddress; loadingMore: boolean; onLoadMore: () => void }) {
  const data = useMemo(() => toAddressData(address), [address]);
  const more = address.loadedPages < address.pages;
  return <div id="result-section" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-5 pb-12 animate-fade-in">
    <h1 className="sr-only">Zcash address {address.address}</h1>
    <AddressHeader address={address.address} data={data} typeInfo={{ label: 'TRANSPARENT', color: 'gold', description: 'Transparent address' }} />
    <p className="mb-5 font-mono text-sm text-primary break-all">{address.address}</p>
    <AddressHeroCard data={data} priceData={null} crossChain={null} totalTxCount={address.tx_count} />
    <TransactionTable address={address.address} data={data} currentPage={1} totalPages={1} pageSize={data.transactions.length} totalTxCount={address.tx_count} pagination={null} />
    {address.recentTruncated && <p className="mt-3 text-xs text-muted">Very active since the last snapshot: only the newest recent transactions are listed. Balance and counts are complete.</p>}
    {more && <div className="mt-4 flex items-center justify-between gap-3 private-partial" id="partial-warning">
      <span>Showing {data.transactions.length.toLocaleString()} of {address.tx_count.toLocaleString()} transactions.</span>
      <button type="button" id="load-more" className="private-partial-action" disabled={loadingMore} onClick={onLoadMore}
        title="Fetches one more page of history with a private request. The server can see that a page was loaded, not for which address.">
        {loadingMore ? 'Loading…' : 'Load more'}
      </button>
    </div>}
  </div>;
}
