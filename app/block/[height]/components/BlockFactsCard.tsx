'use client';

import { formatRelativeTime, formatDateUTC } from '@/lib/utils';
import { CURRENCY } from '@/lib/config';
import { Card, CardBody } from '@/components/ui/Card';
import { FactBox, CopyableHash, BoldZec } from '@/components/ui/FactBox';
import type { CoinbaseClientEmoji, CoinbaseClientInfo } from '@/lib/coinbase-client';
import type { BlockData } from './types';
import { CoinbaseMessage } from '@/components/CoinbaseMessage';
import { CopyButton } from '@/components/CopyButton';

interface RewardRecipient {
  address: string | null;
  label: string;
  valueZec: number;
}

/**
 * The coinbase transaction's visible outputs — transparent recipients and
 * shielded coinbase value. This deliberately excludes deferred-lockbox
 * accrual: that is part of the block subsidy but not a transaction output.
 * Previously only the first transparent recipient was shown, silently hiding
 * the rest of the coinbase distribution.
 */
function getRewardRecipients(data: BlockData): RewardRecipient[] {
  const coinbaseTx = data.transactions?.[0];
  // blocks.miner_address can resolve to the ZIP-207 dev-fund address (not a
  // real miner) when the miner's actual reward is deposited entirely into a
  // shielded pool and the funding stream is the only transparent coinbase
  // output left to look at — don't label that recipient "Miner".
  const minerAddressIsRealMiner = !data.minerPoolIsFundingStream;
  const outputs: RewardRecipient[] = (coinbaseTx?.vout || [])
    .map((o: any) => ({
      address: o.scriptPubKey?.addresses?.[0] as string | undefined,
      valueZec: o.value as number,
    }))
    .filter((o: any) => o.address && o.valueZec > 0)
    .map((o: any) => ({
      address: o.address,
      label: o.address === data.minerAddress && minerAddressIsRealMiner ? 'Miner' : 'Funding stream',
      valueZec: o.valueZec,
    }));

  const balance = coinbaseTx
    ? parseInt(coinbaseTx.value_balance_sapling || 0) + parseInt(coinbaseTx.value_balance_orchard || 0) + parseInt(coinbaseTx.value_balance_ironwood || 0)
    : 0;
  if (balance < 0) {
    outputs.push({ address: null, label: 'Shielded coinbase output', valueZec: Math.abs(balance) / 1e8 });
  }

  return outputs;
}

/**
 * Visible coinbase recipients as a plain,
 * calm list — no proportion bar or color-coding. The split is nearly
 * identical on almost every block, so a bar/legend stops being informative
 * fast and just becomes visual noise once you've seen it a few times.
 */
function BlockRewardBreakdown({
  data,
  minerPool,
  minerPoolUrl,
  minerPoolRegion,
}: {
  data: BlockData;
  minerPool?: string | null;
  minerPoolUrl?: string | null;
  minerPoolRegion?: string | null;
}) {
  const recipients = getRewardRecipients(data);
  const total = recipients.reduce((sum, r) => sum + r.valueZec, 0);

  return (
    <FactBox label="Coinbase Outputs" tooltip="The visible outputs created by this block's coinbase transaction. Deferred-development-lockbox accrual is part of the subsidy but is not a transaction output.">
      {minerPool && !data.minerAddress && (
        <p className="mb-2 text-caption text-muted" title="Pool identified from the public coinbase tag; payout recipient remains shielded">
          Pool · {minerPoolUrl ? <a href={minerPoolUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{minerPool}</a> : minerPool}
          <span className="ml-1.5">(coinbase tag)</span>
        </p>
      )}
      <BoldZec value={total} />
      <div className="mt-2 space-y-1">
        {recipients.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center justify-between gap-2 text-caption">
            <div className="flex items-center gap-1.5 min-w-0 text-muted">
              <span className="shrink-0">{r.label}</span>
              {r.address ? (
                <CopyableHash value={r.address} href={`/address/${r.address}`} textSize="text-caption" colorClass="text-primary" />
              ) : (
                <span className="font-mono text-cipher-yellow">Shielded Pool</span>
              )}
              {r.label === 'Miner' && r.address === data.minerAddress && minerPool && (
                <span className="font-mono text-muted whitespace-nowrap">
                  ({minerPoolUrl ? (
                    <a href={minerPoolUrl} target="_blank" rel="noopener noreferrer" className="hover:text-primary hover:underline">{minerPool}</a>
                  ) : minerPool}
                  {minerPoolRegion && ` ${minerPoolRegion}`})
                </span>
              )}
            </div>
            <span className="font-mono text-secondary tabular-nums shrink-0">{r.valueZec.toFixed(4)} {CURRENCY}</span>
          </div>
        ))}
      </div>
    </FactBox>
  );
}

