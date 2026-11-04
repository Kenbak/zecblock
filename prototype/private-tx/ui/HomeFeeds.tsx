import { SectionHeader } from '@/components/ui/SectionHeader';
import { RelativeTimeProvider } from '@/components/RelativeTime';
import { RecentBlocksTable } from '@/components/RecentBlocksTable';
import { RecentTransactionsTable } from '@/components/RecentTransactionsTable';
import type { TransactionListItem } from '@/lib/transaction-list';

// The homepage feed, in the public homepage's design: the same signed bytes
// for every visitor, so showing it reveals nothing. Rows open as private
// lookups (their links become in-page fragments).
type FeedTx = {
  txid: string; block_height: number; block_time: number; tx_index: number;
  vin_count: number; vout_count: number; is_coinbase: boolean;
  has_sapling: boolean; has_orchard: boolean; has_ironwood: boolean; has_sprout: boolean;
  value_balance_sapling: string | null; value_balance_orchard: string | null; value_balance_ironwood: string | null;
  total_output: string | null;
};
export type Feed = {
  snapshotTip: number;
  blocks: { height: number; hash: string; timestamp: number; transaction_count: number; size: number }[];
  transactions: FeedTx[];
};

const ROWS = 5;

const listItem = (tx: FeedTx): TransactionListItem => ({
  txid: tx.txid, block_height: tx.block_height, block_time: tx.block_time, size: 0, tx_index: tx.tx_index,
  vin_count: tx.vin_count, vout_count: tx.vout_count, has_sapling: tx.has_sapling, has_orchard: tx.has_orchard,
  has_ironwood: tx.has_ironwood, has_sprout: tx.has_sprout, is_coinbase: tx.is_coinbase, value_balance: null,
  value_balance_sapling: tx.value_balance_sapling, value_balance_orchard: tx.value_balance_orchard,
  value_balance_ironwood: tx.value_balance_ironwood, total_output: tx.total_output, flow_type: null,
});

export function HomeFeeds({ feed }: { feed: Feed }) {
  return <div className="home-body max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-8 sm:pb-10 lg:pb-12">
    <RelativeTimeProvider initialNow={Date.now()}>
      <div className="home-feeds home-table-section grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="home-feed min-w-0">
          <SectionHeader label="RECENT_BLOCKS" size="lg" />
          <RecentBlocksTable blocks={feed.blocks.slice(0, ROWS).map(b => ({ height: b.height, timestamp: b.timestamp, transactions: b.transaction_count, size: b.size }))} />
        </div>
        <div className="home-feed min-w-0">
          <SectionHeader label="RECENT_TRANSACTIONS" size="lg" />
          <RecentTransactionsTable txs={(feed.transactions ?? []).filter(tx => 'vin_count' in tx).slice(0, ROWS).map(listItem)} />
        </div>
      </div>
    </RelativeTimeProvider>
  </div>;
}
