'use client';

import { useState, useEffect, useCallback, memo, type ReactNode } from 'react';
import { formatRelativeTime } from '@/lib/utils';
import { formatZecPrecise, formatBytesCompact } from '@/lib/format-numbers';
import { useWebSocket } from '@/hooks/useWebSocket';
import { HashLink, RedactedAmount, SkeletonTable, TxTypeBadge, resolveTxCategory } from '@/components/ui';
import { useApiQuery } from '@/hooks/useApiQuery';

interface MempoolTx {
  txid: string;
  size: number;
  type: 'transparent' | 'shielded' | 'mixed';
  time: number;
  totalOutput?: number;
  hasIronwood?: boolean;
  hasOrchard?: boolean;
  hasSapling?: boolean;
  valueBalanceSapling?: number;
  valueBalanceOrchard?: number;
  valueBalanceIronwood?: number;
}

interface MempoolStats {
  total: number;
  shieldedPercentage: number;
  totalSizeBytes: number;
}

// Pool-specific whenever the data allows (IRONWOOD/ORCHARD/SAPLING, same as
// every confirmed-tx table); generic SHIELDED only when the per-pool flags
// aren't available on this row.
function getTypeBadge(tx: MempoolTx) {
  if (tx.type === 'mixed') return <TxTypeBadge category="mixed" />;
  if (tx.type !== 'shielded') return <TxTypeBadge category="transparent" />;
  return (
    <TxTypeBadge
      category={resolveTxCategory({
        hasIronwood: tx.hasIronwood,
        hasOrchard: tx.hasOrchard,
        hasSapling: tx.hasSapling,
      })}
    />
  );
}

function classifyTxType(tx: any): 'shielded' | 'mixed' | 'transparent' {
  const hasShielded = tx.hasOrchard || tx.hasSapling || tx.hasIronwood;
  const hasTransparent = (tx.inputCount || 0) > 0 || (tx.outputCount || 0) > 0;
  if (hasShielded && hasTransparent) return 'mixed';
  if (hasShielded) return 'shielded';
  return 'transparent';
}

/**
 * Amount ZecBlock is allowed to show for a pending mempool row — same rule
 * as the confirmed shielded-activity table (see RecentShieldedTxs.tsx):
 * transparent value is always public, a shield/deshield's transparent-side
 * value balance is public, a fully-shielded tx's amount is not.
 */
function getKnownAmount(tx: MempoolTx): number | null {
  if (tx.type === 'transparent') {
    return (tx.totalOutput || 0) > 0 ? tx.totalOutput! : null;
  }
  if (tx.type === 'mixed') {
    const amount = Math.abs(tx.valueBalanceSapling || 0)
      + Math.abs(tx.valueBalanceOrchard || 0)
      + Math.abs(tx.valueBalanceIronwood || 0);
    return amount > 0 ? amount : null;
  }
  return null;
}

interface MempoolResponse {
  transactions?: Array<MempoolTx & { orchardActions?: number; ironwoodActions?: number; vShieldedSpend?: number; vShieldedOutput?: number }>;
  stats?: { total?: number; shieldedPercentage?: number };
}