function CoinbaseTagValue({
  hex,
  clientEmoji,
  clientInfo,
}: {
  hex: string | null | undefined;
  clientEmoji: CoinbaseClientEmoji | null;
  clientInfo: CoinbaseClientInfo;
}) {
  return (
    <div>
      {clientEmoji && (
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-cipher-surface text-caption font-mono text-secondary border border-cipher-border">
            <span role="img" aria-label={clientInfo.name ? `Self-reported ${clientInfo.name} marker` : 'Block-template client marker'}>{clientEmoji}</span>
            {clientInfo.name && <span>{clientInfo.name}{clientInfo.version ? ` ${clientInfo.version}` : ''}</span>}
          </span>
        </div>
      )}
      <CoinbaseMessage hex={hex} />
      {hex && (
        <details className="mt-3">
          <summary className="cursor-pointer text-caption font-mono text-muted hover:text-secondary">Raw hex ({Math.floor(hex.length / 2)} bytes)</summary>
          <div className="mt-2 flex items-start gap-2 block-hash-bg p-3 rounded border border-cipher-border">
            <code className="min-w-0 text-caption text-muted break-all">{hex}</code>
            <CopyButton text={hex} label="coinbase hex" size="xs" />
          </div>
        </details>
      )}
    </div>
  );
}

