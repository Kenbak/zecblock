import { CURRENCY } from '@/lib/config';
import { RedactedAmount } from '@/components/ui/RedactedAmount';
import { TX_CATEGORY_CONFIG, type TxCategory } from '@/components/ui/TxTypeBadge';
import { FlowChain, type FlowNode } from './FlowChain';
import { firstOutputAddress, rankedRecipients, type RankedRecipient } from './tx-classification';
import type { TransactionData, TxClassification } from './types';

function ZecAmount({
  value,
  priceUsd,
  className = '',
}: {
  value: number;
  /** Shown as a muted secondary suffix — this is the headline number, the $ figure is context, not a second equally-weighted amount. */
  priceUsd?: number | null;
  className?: string;
}) {
  return (
    <span className={`text-sm font-mono font-semibold text-primary tabular-nums ${className}`}>
      {value.toFixed(4)} {CURRENCY}
      {priceUsd != null && value > 0 && (
        <span className="text-muted font-normal text-xs ml-1.5">
          (${(value * priceUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })})
        </span>
      )}
    </span>
  );
}

/**
 * A pool flow-diagram node, colored from the same TX_CATEGORY_CONFIG registry
 * every other "Type" badge in the app uses — a generic "Shielded Pool" badge
 * here would both lose real information (which pool) and reintroduce a
 * second, drifting color scheme for the same concept.
 */
function poolFlowNode(category: TxCategory, label: string, amount?: number): FlowNode {
  return { kind: 'pool', label, color: TX_CATEGORY_CONFIG[category].color, amount };
}

// Title-case labels for the flow diagram — TX_CATEGORY_CONFIG's labels are
// uppercase (for badge text), which reads wrong inline here.
const POOL_TITLE: Record<TxCategory, string> = {
  ironwood: 'Ironwood',
  orchard: 'Orchard',
  sapling: 'Sapling',
  sprout: 'Sprout',
  shielded: 'Shielded',
} as Record<TxCategory, string>;

function activePoolCategory(data: TransactionData): TxCategory {
  if (data.valueBalanceIronwood) return 'ironwood';
  if (data.valueBalanceOrchard) return 'orchard';
  if (data.valueBalanceSapling) return 'sapling';
  return 'shielded';
}

function poolNode(data: TransactionData, amount?: number): FlowNode {
  const category = activePoolCategory(data);
  return poolFlowNode(category, `${POOL_TITLE[category]} Pool`, amount);
}

/** Unique, ordered addresses across a set of transparent inputs/outputs — used only for exclusion sets (e.g. "not the sender"), never for display order. */
function uniqueAddresses(list: Array<{ address?: string }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (item.address && !seen.has(item.address)) {
      seen.add(item.address);
      out.push(item.address);
    }
  }
  return out;
}

/** Same grouping as rankedRecipients, but for inputs (flat {address, value} shape rather than outputs' scriptPubKey wrapper). */
function rankedSenders(inputs: TransactionData['inputs']): RankedRecipient[] {
  const totals = new Map<string, number>();
  for (const input of inputs) {
    if (!input.address) continue;
    totals.set(input.address, (totals.get(input.address) || 0) + (input.value || 0));
  }
  return Array.from(totals, ([address, amount]) => ({ address, amount })).sort((a, b) => b.amount - a.amount);
}

/**
 * Caps a ranked (largest-first) recipient/sender list to `max` visible
 * nodes, folding the remainder into one "+N more" node that carries their
 * combined total rather than silently dropping it. Defaults to showing just
 * the single biggest party — matching the plain-language summary below,
 * which only ever names one primary recipient + "and N others" — instead of
 * stacking multiple full address blocks in the hero, which reads as a wall
 * of text rather than a clear headline fact.
 *
 * When there's exactly one party on this side, its amount is hidden by
 * default (`showSoloAmount: false`) — a lone source's own total differs
 * from the center amount only by the network fee, and two near-identical
 * numbers stacked on top of each other reads as a mistake, not a fee
 * disclosure. Pass `showSoloAmount: true` only where this side's sole node
 * carries a genuinely different figure worth seeing — e.g. one of several
 * destinations that together sum to the center amount.
 */
