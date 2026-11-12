import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { RedactedAmount } from '@/components/ui';
import { RelativeTimeProvider } from '@/components/RelativeTime';
import { RecentBlocksTable } from '@/components/RecentBlocksTable';
import { FlowCell, RecentTransactionsTable, knownAmountZec } from '@/components/RecentTransactionsTable';
import { formatBytesCompact, formatZecPrecise } from '@/lib/format-numbers';
import { formatRelativeTime } from '@/lib/utils';
import type { TransactionListItem } from '@/lib/transaction-list';

// The homepage feed, in the public homepage's design: the same signed bytes
// for every visitor, so showing it reveals nothing. Rows open as private
// lookups (their links become in-page fragments). Until the feed has been
// fetched and its signature checked, the cards show cipher text that then
// decrypts into the real values.
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
// A cell is text that decrypts character by character, or one of the real
// table's own components (flow icons, redacted amount) that appears when
// its cipher text has run out.
type Cell = string | { node: ReactNode; width: number };
const GLYPHS = '0123456789abcdef';
const REVEAL_MS = 520;
const ROW_STAGGER_MS = 70;

const listItem = (tx: FeedTx): TransactionListItem => ({
  txid: tx.txid, block_height: tx.block_height, block_time: tx.block_time, size: 0, tx_index: tx.tx_index,
  vin_count: tx.vin_count, vout_count: tx.vout_count, has_sapling: tx.has_sapling, has_orchard: tx.has_orchard,
  has_ironwood: tx.has_ironwood, has_sprout: tx.has_sprout, is_coinbase: tx.is_coinbase, value_balance: null,
  value_balance_sapling: tx.value_balance_sapling, value_balance_orchard: tx.value_balance_orchard,
  value_balance_ironwood: tx.value_balance_ironwood, total_output: tx.total_output, flow_type: null,
});

// The same text the real table's RelativeTime renders, so nothing changes at the swap.
const age = (seconds: number) => formatRelativeTime(seconds, Date.now());

const wide = () => {
  try { return window.matchMedia('(min-width: 640px)').matches; } catch { return true; }
};

const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

// `th` and `copySpace` mirror the real table: the Flow header's w-12, and the
// width HashLink keeps for its hover-only copy button (gap-1 + 20 px button).
type Column = { label: string; align: 'left' | 'right'; width: number; className?: string; th?: string; copySpace?: boolean };
const BLOCK_COLUMNS: Column[] = [
  { label: 'Block', align: 'left', width: 10, className: 'font-mono text-sm font-medium text-primary tabular-nums' },
  { label: 'Size', align: 'right', width: 7, className: 'font-mono text-xs text-muted tabular-nums' },
  { label: 'TXs', align: 'right', width: 2, className: 'font-mono text-sm text-primary tabular-nums' },
  { label: 'Age', align: 'right', width: 9, className: 'text-sm text-muted' },
];
const TX_COLUMNS: Column[] = [
  { label: 'TxID', align: 'left', width: 19, className: 'font-mono text-sm font-medium text-primary tabular-nums', copySpace: true },
  { label: 'Flow', align: 'left', width: 2, className: 'font-mono text-sm text-muted', th: 'w-12' },
  { label: 'Amount', align: 'right', width: 12, className: 'font-mono text-sm text-secondary tabular-nums' },
  { label: 'Age', align: 'right', width: 9, className: 'text-sm text-muted' },
];

const scramble = (length: number) => Array.from({ length }, () => GLYPHS[Math.floor(Math.random() * 16)]).join('');

/**
 * The card's table shape filled with cipher text. With `targets`, each cell
 * decrypts left to right (rows staggered) and `onDone` fires when every cell
 * shows its real value, so the real table can replace it without a jump.
 */