export function BlockFactsCard({
  data,
  showMoreDetails,
  onToggleMoreDetails,
  onScrollToTransactions,
  coinbaseClientEmoji,
  coinbaseClientInfo,
}: {
  data: BlockData;
  showMoreDetails: boolean;
  onToggleMoreDetails: () => void;
  onScrollToTransactions: () => void;
  coinbaseClientEmoji: CoinbaseClientEmoji | null;
  coinbaseClientInfo: CoinbaseClientInfo;
}) {
  return (
    <Card className="mb-6">
      <CardBody>
        {/*
          Mobile: a 2-column grid, explicitly ordered as Hash|Size, Timestamp
          (full-width alone), Transactions|Fees — pairing short facts instead
          of every one of the five stacking as its own full-width row.
          sm+: flex-wrap, equal-ish width and sharing rows by content size
          (see FactBox's `fit`/`grow`) instead of a fixed grid column each, so
          five short facts fill the same width five boxes would take instead
          of two. `order` resets to source order at sm+ via `sm:order-none`.
        */}
        <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-start">
          <FactBox fit className="order-1 sm:order-none fact-box-hash" label="Block Hash" tooltip="Unique cryptographic identifier for this block">
            <CopyableHash value={data.hash} colorClass="text-primary" />
          </FactBox>

          {/*
            DOM/desktop order is Hash, Timestamp, Size, Transactions, Fees —
            the approved desktop layout, and `sm:order-none` reverts to
            exactly that (source order) rather than to some other sequence.
            Only Timestamp and Size need a mobile-only `order` override to
            visually swap into Hash|Size, Timestamp(full row), Tx|Fees —
            reordering the DOM itself to match would silently change what
            `sm:order-none` reverts *to* on desktop, which is what broke it
            last time.
          */}
          <FactBox fit className="order-3 col-span-2 sm:order-none sm:col-span-1 fact-box-timestamp" label="Timestamp" tooltip="Miner-provided block header time; not the time ZecBlock first observed the block">
            <span className="text-sm text-primary whitespace-nowrap">
              {formatRelativeTime(data.timestamp)}
              <span className="text-muted ml-1.5 text-xs">({formatDateUTC(data.timestamp)})</span>
            </span>
          </FactBox>

          <FactBox fit className="order-2 sm:order-none" label="Block Size" tooltip="The size of this block in kilobytes">
            <span className="text-sm text-primary font-mono tabular-nums whitespace-nowrap">{(data.size / 1024).toFixed(2)} KB</span>
          </FactBox>

          <FactBox fit className="order-4 sm:order-none" label="Transactions" tooltip="Click to jump to the transaction list">
            <button onClick={onScrollToTransactions} className="text-sm text-primary font-semibold hover:underline transition-colors whitespace-nowrap">
              {data.transactionCount} transaction{data.transactionCount !== 1 ? 's' : ''}
            </button>
          </FactBox>

          {data.totalFees !== undefined && !data.isOrphaned && (
            <FactBox fit className="order-5 sm:order-none" label="Total Fees" tooltip="Total fees paid by all transactions in this block">
              <BoldZec value={data.totalFees} />
            </FactBox>
          )}
        </div>

        <FactBox className="mt-3" label="Coinbase Message" tooltip="Optional data embedded by the miner in the coinbase transaction. Text and software markers are self-reported; non-printable bytes appear as dots. Raw hex preserves the original bytes.">
          <CoinbaseTagValue hex={data.coinbaseHex} clientEmoji={coinbaseClientEmoji} clientInfo={coinbaseClientInfo} />
        </FactBox>

        <div className="mt-3">
          {!data.isOrphaned && (
            <BlockRewardBreakdown
              data={data}
              minerPool={data.minerPool}
              minerPoolUrl={data.minerPoolUrl}
              minerPoolRegion={data.minerPoolRegion}
            />
          )}
        </div>

        <button
            onClick={onToggleMoreDetails}
            className="mt-5 pt-4 border-t block-info-border text-sm text-secondary hover:text-primary transition-colors flex items-center font-mono w-full"
          >
            <svg className={`w-4 h-4 mr-1 transition-transform ${showMoreDetails ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            {showMoreDetails ? 'Hide' : 'Show'} More Details
        </button>

        {showMoreDetails && (
          <div className="mt-4 pt-4 border-t block-info-border">
            {/* Short values — same equal-width treatment as the top facts row. */}
            <div className="flex flex-wrap gap-3 items-start">
              <FactBox fit label="Difficulty" tooltip="Mining difficulty at the time this block was mined">
                <span className="text-sm text-primary font-mono tabular-nums">{data.difficulty.toFixed(8)}</span>
              </FactBox>

              {data.version != null && (
                <FactBox fit label="Version" tooltip="Block version number">
                  <span className="text-sm text-primary font-mono tabular-nums">{data.version}</span>
                </FactBox>
              )}

              {data.bits && (
                <FactBox fit label="Bits" tooltip="Compact representation of the difficulty target">
                  <span className="text-sm text-primary font-mono">{data.bits}</span>
                </FactBox>
              )}
            </div>

            {/* Hashes — paired two-up so each gets room for its copy button. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start mt-3">
              {data.nonce && (
                <FactBox label="Nonce" tooltip="Random value used in mining to find a valid block hash">
                  <CopyableHash value={data.nonce} colorClass="text-primary" />
                </FactBox>
              )}

              {data.merkleRoot && (
                <FactBox label="Merkle Root" tooltip="Proves all transparent transactions in this block are valid and unmodified">
                  <CopyableHash value={data.merkleRoot} colorClass="text-primary" />
                </FactBox>
              )}

              {data.finalOrchardRoot && (
                <FactBox label="Orchard Root" tooltip="Root hash of the Orchard note commitment tree after this block">
                  <CopyableHash value={data.finalOrchardRoot} colorClass="text-cipher-purple" />
                </FactBox>
              )}

              {data.finalSaplingRoot && (
                <FactBox label="Sapling Root" tooltip="Root hash of the Sapling note commitment tree after this block">
                  <CopyableHash value={data.finalSaplingRoot} colorClass="text-cipher-green" />
                </FactBox>
              )}

              {data.finalIronwoodRoot && (
                <FactBox label="Ironwood Root" tooltip="Root hash of the Ironwood note commitment tree after this block">
                  <CopyableHash value={data.finalIronwoodRoot} colorClass="text-cipher-ironwood" />
                </FactBox>
              )}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