export const RecentMempool = memo(function RecentMempool({ footer }: { footer?: ReactNode } = {}) {
  const [txs, setTxs] = useState<MempoolTx[]>([]);
  const [stats, setStats] = useState<MempoolStats | null>(null);
  const [loading, setLoading] = useState(true);

  const handleWsMessage = useCallback((msg: any) => {
    if (msg.type === 'mempool_tx' && msg.data?.txid) {
      const tx: MempoolTx = {
        txid: msg.data.txid,
        size: msg.data.size || 0,
        type: classifyTxType(msg.data),
        time: msg.data.time || Math.floor(Date.now() / 1000),
        totalOutput: msg.data.totalOutput || 0,
        hasIronwood: !!msg.data.hasIronwood,
        hasOrchard: !!msg.data.hasOrchard,
        hasSapling: !!msg.data.hasSapling,
        valueBalanceSapling: msg.data.valueBalanceSapling || 0,
        valueBalanceOrchard: msg.data.valueBalanceOrchard || 0,
        valueBalanceIronwood: msg.data.valueBalanceIronwood || 0,
      };
      setTxs(prev => [tx, ...prev.filter(existing => existing.txid !== tx.txid)].slice(0, 5));
      setLoading(false);
    } else if (msg.type === 'mempool_removed' && msg.data?.txid) {
      setTxs(prev => prev.filter(t => t.txid !== msg.data.txid));
    }
  }, []);

  useWebSocket({ onMessage: handleWsMessage });

  // Shares the stats bar's /v1/mempool poll; WebSocket messages update the
  // list between polls.
  const mempoolQuery = useApiQuery<MempoolResponse>('/v1/mempool', undefined, { refreshInterval: 30_000 });
  const result = mempoolQuery.data;
  const settled = mempoolQuery.data !== null || mempoolQuery.error !== null;

  useEffect(() => {
    try {
      if (result) {
        // REST rows carry per-pool activity as counts — normalize to the same
        // boolean flags the WebSocket path uses.
        const allTxs = (result.transactions || []).map((tx) => ({
          ...tx,
          hasIronwood: !!tx.hasIronwood || (tx.ironwoodActions || 0) > 0,
          hasOrchard: (tx.orchardActions || 0) > 0,
          hasSapling: (tx.vShieldedSpend || 0) > 0 || (tx.vShieldedOutput || 0) > 0,
        }));
        setTxs(allTxs.slice(0, 5));
        if (result.stats) {
          // Sum size across every fetched tx (not just the 5 shown) so the
          // backlog total is accurate even though the table only lists 5 rows.
          const totalSizeBytes = allTxs.reduce((sum: number, tx) => sum + (tx.size || 0), 0);
          setStats({
            total: result.stats.total ?? 0,
            shieldedPercentage: result.stats.shieldedPercentage ?? 0,
            totalSizeBytes,
          });
        }
      }
    } catch (error) {
      console.error('Error reading mempool:', error);
    } finally {
      if (settled) setLoading(false);
    }
  }, [result, settled]);

  if (loading) {
    return (
      <div className="card p-0 overflow-hidden">
        <SkeletonTable rows={5} rowHeight="h-12" headers={["Type", "TXID", "Amount", "Size", "Waiting"]} columnClasses={["", "", "", "hidden sm:table-cell", ""]} />
        {footer && <div className="px-4 py-3 border-t border-cipher-border text-center">{footer}</div>}
      </div>
    );
  }

  // Mempool txs have no block yet by definition — that's what "pending" means.
  // Showing the total backlog size (vs. Zcash's block capacity) is a more
  // honest signal than a fabricated block number: a few KB clears in one
  // block, a multi-MB backlog will take several.
  const summary = stats && stats.total > 0
    ? `${stats.total.toLocaleString()} pending (${formatBytesCompact(stats.totalSizeBytes)}) · ${stats.shieldedPercentage}% shielded`
    : null;

  if (txs.length === 0) {
    return (
      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-8 text-center text-sm text-muted font-mono">
          No pending transactions
        </div>
        {footer && <div className="px-4 py-3 border-t border-cipher-border text-center">{footer}</div>}
      </div>
    );
  }

  return (
    <div className="card p-0 overflow-hidden">
      {summary && (
        <div className="px-4 sm:px-5 py-2.5 text-caption font-mono text-muted border-b border-cipher-border">
          {summary}
        </div>
      )}
      {/* overflow-x-auto, not overflow-hidden: never silently clip a column, scroll instead */}
      <div className="overflow-x-auto no-scrollbar">
        {/* Live-row animations — DataTable lacks per-row classes; classes mirror its conventions */}
        <table className="w-full min-w-[480px]">
          <thead>
            <tr>
              <th className="px-4 sm:px-5 py-3.5 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Type</th>
              <th className="px-4 sm:px-5 py-3.5 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">TxID</th>
              <th className="px-4 sm:px-5 py-3.5 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Amount</th>
              <th className="px-4 sm:px-5 py-3.5 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border hidden sm:table-cell">Size</th>
              <th className="px-4 sm:px-5 py-3.5 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border" title="Not yet in a block — time spent waiting to be confirmed">Waiting</th>
            </tr>
          </thead>
          <tbody>
            {txs.map((tx, i) => {
              const knownAmount = getKnownAmount(tx);
              return (
              <tr
                key={tx.txid}
                className="group transition-colors duration-100 hover:bg-cipher-hover animate-fade-in-up"
                style={{ animationDelay: `${i * 30}ms` }}
              >
                <td className="px-4 sm:px-5 h-12 border-b border-cipher-border">
                  {getTypeBadge(tx)}
                </td>
                <td className="px-4 sm:px-5 h-12 border-b border-cipher-border">
                  <HashLink value={tx.txid} href={`/tx/${tx.txid}`} lead={10} tail={6} responsive />
                </td>
                <td className="px-4 sm:px-5 h-12 border-b border-cipher-border text-right">
                  {knownAmount !== null ? (
                    <span className="font-mono text-sm text-secondary whitespace-nowrap tabular-nums">{formatZecPrecise(knownAmount)} <span className="text-muted">ZEC</span></span>
                  ) : (
                    <RedactedAmount />
                  )}
                </td>
                <td className="px-4 sm:px-5 h-12 border-b border-cipher-border text-right hidden sm:table-cell">
                  <span className="font-mono text-xs text-muted tabular-nums">{(tx.size / 1024).toFixed(2)} KB</span>
                </td>
                <td className="px-4 sm:px-5 h-12 border-b border-cipher-border text-right">
                  <span className="text-sm text-muted whitespace-nowrap">{formatRelativeTime(tx.time)}</span>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footer && <div className="px-4 py-3 border-t border-cipher-border text-center">{footer}</div>}
    </div>
  );
});
