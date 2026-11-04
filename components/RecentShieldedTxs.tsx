'use client';

import { readApiData } from '@/lib/api-client';
import { useState, useEffect, useRef, memo, useCallback, type ReactNode } from 'react';
import { RelativeTime } from '@/components/RelativeTime';
import { formatZecPrecise } from '@/lib/format-numbers';
import { HomeFeedTableSkeleton } from '@/components/HomeFeedTableSkeleton';
import { getApiUrl } from '@/lib/api-config';
import { useWebSocket } from '@/hooks/useWebSocket';
import { ShieldFlowBadge, ShieldFlowLegend } from '@/components/ShieldFlowBadge';
import { resolveShieldFlowType } from '@/components/icons/shield-flow';
import { HashLink, RedactedAmount } from '@/components/ui';

interface ShieldedTx {
  txid: string;
  blockHeight: number;
  blockTime: number;
  hasSapling: boolean;
  hasOrchard: boolean;
  hasIronwood: boolean;
  saplingSpendCount: number;
  saplingOutputCount: number;
  orchardActions: number;
  ironwoodActions: number;
  vinCount: number;
  voutCount: number;
  valueBalanceSapling: number;
  valueBalanceOrchard: number;
  valueBalanceIronwood: number;
  type: 'fully-shielded' | 'partial';
}

/**
 * A pool-to-pool migration (e.g. Orchard -> Ironwood) has no transparent leg,
 * so it comes back from the API as `type: 'fully-shielded'` same as a truly
 * unknowable shielded spend — but it's not actually unknowable: the
 * binding-signature balance equation requires one pool's valueBalance to be
 * positive (source) and another's negative (dest), publicly, with nothing
 * left over for a transparent output or the fee to fully absorb. The dest
 * pool's balance is exactly the migrated amount.
 */
function migrationAmount(tx: ShieldedTx): number | null {
  if (tx.vinCount !== 0 || tx.voutCount !== 0) return null;
  const sap = tx.valueBalanceSapling || 0;
  const orc = tx.valueBalanceOrchard || 0;
  const irn = tx.valueBalanceIronwood || 0;
  const source = orc > 0 ? 'orchard' : sap > 0 ? 'sapling' : irn > 0 ? 'ironwood' : null;
  if (!source) return null;
  if (irn < 0 && source !== 'ironwood') return Math.abs(irn);
  if (orc < 0 && source !== 'orchard') return Math.abs(orc);
  if (sap < 0 && source !== 'sapling') return Math.abs(sap);
  return null;
}

/**
 * Amount ZecBlock is allowed to show for a shielded-activity row.
 *
 * For a `partial` (shield/deshield) tx, the transparent-side value balance is
 * public on-chain data — it has to be, or the transparent value pool couldn't
 * balance. Showing it isn't a privacy leak. Summed across all three pools
 * (Sapling, Orchard, Ironwood) since a tx's transparent leg can settle into
 * any of them.
 *
 * For a migration, see migrationAmount above — also public, for a different
 * reason (cross-pool balance, not a transparent leg).
 *
 * For a genuinely fully-shielded tx (spend and output both stay in the same
 * pool) there is no transparent leg and no other pool absorbing the balance,
 * so no amount is public. We render that as a redacted placeholder rather
 * than "0" — the amount isn't zero, it's unknowable, and the UI should say
 * so honestly.
 */
function getKnownAmount(tx: ShieldedTx): number | null {
  if (tx.type === 'partial') {
    const amount = Math.abs(tx.valueBalanceSapling || 0)
      + Math.abs(tx.valueBalanceOrchard || 0)
      + Math.abs(tx.valueBalanceIronwood || 0);
    return amount > 0 ? amount : null;
  }
  return migrationAmount(tx);
}

interface RecentShieldedTxsProps {
  nested?: boolean;
  initialTxs?: ShieldedTx[];
  limit?: number;
  showLegend?: boolean;
  /** Rendered inside the card, below the table/legend (e.g. a "View all" link) — same slot DataTable's own `footer` prop fills. */
  footer?: ReactNode;
}

