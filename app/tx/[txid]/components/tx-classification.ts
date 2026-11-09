import type { BridgeData, TransactionData, TxClassification } from './types';

/**
 * The "destination" output for display purposes — not always outputs[0].
 * Some transactions carry a zero-value, no-address output before the real
 * recipient (e.g. an empty/OP_RETURN-style output, or just wallet-specific
 * output ordering), and outputs[0] on its own can land on that placeholder
 * instead of the actual transparent recipient, making a perfectly normal
 * transfer render as if it had no destination at all.
 */
export function firstOutputAddress(outputs: TransactionData['outputs']): string | undefined {
  return outputs.find((o) => o.scriptPubKey?.addresses?.[0])?.scriptPubKey?.addresses?.[0];
}

export interface RankedRecipient {
  address: string;
  amount: number;
}

/**
 * Every transparent recipient of a transaction, excluding the sender's own
 * address(es) (self-change), grouped by address (a wallet often gets several
 * outputs in one tx — a real recipient shouldn't be double-counted as
 * multiple "others") and sorted by amount received, largest first.
 *
 * This is the ONE place that decides "who is the primary recipient" — the
 * hero flow diagram and the plain-language summary both call it, so they
 * can never again show two different addresses/amounts for the same
 * transaction the way a fixed bug once did (diagram picked the first two
 * unique addresses in output order; the summary picked the highest-value
 * output — different algorithms, different answers).
 */
export function rankedRecipients(
  outputs: TransactionData['outputs'],
  excludeAddresses: string[],
): RankedRecipient[] {
  const totals = new Map<string, number>();
  for (const output of outputs) {
    const address = output.scriptPubKey?.addresses?.[0];
    if (!address || excludeAddresses.includes(address)) continue;
    totals.set(address, (totals.get(address) || 0) + (output.value || 0));
  }
  return Array.from(totals, ([address, amount]) => ({ address, amount })).sort(
    (a, b) => b.amount - a.amount,
  );
}

export function classifyTransaction(data: TransactionData): TxClassification {
  const isCoinbase = data.isCoinbase || (data.inputs.length > 0 && data.inputs[0].coinbase);
  const hasIronwood = (data.ironwoodActions || 0) > 0;
  const hasOrchard = (data.orchardActions || 0) > 0;
  const hasSapling = data.hasShieldedData;
  const hasTransparentInputs = data.inputs.length > 0 && !isCoinbase;
  const hasTransparentOutputs = data.outputs.some((o) => o.scriptPubKey?.addresses);
  const hasTransparent = hasTransparentInputs || hasTransparentOutputs;
  const hasShielded = hasIronwood || hasOrchard || hasSapling;

  const hasSaplingSpends = data.saplingSpendCount > 0;
  const hasSaplingOutputs = data.saplingOutputCount > 0;

  const valueBalance =
    (data.valueBalanceSprout || 0) +
    (data.valueBalanceSapling || 0) +
    (data.valueBalanceOrchard || 0) +
    (data.valueBalanceIronwood || 0);

  const isShielding = hasTransparentInputs && !hasTransparentOutputs && valueBalance < 0;
  const isUnshielding = !hasTransparentInputs && hasTransparentOutputs && valueBalance > 0;

  const ironwoodSourcePool =
    hasIronwood && (data.valueBalanceIronwood || 0) !== 0 && !hasTransparent
      ? (data.valueBalanceOrchard || 0) > 0
        ? 'Orchard'
        : (data.valueBalanceSapling || 0) > 0
          ? 'Sapling'
          : null
      : null;

  // With no transparent side and no Orchard/Ironwood, whatever entered Sapling
  // alongside a JoinSplit came out of Sprout — a Sprout → Sapling migration,
  // not a Sapling-internal transfer. Inferred from Sapling's balance so it
  // also holds where valueBalanceSprout isn't available yet.
  const hasSprout = data.hasSprout === true;
  const isSproutMigration =
    hasSprout && !hasTransparent && !hasOrchard && !hasIronwood && (data.valueBalanceSapling || 0) < 0;
  const isSproutOnly =
    hasSprout && !hasTransparent && !hasOrchard && !hasIronwood && !hasSaplingSpends && !hasSaplingOutputs;

  const migrationSourcePool = ironwoodSourcePool ?? (isSproutMigration ? 'Sprout' : null);
  const migrationDestPool = ironwoodSourcePool ? 'Ironwood' : isSproutMigration ? 'Sapling' : null;
  const isMigration = migrationSourcePool !== null;

  const txType = isCoinbase
    ? 'COINBASE'
    : isMigration
      ? 'MIGRATION'
      : isSproutOnly
        ? 'SPROUT'
        : hasIronwood && !hasTransparent
        ? 'IRONWOOD'
        : hasOrchard && !hasTransparent
          ? 'ORCHARD'
          : hasShielded && hasTransparent && isShielding
            ? 'SHIELDING'
            : hasShielded && hasTransparent && isUnshielding
              ? 'UNSHIELDING'
              : hasShielded && hasTransparent
                ? 'MIXED'
                : hasSapling
                  ? 'SHIELDED'
                  : 'REGULAR';

  const allBridges =
    data.bridges && data.bridges.length > 0 ? data.bridges : data.bridge ? [data.bridge] : [];

  const bridgeOutputAddresses = new Map<string, BridgeData>();
  for (const b of allBridges) {
    if (b.zecAddress) bridgeOutputAddresses.set(b.zecAddress, b);
  }

  return {
    isCoinbase,
    hasIronwood,
    hasOrchard,
    hasSapling,
    hasSprout,
    hasTransparentInputs,
    hasTransparentOutputs,
    hasTransparent,
    hasShielded,
    hasSaplingSpends,
    hasSaplingOutputs,
    valueBalance,
    isShielding,
    isUnshielding,
    migrationSourcePool,
    migrationDestPool,
    isMigration,
    txType,
    allBridges,
    bridgeOutputAddresses,
  };
}
