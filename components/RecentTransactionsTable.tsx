'use client';

import type { ReactNode } from 'react';
import type { TransactionListItem as Tx } from '@/lib/transaction-list';
import { RelativeTime } from '@/components/RelativeTime';
import { formatZecPrecise, zatToZec } from '@/lib/format-numbers';
import { ShieldFlowBadge } from '@/components/ShieldFlowBadge';
import { resolveShieldFlowType } from '@/components/icons/shield-flow';
import { HashLink, IconTooltip, RedactedAmount } from '@/components/ui';

const TransparentIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const CoinbaseIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v10M9.5 9.5c0-1.1 1.12-2 2.5-2s2.5.7 2.5 1.75-1.12 1.75-2.5 1.75-2.5.7-2.5 1.75S10.62 15 12 15s2.5-.9 2.5-2" />
  </svg>
);

/**
 * Icon + tooltip only — same compact treatment ShieldFlowBadge already uses
 * for shielded rows, extended to the two shapes that fall outside
 * ShieldFlowType (coinbase, plain transparent). Labeled "Flow" (direction:
 * shield/deshield/mixed/migration), matching /txs and RecentShieldedTxs —
 * "Type" is reserved app-wide for pool/category (TxTypeBadge), which this
 * homepage widget deliberately omits (see file header comment).
 */
export function FlowCell({ tx }: { tx: Tx }) {
  if (tx.is_coinbase) {
    return (
      <IconTooltip label="Coinbase" className="text-cipher-green">
        <CoinbaseIcon />
      </IconTooltip>
    );
  }
  if (!tx.has_orchard && !tx.has_sapling && !tx.has_ironwood && !tx.flow_type) {
    return (
      <IconTooltip label="Transparent" className="text-muted">
        <TransparentIcon />
      </IconTooltip>
    );
  }
  const type = resolveShieldFlowType({
    flowType: tx.flow_type,
    vinCount: tx.vin_count,
    voutCount: tx.vout_count,
    valueBalanceSapling: Number(tx.value_balance_sapling),
    valueBalanceOrchard: Number(tx.value_balance_orchard),
    valueBalanceIronwood: Number(tx.value_balance_ironwood),
  });
  return <ShieldFlowBadge type={type} variant="compact" />;
}

/**
 * Same public-data rule as RecentShieldedTxs / the block page's reward
 * breakdown: a transparent output is always public, a shield/deshield's
 * transparent-side value balance is public (needed for the binding-signature
 * balance equation), and a pool-to-pool migration's destination-pool balance
 * is public. A genuinely fully-shielded self-loop (spend and output in the
 * same pool, nothing else) has no public amount at all.
 */
export function knownAmountZec(tx: Tx): number | null {
  const sap = Number(tx.value_balance_sapling) || 0;
  const orc = Number(tx.value_balance_orchard) || 0;
  const irn = Number(tx.value_balance_ironwood) || 0;
  const transparentOutZat = Number(tx.total_output) || 0;

  if (tx.vin_count === 0 && tx.vout_count === 0) {
    const source = orc > 0 ? 'orchard' : sap > 0 ? 'sapling' : irn > 0 ? 'ironwood' : null;
    if (source) {
      const destZat = irn < 0 ? Math.abs(irn) : orc < 0 ? Math.abs(orc) : sap < 0 ? Math.abs(sap) : 0;
      if (destZat > 0) return zatToZec(destZat);
    }
  }

  const valueBalanceZat = sap + orc + irn;
  const shieldedDepositZat = valueBalanceZat < 0 ? Math.abs(valueBalanceZat) : 0;
  const totalZat = transparentOutZat + shieldedDepositZat;
  if (totalZat > 0) return zatToZec(totalZat);
  if (tx.is_coinbase) return zatToZec(totalZat); // legitimately zero, not unknown
  return null;
}

/**
 * The homepage "recent transactions" table — TxID / Flow / Amount / Age,
 * data-only so the public homepage and the private explorer (fed from its
 * signed feed) render the same design.
 */
export function RecentTransactionsTable({ txs, footer }: { txs: Tx[]; footer?: ReactNode }) {
  return (
    <div className="card p-0 overflow-hidden">
      {/* overflow-x-auto, not overflow-hidden: never silently clip a column, scroll instead */}
      <div className="overflow-x-auto no-scrollbar">
        {/* Live-row animations — DataTable lacks per-row classes; classes mirror its conventions */}
        <table className="w-full min-w-[420px]">
          <thead>
            <tr>
              <th className="px-4 sm:px-5 py-3.5 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">TxID</th>
              <th className="px-4 sm:px-5 py-3.5 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border w-12">Flow</th>
              <th className="px-4 sm:px-5 py-3.5 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Amount</th>
              <th className="px-4 sm:px-5 py-3.5 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Age</th>
            </tr>
          </thead>
          <tbody>
            {txs.map((tx, i) => {
              const amount = knownAmountZec(tx);
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
                      linkClassName="font-mono text-sm font-medium text-primary hover:underline transition-colors truncate"
                    />
                  </td>
                  <td className="px-4 sm:px-5 h-12 border-b border-cipher-border">
                    <FlowCell tx={tx} />
                  </td>
                  <td className="px-4 sm:px-5 h-12 border-b border-cipher-border text-right">
                    {amount !== null ? (
                      <span className="font-mono text-sm text-secondary whitespace-nowrap tabular-nums">{formatZecPrecise(amount)} <span className="text-muted">ZEC</span></span>
                    ) : (
                      <RedactedAmount />
                    )}
                  </td>
                  <td className="px-4 sm:px-5 h-12 border-b border-cipher-border text-right">
                    <RelativeTime timestamp={tx.block_time} className="text-sm text-muted whitespace-nowrap" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footer && <div className="px-4 py-3 border-t border-cipher-border flex items-center justify-center text-center">{footer}</div>}
    </div>
  );
}
