import Link from 'next/link';
import { CURRENCY } from '@/lib/config';
import { AddressWithLabel, AddressDisplay } from '@/components/AddressWithLabel';
import { firstOutputAddress, rankedRecipients } from './tx-classification';
import type { BridgeData, TransactionData, TxClassification } from './types';

const VENUE_NAMES = { near: 'NEAR Intents', maya: 'Maya Protocol', thorchain: 'THORChain' } as const;
const venueName = (b: BridgeData) => VENUE_NAMES[b.venue || 'near'];

export function generateTxSummary(
  data: TransactionData,
  classification: TxClassification,
): React.ReactNode {
  const { txType, allBridges, migrationSourcePool, valueBalance } = classification;

  if (allBridges.length > 0) {
    if (allBridges.length === 1) {
      const b = allBridges[0];
      const addr =
        b.zecAddress ||
        (b.direction === 'exit' ? data.inputs[0]?.address : null) ||
        (b.direction === 'entry' ? firstOutputAddress(data.outputs) : null);
      const addrNode = addr ? (
        <AddressDisplay address={addr} className="text-xs inline" />
      ) : (
        <span className="text-secondary font-mono">a shielded address</span>
      );
      const zecAmt = b.zecAmount
        ? `${b.zecAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${CURRENCY}`
        : null;

      if (b.direction === 'entry') {
        return (
          <>
            {b.otherAmount?.toLocaleString(undefined, { maximumFractionDigits: 4 })} {b.otherToken}{' '}
            was bridged from {b.otherChain.toUpperCase()} to{' '}
            {zecAmt ? (
              <>
                {zecAmt} on{' '}
              </>
            ) : null}
            {addrNode} via {venueName(b)}.
            {b.otherAmountUsd > 0 && (
              <span className="text-muted">
                {' '}
                (≈$
                {b.otherAmountUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })})
              </span>
            )}
          </>
        );
      }
      return (
        <>
          {zecAmt || CURRENCY} was bridged out by {addrNode} to{' '}
          {b.otherAmount?.toLocaleString(undefined, { maximumFractionDigits: 4 })} {b.otherToken} on{' '}
          {b.otherChain.toUpperCase()} via {venueName(b)}.
          {b.otherAmountUsd > 0 && (
            <span className="text-muted">
              {' '}
              (≈${b.otherAmountUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })})
            </span>
          )}
        </>
      );
    }
    const venues = [...new Set(allBridges.map(venueName))];
    return <>Batched bridge transaction with {allBridges.length} swaps via {venues.join(' and ')}.</>;
  }

  if (classification.isCoinbase) {
    const recipient = firstOutputAddress(data.outputs);
    // Coinbase outputs can go to transparent addresses, the shielded pool,
    // or both. We can't reliably distinguish whether the shielded portion
    // is the miner's reward (mining to a shielded address) or a protocol-
    // level lockbox deposit from the tx alone — describe the facts neutrally.
    const shieldedPortion = valueBalance < 0 ? Math.abs(valueBalance) : 0;
    if (shieldedPortion > 0) {
      const transparentPortion = data.totalOutput;
      if (recipient && transparentPortion > 0) {
        return (
          <>
            This coinbase transaction has multiple visible recipients: {transparentPortion.toFixed(4)} {CURRENCY}{' '}
            sent to the address <AddressWithLabel address={recipient} />, plus {shieldedPortion.toFixed(4)}{' '}
            {CURRENCY} paid into the shielded pool.
          </>
        );
      }
      return `This coinbase transaction pays ${shieldedPortion.toFixed(4)} ${CURRENCY} into the shielded pool.`;
    }
    if (recipient) {
      return (
        <>
          This coinbase transaction pays {CURRENCY} to the address{' '}
          <AddressWithLabel address={recipient} />.
        </>
      );
    }
    return `This coinbase transaction creates a block reward.`;
  }

  if (txType === 'MIGRATION') {
    const ironwoodAmt = Math.abs(data.valueBalanceIronwood || 0);
    return `${migrationSourcePool} → Ironwood pool migration. ${ironwoodAmt.toFixed(4)} ${CURRENCY} crosses the turnstile into the formally-verified Ironwood pool. Senders and recipients remain shielded.`;
  }

  if (txType === 'IRONWOOD') {
    return 'Fully private transaction using the Ironwood shielded pool (NU6.3). All amounts, senders, and recipients are encrypted.';
  }

  if (txType === 'ORCHARD') {
    return 'Fully private transaction. All amounts, senders, and recipients are encrypted and hidden from public view.';
  }

  if (txType === 'SHIELDED') {
    return 'Fully private transaction using Sapling shielded proofs. No amounts or addresses are publicly visible.';
  }

  if (txType === 'SHIELDING') {
    const amount = Math.abs(valueBalance);
    const fromAddr = data.inputs[0]?.address;
    if (fromAddr) {
      return (
        <>
          {amount.toFixed(4)} {CURRENCY} moved from the public address{' '}
          <AddressWithLabel address={fromAddr} /> into the private shielded pool, making future
          spending invisible while it stays fully shielded. Later unshielding amounts are public.
        </>
      );
    }
    return `${amount.toFixed(4)} ${CURRENCY} moved from a public address into the private shielded pool, making future spending invisible while it stays fully shielded. Later unshielding amounts are public.`;
  }

  if (txType === 'UNSHIELDING') {
    const amount = Math.abs(valueBalance);
    const toAddr = firstOutputAddress(data.outputs);
    if (toAddr) {
      return (
        <>
          {amount.toFixed(4)} {CURRENCY} moved out of the private shielded pool to the public
          address <AddressWithLabel address={toAddr} />.
        </>
      );
    }
    return `${amount.toFixed(4)} ${CURRENCY} moved out of the private shielded pool to a public transparent address.`;
  }

  if (txType === 'MIXED') {
    return 'This transaction combines public and private funds in a single operation. Some inputs or outputs are visible on-chain, while shielded parts remain encrypted.';
  }

  const fromAddr = data.inputs[0]?.address;
  const toAddr = firstOutputAddress(data.outputs);

  if (fromAddr && toAddr) {
    const recipients = rankedRecipients(data.outputs, [fromAddr]);
    // No output actually goes anywhere but back to fromAddr (self-transfer /
    // consolidation) — still show the real destination output, just with
    // zero "other recipients" rather than falling back to outputs[0] blindly.
    const primary = recipients[0] || {
      address:
        data.outputs.find((out: any) => out.scriptPubKey?.addresses?.[0])?.scriptPubKey?.addresses?.[0] || toAddr,
      amount: data.outputs.find((out: any) => out.scriptPubKey?.addresses?.[0])?.value || 0,
    };
    const otherRecipients = Math.max(0, recipients.length - 1);

    return (
      <>
        The address <AddressWithLabel address={fromAddr} />
        {' sent '}
        <span className="text-primary font-semibold">
          {primary.amount.toFixed(4)} {CURRENCY}
        </span>
        {' to the address '}
        <AddressWithLabel address={primary.address} />
        {otherRecipients > 0 && (
          <span>
            {' '}
            and {otherRecipients} other{otherRecipients > 1 ? 's' : ''}
          </span>
        )}
        .
      </>
    );
  }

  return `A transparent transaction with ${data.inputs.length} input${data.inputs.length !== 1 ? 's' : ''} and ${data.outputs.length} output${data.outputs.length !== 1 ? 's' : ''}.`;
}