function rankedNodes(
  ranked: RankedRecipient[],
  { max = 1, showSoloAmount = false }: { max?: number; showSoloAmount?: boolean } = {},
): FlowNode[] {
  if (ranked.length === 0) return [];
  if (ranked.length === 1) {
    return [{ kind: 'address', address: ranked[0].address, amount: showSoloAmount ? ranked[0].amount : undefined }];
  }
  const nodes: FlowNode[] = ranked
    .slice(0, max)
    .map((r) => ({ kind: 'address', address: r.address, amount: r.amount }));
  if (ranked.length > max) {
    const rest = ranked.slice(max);
    nodes.push({ kind: 'more', count: rest.length, amount: rest.reduce((sum, r) => sum + r.amount, 0) });
  }
  return nodes;
}

export function TxHeroFlow({
  data,
  classification,
  priceUsd,
}: {
  data: TransactionData;
  classification: TxClassification;
  priceUsd?: number | null;
}) {
  const { txType, allBridges, migrationSourcePool, migrationDestPool, valueBalance, isCoinbase } = classification;

  if (allBridges.length > 0) {
    const entries = allBridges.filter((b) => b.direction === 'entry');
    const exits = allBridges.filter((b) => b.direction === 'exit');

    const capped = (list: typeof allBridges, max = 3): FlowNode[] => {
      const nodes: FlowNode[] = list
        .slice(0, max)
        .map((b) => ({ kind: 'token', token: b.otherToken, chain: b.otherChain, amount: b.otherAmount }));
      if (list.length > max) nodes.push({ kind: 'more', count: list.length - max });
      return nodes;
    };

    // Mixed-direction batches are rare; when they occur, show each side's
    // other-chain tokens directly rather than trying to net them into one
    // ZEC figure that would misrepresent the batch.
    if (entries.length > 0 && exits.length > 0) {
      return <FlowChain sources={capped(entries)} destinations={capped(exits)} />;
    }

    if (entries.length > 0) {
      // The center amount and the ZEC token node would otherwise both show
      // the identical figure — one is enough. Center carries it since it's
      // the more prominent slot; the token node just identifies "this is ZEC".
      const totalZec = entries.reduce((sum, b) => sum + (b.zecAmount || 0), 0);
      return (
        <FlowChain
          sources={capped(entries)}
          amount={<ZecAmount value={totalZec} priceUsd={priceUsd} />}
          destinations={[{ kind: 'token', token: 'ZEC', chain: 'zec' }]}
        />
      );
    }

    const totalZec = exits.reduce((sum, b) => sum + (b.zecAmount || 0), 0);
    return (
      <FlowChain
        sources={[{ kind: 'token', token: 'ZEC', chain: 'zec' }]}
        amount={<ZecAmount value={totalZec} priceUsd={priceUsd} />}
        destinations={capped(exits)}
      />
    );
  }

  if (txType === 'MIGRATION') {
    // The amount is what verifiably entered the destination pool. For Sprout
    // the source side also paid the fee, which isn't indexed.
    const destAmt = Math.abs(
      (migrationDestPool === 'Sapling' ? data.valueBalanceSapling : data.valueBalanceIronwood) || 0,
    );
    const srcCategory: TxCategory =
      migrationSourcePool === 'Sprout' ? 'sprout' : migrationSourcePool === 'Sapling' ? 'sapling' : 'orchard';
    const destCategory: TxCategory = migrationDestPool === 'Sapling' ? 'sapling' : 'ironwood';
    return (
      <FlowChain
        sources={[poolFlowNode(srcCategory, migrationSourcePool || 'Shielded')]}
        amount={<ZecAmount value={destAmt} priceUsd={priceUsd} />}
        destinations={[poolFlowNode(destCategory, POOL_TITLE[destCategory])]}
      />
    );
  }

  if (txType === 'IRONWOOD' || txType === 'ORCHARD' || txType === 'SHIELDED' || txType === 'SPROUT') {
    // Each is a single-pool self-loop — label and color it as that pool
    // rather than a generic "Shielded", matching the block table's convention.
    const category: TxCategory =
      txType === 'IRONWOOD' ? 'ironwood' : txType === 'ORCHARD' ? 'orchard' : txType === 'SPROUT' ? 'sprout' : 'sapling';
    const node = poolFlowNode(category, POOL_TITLE[category]);
    return (
      <FlowChain
        sources={[node]}
        amount={<RedactedAmount />}
        destinations={[node]}
      />
    );
  }

  if (txType === 'SHIELDING') {
    const fromAddr = data.inputs[0]?.address;
    return (
      <FlowChain
        sources={fromAddr ? [{ kind: 'address', address: fromAddr }] : []}
        amount={<ZecAmount value={Math.abs(valueBalance)} priceUsd={priceUsd} />}
        destinations={[poolNode(data)]}
      />
    );
  }

  if (txType === 'UNSHIELDING') {
    const toAddr = firstOutputAddress(data.outputs);
    return (
      <FlowChain
        sources={[poolNode(data)]}
        amount={<ZecAmount value={Math.abs(valueBalance)} priceUsd={priceUsd} />}
        destinations={toAddr ? [{ kind: 'address', address: toAddr }] : []}
      />
    );
  }

  if (isCoinbase) {
    const toAddr = firstOutputAddress(data.outputs);
    // valueBalance < 0 here means part of the subsidy went straight into the
    // shielded pool as a lockbox/funding-stream output — public and consensus-
    // enforced, not a private spend, so it belongs in "total reward" the same
    // way the transparent output does.
    const shieldedPortion = valueBalance < 0 ? Math.abs(valueBalance) : 0;
    const totalReward = data.totalOutput + shieldedPortion;
    const destinations: FlowNode[] = [];
    if (toAddr) destinations.push({ kind: 'address', address: toAddr });
    if (shieldedPortion > 0) destinations.push(poolFlowNode('ironwood', 'Ironwood Pool'));
    return (
      <FlowChain
        sources={[poolFlowNode('coinbase', 'Block Reward')]}
        amount={<ZecAmount value={totalReward} priceUsd={priceUsd} />}
        destinations={destinations}
      />
    );
  }

  if (txType === 'MIXED') {
    const senders = rankedSenders(data.inputs);
    const senderAddresses = new Set(senders.map((s) => s.address));
    const transparentOut = rankedRecipients(data.outputs, []);
    const poolAmount = Math.abs(valueBalance);
    const poolIsDestination = valueBalance < 0;
    const poolIsSource = valueBalance > 0;

    const destinationCount = transparentOut.length + (poolIsDestination ? 1 : 0);

    const sources = rankedNodes(senders);
    // A destination that's also a source address is that address getting
    // its own balance back rather than a new transfer — its amount is
    // suppressed since it'd just repeat a number already implied by the
    // total, without needing extra explanation attached to it.
    const destinations = rankedNodes(transparentOut, { showSoloAmount: destinationCount > 1 }).map((node) =>
      node.kind === 'address' && senderAddresses.has(node.address) ? { ...node, amount: undefined } : node,
    );

    if (poolIsDestination) destinations.push(poolNode(data, poolAmount));
    else if (poolIsSource) sources.push(poolNode(data, poolAmount));

    // Center = everywhere the money verifiably went (transparent outputs +
    // whatever crossed into the pool), so it always equals the sum of every
    // destination node shown — no more "where did the rest go?" gap.
    const transparentOutTotal = transparentOut.reduce((sum, r) => sum + r.amount, 0);
    const centerAmount = transparentOutTotal + (poolIsDestination ? poolAmount : 0);

    return (
      <FlowChain
        sources={sources}
        amount={<ZecAmount value={centerAmount} priceUsd={priceUsd} />}
        destinations={destinations}
      />
    );
  }

  // REGULAR / default: a transparent transfer, possibly with several inputs
  // or recipients. Ranked largest-first (same ranking tx-summary.tsx uses
  // for its "primary recipient") — the diagram and the sentence below it
  // can no longer name two different recipients or amounts for the same
  // transaction. Change back to the sender is excluded here (unlike MIXED)
  // — for a plain transfer it's genuinely uninteresting wallet leftover,
  // not a second destination worth surfacing.
  const fromAddresses = uniqueAddresses(data.inputs);
  const recipients = rankedRecipients(data.outputs, fromAddresses);
  const recipientTotal = recipients.reduce((sum, r) => sum + r.amount, 0);
  const destinations =
    recipients.length > 0
      ? rankedNodes(recipients)
      : (() => {
          const addr = firstOutputAddress(data.outputs);
          return addr ? [{ kind: 'address', address: addr } as FlowNode] : [];
        })();

  return (
    <FlowChain
      sources={rankedNodes(rankedSenders(data.inputs))}
      amount={
        <ZecAmount value={recipientTotal > 0 ? recipientTotal : data.totalOutput > 0 ? data.totalOutput : data.totalInput} priceUsd={priceUsd} />
      }
      destinations={destinations}
    />
  );
}
