import { forwardRef } from 'react';
import { Badge, DataTable, HashLink, RedactedAmount, TxTypeBadge, type DataTableColumn, type TxCategory } from '@/components/ui';
import { StakingActionBadge } from '@/components/StakingActionBadge';
import { zatToZec } from '@/lib/format-numbers';
import { CURRENCY } from '@/lib/config';
import type { BlockData } from './types';

/** Same category registry as every other Type column in the app — see TxTypeBadge. */
function poolBadge(tx: any) {
  if (tx.staking_action_type) return <StakingActionBadge type={tx.staking_action_type} compact />;
  const category: TxCategory = tx.vin?.[0]?.coinbase
    ? 'coinbase'
    : tx.has_ironwood
      ? 'ironwood'
      : tx.has_orchard
        ? 'orchard'
        : tx.has_sapling
          ? 'sapling'
          : 'transparent';
  return <TxTypeBadge category={category} />;
}

/** Sapling/Orchard/Ironwood pool label -> the same category TxTypeBadge uses
 *  elsewhere, so a "From: Orchard" cell here carries the exact color/icon as
 *  the Type badge on this same row instead of a separate, uncoordinated
 *  color scale. */
function poolLabelCategory(pool: string): TxCategory {
  if (pool === 'Ironwood') return 'ironwood';
  if (pool === 'Orchard') return 'orchard';
  return 'sapling';
}

function poolBalances(tx: any) {
  return {
    sap: parseInt(tx.value_balance_sapling || 0),
    orc: parseInt(tx.value_balance_orchard || 0),
    irn: parseInt(tx.value_balance_ironwood || 0),
  };
}

function sourcePoolLabel(tx: any): string | null {
  const { sap, orc, irn } = poolBalances(tx);
  if (orc > 0) return 'Orchard';
  if (sap > 0) return 'Sapling';
  if (irn > 0) return 'Ironwood';
  return null;
}

function hasTransparentOutput(tx: any): boolean {
  return (tx.vout || []).some((o: any) => (o.value || 0) > 0);
}

/**
 * The "destination" output for display — not always vout[0]. Some
 * transactions carry a zero-value, no-address output before the real
 * recipient (e.g. an empty/OP_RETURN-style output), and vout[0] alone can
 * land on that placeholder instead of the actual recipient, making a normal
 * transfer render as if it had no destination at all.
 */
function firstOutputAddress(tx: any): string | undefined {
  return (tx.vout || []).find((o: any) => o.scriptPubKey?.addresses?.[0])?.scriptPubKey?.addresses?.[0];
}

function destPoolLabel(tx: any): string | null {
  const { sap, orc, irn } = poolBalances(tx);
  if (irn < 0) return 'Ironwood';
  if (orc < 0) return 'Orchard';
  if (sap < 0) return 'Sapling';

  // No pool shows a net arrival and no transparent output exists either —
  // by the binding-signature balance equation (public, even for fully-shielded
  // txs), whatever nominally "left" the source pool can only have covered the
  // fee. It never actually left the pool: a self-contained spend-and-return,
  // not an unknown destination, so show the source pool as the destination
  // too rather than "—" (which reads as "hidden/unknown").
  if (!hasTransparentOutput(tx)) {
    const source = sourcePoolLabel(tx);
    if (source) return source;
  }
  return null;
}

/**
 * The transparent-side value balance is public consensus data (needed for
 * the binding-signature balance equation), not a private spend — same rule
 * as the tx-detail and homepage tables. A fully-shielded tx has genuinely no
 * known amount and gets RedactedAmount instead of a fabricated number.
 *
 * Pool-to-pool migrations (Orchard -> Ironwood) are a special case: source
 * and destination value balances net to ~0 when summed, but the destination
 * pool's balance alone is the publicly-known migration amount — same rule
 * tx-summary/TxHeroFlow use for the MIGRATION tx type.
 */
function knownAmount(tx: any): number | null {
  const isCoinbase = Boolean(tx.vin?.[0]?.coinbase);
  const transparentOut = (tx.vout || []).reduce((sum: number, o: any) => sum + (o.value || 0), 0);
  const { sap, orc, irn } = poolBalances(tx);

  const source = sourcePoolLabel(tx);
  const dest = destPoolLabel(tx);
  if (source && dest && source !== dest && transparentOut === 0) {
    const destVb = dest === 'Ironwood' ? irn : dest === 'Orchard' ? orc : sap;
    return zatToZec(Math.abs(destVb));
  }

  const valueBalanceZat = sap + orc + irn;
  const shieldedDeposit = valueBalanceZat < 0 ? zatToZec(Math.abs(valueBalanceZat)) : 0;
  const total = transparentOut + shieldedDeposit;
  if (total > 0) return total;
  if (isCoinbase) return total; // legitimately zero
  return null;
}