export const RecentShieldedTxs = memo(function RecentShieldedTxs({
  nested = false,
  initialTxs = [],
  limit = 5,
  showLegend = true,
  footer,
}: RecentShieldedTxsProps) {
  const [txs, setTxs] = useState<ShieldedTx[]>(initialTxs);
  const [loading, setLoading] = useState(initialTxs.length === 0);
  const latestKey = useRef(initialTxs[0]?.txid ?? '');
  const loadedOnce = useRef(initialTxs.length > 0);
  const latestBlockHeight = useRef(initialTxs[0]?.blockHeight ?? 0);
  const fetchRef = useRef<() => void>(() => {});

  const fetchTxs = useCallback(async () => {
    try {
      const apiUrl = `${getApiUrl()}/v1/transactions/shielded-summary?limit=${limit}`;

      const response = await fetch(apiUrl);
      const data = await readApiData(response);
      if (data.transactions?.length) {
        const newTopTxid = data.transactions[0]?.txid;
        if (newTopTxid !== latestKey.current) {
          latestKey.current = newTopTxid;
          latestBlockHeight.current = data.transactions[0]?.blockHeight ?? 0;
          setTxs(data.transactions);
        }
      }
    } catch (error) {
      console.error('Error fetching shielded transactions:', error);
    } finally {
      if (!loadedOnce.current) {
        loadedOnce.current = true;
        setLoading(false);
      }
    }
  }, [limit]);

  fetchRef.current = fetchTxs;

  const handleWsMessage = useCallback((msg: any) => {
    if (msg.type === 'new_block' || msg.type === 'chain_tip') {
      const height = msg.data?.height;
      if (height && height > latestBlockHeight.current) {
        fetchRef.current();
      }
    }
  }, []);

  const { isConnected: wsConnected } = useWebSocket({ onMessage: handleWsMessage });

  useEffect(() => {
    if (initialTxs.length === 0) {
      fetchTxs();
    }

    const interval = setInterval(fetchTxs, wsConnected ? 60000 : 10000);
    return () => clearInterval(interval);
  }, [initialTxs.length, wsConnected, fetchTxs]);

  if (loading) {
    return <HomeFeedTableSkeleton rows={limit} footer={footer} nested={nested} />;
  }

  return (
    <div className={nested ? '' : 'card p-0 overflow-hidden'}>
      {/* overflow-x-auto, not overflow-hidden: never silently clip a column, scroll instead */}
      <div className="overflow-x-auto no-scrollbar">
        {/* Live-row animations — DataTable lacks per-row classes; classes mirror its conventions */}
        <table className="w-full min-w-[420px]">
          <thead>
            <tr>
              <th className="px-4 sm:px-5 py-3.5 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">TxID</th>
              {/* Shield/deshield/mixed/migration direction — "Flow" to match /txs's own naming for the exact same ShieldFlowBadge, not "Type" (that word means pool category everywhere else in the app). */}
              <th className="px-4 sm:px-5 py-3.5 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border w-12">Flow</th>
              <th className="px-4 sm:px-5 py-3.5 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Amount</th>
              <th className="px-4 sm:px-5 py-3.5 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Age</th>
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
                    <HashLink
                      value={tx.txid}
                      href={`/tx/${tx.txid}`}
                      lead={10}
                      tail={6}
                      responsive
                      accent="purple"
                      linkClassName="font-mono text-sm font-medium text-primary hover:underline transition-colors truncate"
                    />
                  </td>
                  <td className="px-4 sm:px-5 h-12 border-b border-cipher-border">
                    <ShieldFlowBadge
                      type={resolveShieldFlowType({
                        type: tx.type,
                        vinCount: tx.vinCount,
                        voutCount: tx.voutCount,
                        valueBalanceSapling: tx.valueBalanceSapling,
                        valueBalanceOrchard: tx.valueBalanceOrchard,
                        valueBalanceIronwood: tx.valueBalanceIronwood,
                      })}
                      variant="compact"
                    />
                  </td>
                  <td className="px-4 sm:px-5 h-12 border-b border-cipher-border text-right">
                    {knownAmount !== null ? (
                      <span className="font-mono text-sm text-secondary whitespace-nowrap tabular-nums">{formatZecPrecise(knownAmount)} <span className="text-muted">ZEC</span></span>
                    ) : (
                      <RedactedAmount />
                    )}
                  </td>
                  <td className="px-4 sm:px-5 h-12 border-b border-cipher-border text-right">
                    <RelativeTime timestamp={tx.blockTime} className="text-sm text-muted whitespace-nowrap" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {showLegend && <ShieldFlowLegend />}
      {footer && <div className="px-4 py-3 border-t border-cipher-border flex items-center justify-center text-center">{footer}</div>}
    </div>
  );
});
