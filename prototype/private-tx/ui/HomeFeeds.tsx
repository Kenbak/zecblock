import { useEffect, useRef, useState } from 'react';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { SlidersIcon } from '@/components/icons/common';
import { RelativeTimeProvider } from '@/components/RelativeTime';
import { RecentBlocksTable } from '@/components/RecentBlocksTable';
import { RecentTransactionsTable } from '@/components/RecentTransactionsTable';
import { RecentShieldedTable, type ShieldedTx } from '@/components/RecentShieldedTable';
import type { TransactionListItem } from '@/lib/transaction-list';

// The homepage feed, in the public homepage's design: the same signed bytes
// for every visitor, so showing it reveals nothing. Rows open as private
// lookups (their links become in-page fragments).
type FeedTx = {
  txid: string; block_height: number; block_time: number; tx_index: number;
  vin_count: number; vout_count: number; is_coinbase: boolean;
  has_sapling: boolean; has_orchard: boolean; has_ironwood: boolean; has_sprout: boolean;
  sapling_spend_count: number; sapling_output_count: number; orchard_actions: number; ironwood_actions: number;
  value_balance_sapling: string | null; value_balance_orchard: string | null; value_balance_ironwood: string | null;
  total_output: string | null;
};
export type Feed = {
  snapshotTip: number;
  blocks: { height: number; hash: string; timestamp: number; transaction_count: number; size: number }[];
  transactions: FeedTx[];
  shielded?: FeedTx[];
};

type FeedType = 'blocks' | 'shielded' | 'transactions';
const FEEDS: Record<FeedType, { section: string; menu: string }> = {
  blocks: { section: 'RECENT_BLOCKS', menu: 'Recent Blocks' },
  shielded: { section: 'SHIELDED_ACTIVITY', menu: 'Shielded Activity' },
  transactions: { section: 'RECENT_TRANSACTIONS', menu: 'Recent Transactions' },
};
const ROWS = 5;

const zec = (zat: string | null) => (zat ? Number(BigInt(zat)) / 1e8 : 0);
const listItem = (tx: FeedTx): TransactionListItem => ({
  txid: tx.txid, block_height: tx.block_height, block_time: tx.block_time, size: 0, tx_index: tx.tx_index,
  vin_count: tx.vin_count, vout_count: tx.vout_count, has_sapling: tx.has_sapling, has_orchard: tx.has_orchard,
  has_ironwood: tx.has_ironwood, has_sprout: tx.has_sprout, is_coinbase: tx.is_coinbase, value_balance: null,
  value_balance_sapling: tx.value_balance_sapling, value_balance_orchard: tx.value_balance_orchard,
  value_balance_ironwood: tx.value_balance_ironwood, total_output: tx.total_output, flow_type: null,
});
// Same shape and amount units (ZEC) as the public shielded summary.
const shieldedItem = (tx: FeedTx): ShieldedTx => ({
  txid: tx.txid, blockHeight: tx.block_height, blockTime: tx.block_time,
  hasSapling: tx.has_sapling, hasOrchard: tx.has_orchard, hasIronwood: tx.has_ironwood,
  saplingSpendCount: tx.sapling_spend_count, saplingOutputCount: tx.sapling_output_count,
  orchardActions: tx.orchard_actions, ironwoodActions: tx.ironwood_actions,
  vinCount: tx.vin_count, voutCount: tx.vout_count,
  valueBalanceSapling: zec(tx.value_balance_sapling), valueBalanceOrchard: zec(tx.value_balance_orchard),
  valueBalanceIronwood: zec(tx.value_balance_ironwood),
  type: tx.vin_count === 0 && tx.vout_count === 0 ? 'fully-shielded' : 'partial',
});

const CheckIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

function FeedCard({ feed, storageKey, defaultType }: { feed: Feed; storageKey: string; defaultType: FeedType }) {
  const [type, setType] = useState<FeedType>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved && saved in FEEDS ? saved as FeedType : defaultType;
    } catch { return defaultType; }
  });
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const select = (next: FeedType) => {
    setType(next);
    setOpen(false);
    try { localStorage.setItem(storageKey, next); } catch { /* the choice just won't persist */ }
  };

  return <div className="home-feed min-w-0">
    <SectionHeader label={FEEDS[type].section} size="lg" actions={
      <div className="relative" ref={menuRef}>
        <button type="button" onClick={() => setOpen(v => !v)} aria-label="Customize this card" aria-expanded={open}
          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-mono transition-colors ${open ? 'text-primary bg-cipher-hover' : 'text-muted hover:text-primary'}`}>
          <SlidersIcon className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Customize</span>
        </button>
        {open && <div className="absolute right-0 mt-1 w-60 dropdown-menu rounded-lg shadow-xl border p-1 z-30 animate-scale-in origin-top-right">
          {(Object.keys(FEEDS) as FeedType[]).map(option => <button key={option} type="button" onClick={() => select(option)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md text-data dropdown-item">
            {FEEDS[option].menu}
            {option === type && <CheckIcon />}
          </button>)}
        </div>}
      </div>
    } />
    {type === 'blocks' && <RecentBlocksTable blocks={feed.blocks.slice(0, ROWS).map(b => ({ height: b.height, timestamp: b.timestamp, transactions: b.transaction_count, size: b.size }))} />}
    {type === 'transactions' && <RecentTransactionsTable txs={feed.transactions.slice(0, ROWS).map(listItem)} />}
    {type === 'shielded' && <RecentShieldedTable txs={(feed.shielded ?? []).slice(0, ROWS).map(shieldedItem)} showLegend={false} />}
  </div>;
}

export function HomeFeeds({ feed }: { feed: Feed }) {
  return <div className="home-body max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-8 sm:pb-10 lg:pb-12">
    <RelativeTimeProvider initialNow={Date.now()}>
      <div className="home-feeds home-table-section grid grid-cols-1 lg:grid-cols-2 gap-8">
        <FeedCard feed={feed} storageKey="private-home-card-left" defaultType="blocks" />
        <FeedCard feed={feed} storageKey="private-home-card-right" defaultType="shielded" />
      </div>
    </RelativeTimeProvider>
  </div>;
}