function CipherTable({ columns, targets, onDone }: { columns: Column[]; targets: Cell[][] | null; onDone: () => void }) {
  const [, tick] = useState(0);
  const started = useRef<number | null>(null);
  const done = useRef(false);
  const still = useMemo(reducedMotion, []);

  useEffect(() => {
    if (targets && started.current === null) started.current = performance.now();
    if (targets && still && !done.current) { done.current = true; onDone(); return; }
    if (still) return;
    const id = window.setInterval(() => {
      tick(n => n + 1);
      if (targets && started.current !== null && !done.current
          && performance.now() - started.current > REVEAL_MS + ROW_STAGGER_MS * (ROWS - 1) + 120) {
        done.current = true;
        onDone();
      }
    }, 45);
    return () => window.clearInterval(id);
  }, [targets, still, onDone]);

  const now = performance.now();
  return <div className="card p-0 overflow-hidden private-cipher" aria-hidden="true">
    <div className="overflow-x-auto no-scrollbar">
      <table className="w-full min-w-[420px]">
        <thead><tr>
          {columns.map(c => <th key={c.label} className={`px-4 sm:px-5 py-3.5 ${c.align === 'right' ? 'text-right' : 'text-left'} text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border ${c.th ?? ''}`}>{c.label}</th>)}
        </tr></thead>
        <tbody>
          {Array.from({ length: ROWS }, (_, row) => <tr key={row}>
            {columns.map((c, col) => {
              const target = targets?.[row]?.[col];
              const progress = target === undefined || started.current === null ? 0
                : Math.min(1, Math.max(0, (now - started.current - row * ROW_STAGGER_MS) / REVEAL_MS));
              const cellClass = `px-4 sm:px-5 h-12 border-b border-cipher-border whitespace-nowrap ${c.align === 'right' ? 'text-right' : ''}`;
              if (typeof target === 'object' && progress >= 1) return <td key={c.label} className={cellClass}>{target.node}</td>;
              const length = typeof target === 'object' ? target.width : target?.length ?? c.width;
              const shown = Math.floor(progress * length);
              const plain = typeof target === 'string' ? target.slice(0, shown) : '';
              const hidden = typeof target === 'object' ? length : Math.max(0, length - shown);
              const cipher = still ? '·'.repeat(hidden) : scramble(hidden);
              return <td key={c.label} className={cellClass}>
                <span className={c.className}>{plain}</span><span className="private-cipher-glyphs font-mono text-sm">{cipher}</span>{c.copySpace && <span className="inline-block w-5 h-5 ml-1 align-middle" />}
              </td>;
            })}
          </tr>)}
        </tbody>
      </table>
    </div>
    <StatusFooter text={targets ? '> signature ok · decrypting' : '> verifying ed25519 signature'} cursor />
  </div>;
}

// Same box as the real table's footer, so the card keeps its height at the swap.
const StatusFooter = ({ text, cursor = false }: { text: string; cursor?: boolean }) =>
  <div className="px-4 py-3 border-t border-cipher-border flex items-center justify-center text-center">
    <span className="private-cipher-status">{text}{cursor && <span className="private-cursor" />}</span>
  </div>;
export const VERIFIED_FOOTER = <span className="private-cipher-status">{'> signature ok · decrypted'}</span>;

function blockTargets(feed: Feed) {
  return feed.blocks.slice(0, ROWS).map(b => [`#${b.height.toLocaleString()}`, b.size > 0 ? formatBytesCompact(b.size) : '—', String(b.transaction_count), age(b.timestamp)]);
}
function txTargets(feed: Feed) {
  return feed.transactions.slice(0, ROWS).map(listItem).map(tx => {
    const amount = knownAmountZec(tx);
    // HashLink's responsive truncation: 8/4 below the sm breakpoint, 10/6 above.
    const [lead, tail] = wide() ? [10, 6] : [8, 4];
    return [`${tx.txid.slice(0, lead)}...${tx.txid.slice(-tail)}`, { node: <FlowCell tx={tx} />, width: 2 }, amount === null ? { node: <RedactedAmount />, width: 11 } : `${formatZecPrecise(amount)} ZEC`, age(tx.block_time ?? 0)];
  });
}

function FeedCard({ label, columns, targets, children }: { label: string; columns: Column[]; targets: Cell[][] | null; children: React.ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  const reveal = useCallback(() => setRevealed(true), []);
  return <div className="home-feed min-w-0">
    <SectionHeader label={label} size="lg" />
    {/* private-revealed turns off the rows' entrance animation: they replace text already on screen. */}
    {revealed ? <div className="private-revealed">{children}</div> : <CipherTable columns={columns} targets={targets} onDone={reveal} />}
  </div>;
}

export function HomeFeeds({ feed }: { feed: Feed | null }) {
  const usable = feed && feed.transactions.every(tx => 'vin_count' in tx) ? feed : null;
  const blocks = useMemo(() => usable && blockTargets(usable), [usable]);
  const txs = useMemo(() => usable && txTargets(usable), [usable]);
  return <div className="home-body max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-8 sm:pb-10 lg:pb-12">
    <RelativeTimeProvider initialNow={Date.now()}>
      <div className="home-feeds home-table-section grid grid-cols-1 lg:grid-cols-2 gap-8">
        <FeedCard label="RECENT_BLOCKS" columns={BLOCK_COLUMNS} targets={blocks}>
          {usable && <RecentBlocksTable footer={VERIFIED_FOOTER} blocks={usable.blocks.slice(0, ROWS).map(b => ({ height: b.height, timestamp: b.timestamp, transactions: b.transaction_count, size: b.size }))} />}
        </FeedCard>
        <FeedCard label="RECENT_TRANSACTIONS" columns={TX_COLUMNS} targets={txs}>
          {usable && <RecentTransactionsTable footer={VERIFIED_FOOTER} txs={usable.transactions.slice(0, ROWS).map(listItem)} />}
        </FeedCard>
      </div>
    </RelativeTimeProvider>
  </div>;
}
