import { useMemo, useRef, useState } from 'react';
import { BlockPageHeader } from '@/app/block/[height]/components/BlockPageHeader';
import { BlockFactsCard } from '@/app/block/[height]/components/BlockFactsCard';
import { BlockTransactionsSection } from '@/app/block/[height]/components/BlockTransactionsSection';
import { transformExpressBlockData } from '@/app/block/[height]/components/transformBlockData';
import { getCoinbaseClientEmoji, getCoinbaseClientInfo } from '@/lib/coinbase-client';

export type BlockPartial = { rows: number; shownTransactions: number; totalTransactions: number };

type PrivateBlockTx = {
  txid: string; is_coinbase: boolean; vin_count: number; vout_count: number; total_output: string | null;
  first_input_address: string | null; first_output_address: string | null; [key: string]: unknown;
};
export type PrivateBlock = { height: number; transactions: PrivateBlockTx[]; confirmations: number; [key: string]: unknown };

// The block record carries a summary per transaction, not every input and
// output. Shape it the way the public page's transform expects: the right
// counts, the first addresses, and the transparent output total on the first
// output, which is what the list displays.
function toApiShape(block: PrivateBlock) {
  return {
    ...block,
    transactions: block.transactions.map(tx => ({
      ...tx,
      inputs: tx.is_coinbase ? [] : Array.from({ length: tx.vin_count }, (_, i) => (i === 0 && tx.first_input_address ? { address: tx.first_input_address } : {})),
      outputs: Array.from({ length: tx.vout_count }, (_, i) => i === 0
        ? { vout_index: 0, address: tx.first_output_address, value: tx.total_output }
        : { vout_index: i, value: null }),
    })),
  };
}

// Mirrors app/block/[height]/BlockPageClient, fed by the locally decoded record.
export function BlockView({ block, partial, loadingFull, onLoadFull }: { block: PrivateBlock; partial: BlockPartial | null; loadingFull: boolean; onLoadFull: () => void }) {
  const data = useMemo(() => transformExpressBlockData(toApiShape(block)), [block]);
  const [showMoreDetails, setShowMoreDetails] = useState(false);
  const txSectionRef = useRef<HTMLDivElement | null>(null);
  return <div id="result-section" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 md:py-8 animate-fade-in">
    <h1 className="sr-only">Zcash block {block.height}</h1>
    <BlockPageHeader data={data} />
    <BlockFactsCard
      data={data}
      showMoreDetails={showMoreDetails}
      onToggleMoreDetails={() => setShowMoreDetails(value => !value)}
      onScrollToTransactions={() => txSectionRef.current?.scrollIntoView({ behavior: 'smooth' })}
      coinbaseClientEmoji={getCoinbaseClientEmoji(null)}
      coinbaseClientInfo={getCoinbaseClientInfo(null)}
    />
    {partial && <div id="partial-warning" className="private-partial mb-6" role="status">
      <span>Showing the first {partial.shownTransactions.toLocaleString()} of {partial.totalTransactions.toLocaleString()} transactions.</span>
      <button type="button" id="load-full" className="private-partial-action" disabled={loadingFull} onClick={onLoadFull}
        title={`Fetches ${partial.rows} more encrypted rows. The server still can't see which block, only that it is a large one.`}>
        {loadingFull ? 'Loading…' : 'Load all'}
      </button>
    </div>}
    <BlockTransactionsSection ref={txSectionRef} data={data} />
  </div>;
}