const columns: DataTableColumn<any>[] = [
  {
    id: 'index',
    header: '#',
    skeletonWidth: 'w-4',
    cell: (_tx, i) => <span className="text-xs font-mono text-muted tabular-nums">{i + 1}</span>,
  },
  {
    id: 'type',
    header: 'Type',
    skeletonWidth: 'w-16',
    cell: (tx) => poolBadge(tx),
  },
  {
    id: 'hash',
    header: 'Hash',
    skeletonWidth: 'w-28',
    cell: (tx) => <HashLink value={tx.txid} href={`/tx/${tx.txid}`} lead={10} tail={6} responsive copy={false} />,
  },
  {
    id: 'from',
    header: 'From',
    skeletonWidth: 'w-24',
    cell: (tx) => {
      const isCoinbase = Boolean(tx.vin?.[0]?.coinbase);
      const fromAddress = !isCoinbase && tx.vin?.[0]?.address;
      if (isCoinbase) return <span className="text-xs text-muted font-mono">Block Reward</span>;
      if (fromAddress) return <HashLink value={fromAddress} href={`/address/${fromAddress}`} copy={false} lead={8} tail={4} responsive />;
      const label = sourcePoolLabel(tx);
      if (label) return <TxTypeBadge category={poolLabelCategory(label)} label={label} />;
      return <span className="text-xs text-muted font-mono">—</span>;
    },
  },
  {
    id: 'to',
    header: 'To',
    skeletonWidth: 'w-24',
    cell: (tx) => {
      const isCoinbase = Boolean(tx.vin?.[0]?.coinbase);
      const toAddress = firstOutputAddress(tx);
      const poolLabel = destPoolLabel(tx);

      // A coinbase can have both transparent and shielded recipients. Do not
      // pick the larger one: that makes the row look like the whole displayed
      // value went to a single recipient. Keep the table compact while making
      // the additional recipient explicit; the detail card has the amounts.
      if (isCoinbase && toAddress && poolLabel) {
        return (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <TxTypeBadge category={poolLabelCategory(poolLabel)} label={poolLabel} />
            <span className="text-caption text-muted">+ funding stream</span>
          </span>
        );
      }

      if (toAddress) return <HashLink value={toAddress} href={`/address/${toAddress}`} copy={false} lead={8} tail={4} responsive />;
      if (poolLabel) return <TxTypeBadge category={poolLabelCategory(poolLabel)} label={poolLabel} />;
      return <span className="text-xs text-muted font-mono">—</span>;
    },
  },
  {
    id: 'ins',
    header: 'Ins',
    align: 'center',
    skeletonWidth: 'w-4',
    cell: (tx) => {
      const isCoinbase = Boolean(tx.vin?.[0]?.coinbase);
      if (isCoinbase) return <span className="text-xs font-mono text-secondary tabular-nums">0</span>;
      const transparentIns = tx.vin?.length || 0;
      const shieldedIns = (tx.sapling_spend_count || 0) + (tx.orchard_actions || 0) + (tx.ironwood_actions || 0);
      const total = transparentIns + shieldedIns;
      return <span className="text-xs font-mono text-secondary tabular-nums">{total}</span>;
    },
  },
  {
    id: 'outs',
    header: 'Outs',
    align: 'center',
    skeletonWidth: 'w-4',
    cell: (tx) => {
      const transparentOuts = tx.vout?.length || 0;
      const shieldedOuts = (tx.sapling_output_count || 0) + (tx.orchard_actions || 0) + (tx.ironwood_actions || 0);
      const total = transparentOuts + shieldedOuts;
      return <span className="text-xs font-mono text-secondary tabular-nums">{total}</span>;
    },
  },
  {
    id: 'value',
    header: `Value (${CURRENCY})`,
    align: 'right',
    skeletonWidth: 'w-16',
    cell: (tx) => {
      const amount = knownAmount(tx);
      if (amount === null) return <RedactedAmount className="!text-xs" />;
      return <span className="text-xs font-mono text-primary font-semibold tabular-nums">{amount.toFixed(4)}</span>;
    },
  },
  {
    id: 'fee',
    header: 'Fee',
    align: 'right',
    skeletonWidth: 'w-12',
    cell: (tx) => {
      if (tx.vin?.[0]?.coinbase) return <span className="text-xs text-muted">—</span>;
      const feeZat = parseInt(tx.fee || 0);
      if (feeZat === 0) return <span className="text-xs text-muted">—</span>;
      if (feeZat === 10000) return <span className="text-caption text-muted font-mono">Standard</span>;
      const feeZec = zatToZec(feeZat);
      return (
        <span className="text-caption text-muted font-mono tabular-nums">
          {feeZec < 0.001 ? feeZec.toFixed(5) : feeZec.toFixed(4)}
        </span>
      );
    },
  },
];

export const BlockTransactionsSection = forwardRef<HTMLDivElement, { data: BlockData }>(
  function BlockTransactionsSection({ data }, ref) {

    return (
      <div ref={ref}>
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold text-secondary lowercase tracking-tight">Transactions</h2>
          <Badge color="muted">{data.transactionCount ?? '?'}</Badge>
        </div>
        {data.orphanSource === 'observers' && (
          <p className="text-xs text-muted mb-3">
            Only our observer nodes received this block, so its transactions were never indexed.
            {data.transactionCount != null ? ` It contained ${data.transactionCount} transaction${data.transactionCount === 1 ? '' : 's'}.` : ' Its transaction count is unknown.'}
          </p>
        )}
        {data.isOrphaned && data.orphanSource !== 'observers' && data.transactionCount != null && (
          <p className="text-xs text-muted mb-3">
            {data.transactions.length} of {data.transactionCount} transactions archived.
            {data.transactions.length < data.transactionCount ? ' The remaining transaction details are not available in this archive.' : ''}
            {' '}Linked hashes open the transaction’s current canonical record; unlinked hashes are retained here only.
          </p>
        )}
        <DataTable
          columns={data.isOrphaned ? columns.map(column => column.id === 'hash' ? {
            ...column,
            cell: (tx: any) => <HashLink value={tx.txid} href={tx.canonical_available ? `/tx/${tx.txid}` : undefined} lead={10} tail={6} responsive />,
          } : column) : columns}
          rows={data.transactions || []}
          rowKey={(tx, i) => tx.txid || i}
          empty={<p className="text-center py-12 text-secondary font-mono text-sm">No transaction details available</p>}
        />
      </div>
    );
  },
);
