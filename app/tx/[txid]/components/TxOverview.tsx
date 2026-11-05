'use client';

import Link from 'next/link';
import { CURRENCY } from '@/lib/config';
import { Card, CardBody } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { HashLink } from '@/components/ui/HashLink';
import { FactBox, CopyableHash } from '@/components/ui/FactBox';
import { TxTypeBadge, type TxCategory } from '@/components/ui/TxTypeBadge';
import { StakingActionBadge } from '@/components/StakingActionBadge';
import { displayPubkey } from '@/lib/utils';
import { formatTimestamp } from './format-timestamp';
import type { TransactionData, TxClassification } from './types';

interface TxOverviewProps {
  data: TransactionData;
  classification: TxClassification;
}

/**
 * One shielded pool's activity — spend/output (or action) counts plus its
 * value balance, grouped into a single box instead of five separate flat
 * label:value rows. Sapling separates spends from outputs; Orchard/Ironwood
 * only have one combined "action" count, hence the two different `counts`
 * shapes rather than forcing both into the same three fields.
 */
function PoolActivityBox({
  category,
  counts,
  valueBalance,
}: {
  category: TxCategory;
  counts: { spends: number; outputs: number } | { actions: number } | { note: string };
  valueBalance?: number;
}) {
  return (
    <FactBox label={`${category[0].toUpperCase()}${category.slice(1)} Pool`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <TxTypeBadge category={category} />
        <span className="text-xs text-muted font-mono whitespace-nowrap">
          {'note' in counts
            ? counts.note
            : 'actions' in counts
            ? `${counts.actions} action${counts.actions !== 1 ? 's' : ''}`
            : `${counts.spends} spend${counts.spends !== 1 ? 's' : ''} · ${counts.outputs} output${counts.outputs !== 1 ? 's' : ''}`}
        </span>
      </div>
      {valueBalance != null && valueBalance !== 0 && (
        <div className="mt-2.5 pt-2.5 border-t border-cipher-border/50 flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm text-primary tabular-nums">
            {valueBalance < 0 ? '+' : '-'}
            {Math.abs(valueBalance).toFixed(8)} {CURRENCY}
          </span>
          <span className="text-caption text-muted font-mono whitespace-nowrap">
            {valueBalance < 0 ? '→ entering pool' : '← leaving pool'}
          </span>
        </div>
      )}
    </FactBox>
  );
}

export function TxOverview({ data }: TxOverviewProps) {
  // `data.hasShieldedData` means "this tx has *some* shielded component",
  // not specifically Sapling — using it here showed an empty "0 spends · 0
  // outputs" Sapling box on pure Orchard/Ironwood transactions. Each pool's
  // own counts are the only reliable signal that pool was actually active.
  const hasSaplingActivity = data.saplingSpendCount > 0 || data.saplingOutputCount > 0;
  const hasOrchardActivity = (data.orchardActions || 0) > 0;
  const hasIronwoodActivity = (data.ironwoodActions || 0) > 0;
  const hasSproutActivity = data.hasSprout === true;
  const hasAnyPoolActivity = hasSaplingActivity || hasOrchardActivity || hasIronwoodActivity || hasSproutActivity;

  return (
    <div>
      <Card className="mb-6">
        <CardBody>
          {/* Line 1: the facts most people came here for. `hug` instead of
              `fit` — these hold very different amounts of content (Block
              has a link + confirmation count + a badge; Size is one short
              string), so equal-width columns just padded the short ones
              with empty space. Sized to content instead. */}
          <div className="flex flex-wrap items-start gap-3">
            <FactBox hug label="Block" tooltip="The block that includes this transaction">
              <div className="flex items-center gap-2 flex-wrap text-sm">
                <Link href={`/block/${data.blockHeight}`} prefetch={false} className="text-primary hover:underline font-mono">
                  #{data.blockHeight.toLocaleString()}
                </Link>
                <span className="text-muted text-xs whitespace-nowrap">
                  ({data.confirmations.toLocaleString()} confirmation{data.confirmations !== 1 ? 's' : ''})
                </span>
                {data.finality && (
                  <Badge color={data.finality === 'Finalized' ? 'green' : 'orange'} variant="subtle">
                    {data.finality === 'Finalized' ? 'Finalized' : 'Pending'}
                  </Badge>
                )}
              </div>
            </FactBox>

            <FactBox hug label="Timestamp" tooltip="When this transaction was mined">
              <span className="text-sm text-primary whitespace-nowrap">{formatTimestamp(data.timestamp)}</span>
            </FactBox>

            {data.fee == null ? (
              <FactBox hug label="Fee" tooltip="The indexer couldn't determine this transaction's fee.">

                <span className="text-sm font-mono text-muted whitespace-nowrap">Unavailable</span>
              </FactBox>
            ) : (
              <FactBox hug label="Fee" tooltip="Fee paid to the miner">
                <span className="text-sm font-mono font-semibold text-primary whitespace-nowrap">
                  {data.fee.toFixed(8)} {CURRENCY}
                </span>
              </FactBox>
            )}

            <FactBox hug label="Size" tooltip="Transaction size in bytes">
              <span className="text-sm font-mono text-primary whitespace-nowrap tabular-nums">
                {data.size.toLocaleString()} bytes ({(data.size / 1024).toFixed(2)} KB)
              </span>
            </FactBox>
          </div>

          {data.stakingAction && (
            <div className="mt-3">
              <FactBox span label="Crosslink Action" tooltip="Crosslink staking action encoded in this transaction">
                <div className="flex items-center gap-2 flex-wrap">
                  <StakingActionBadge type={data.stakingAction.type} />
                  {data.stakingAction.amountZec !== null && (
                    <span className="font-mono font-semibold text-primary text-sm">
                      {data.stakingAction.amountZec.toFixed(4)} {CURRENCY}
                    </span>
                  )}
                  {data.stakingAction.delegatee && (
                    <span className="text-xs text-muted">
                      to{' '}
                      <HashLink
                        value={displayPubkey(data.stakingAction.delegatee)}
                        href={`/finalizer/${data.stakingAction.delegatee}`}
                        lead={12}
                        tail={6}
                        copy={false}
                      />
                    </span>
                  )}
                </div>
              </FactBox>
            </div>
          )}

          {/* Line 2: consensus/technical fields, always visible — no
              "Show More" gate. Block Hash gets its own wider min-width
              (.fact-box-hash-inline) since a truncated hash + copy button
              needs more room than a short number. */}
          <div className="mt-3 flex flex-wrap items-start gap-3">
            <FactBox hug label="Version" tooltip="Transaction version number">
              <span className="text-sm font-mono text-primary tabular-nums">{data.version}</span>
            </FactBox>

            <FactBox hug label="Lock Time" tooltip="Block height or timestamp at which this transaction is unlocked">
              <span className="text-sm font-mono text-primary tabular-nums">{data.locktime}</span>
            </FactBox>

            {data.expiryHeight != null && data.expiryHeight > 0 && (
              <FactBox
                hug
                label="Expiry Height"
                tooltip="Block height after which this transaction can no longer be mined. The delta from the mined block height indicates the wallet's configured expiry window."
              >
                <span className="text-sm font-mono text-primary tabular-nums whitespace-nowrap">
                  {data.expiryHeight.toLocaleString()}
                  <span className="text-caption text-muted ml-1.5">+{data.expiryHeight - (data.blockHeight || 0)} blocks</span>
                </span>
              </FactBox>
            )}

            <FactBox hug label="Block Hash" tooltip="Hash of the block containing this transaction" className="fact-box-hash-inline">
              <CopyableHash value={data.blockHash} href={`/block/${data.blockHeight}`} colorClass="text-primary" />
            </FactBox>

            {data.bindingSigSapling && (
              <FactBox label="Sapling Binding Signature" tooltip="Cryptographic proof that the transaction is balanced" className="w-full">
                <code className="text-xs text-cipher-green break-all block font-mono">{data.bindingSigSapling}</code>
              </FactBox>
            )}
          </div>

          {/* Line 3: shielded pool activity — one box per active pool
              instead of six flat rows (spends, outputs, actions, value
              balance × 3 pools) that gave every pool's data equal weight
              regardless of which pools this transaction actually touched. */}
          {hasAnyPoolActivity && (
            <div className="mt-5 pt-4 border-t border-cipher-border/50">
              <span className="text-caption font-mono text-muted uppercase tracking-widest">Shielded Pool Activity</span>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {hasSproutActivity && (
                  // JoinSplit counts aren't in the API, only their net value.
                  <PoolActivityBox category="sprout" counts={{ note: 'JoinSplit' }} valueBalance={data.valueBalanceSprout} />
                )}
                {hasSaplingActivity && (
                  <PoolActivityBox
                    category="sapling"
                    counts={{ spends: data.saplingSpendCount, outputs: data.saplingOutputCount }}
                    valueBalance={data.valueBalanceSapling}
                  />
                )}
                {hasOrchardActivity && (
                  <PoolActivityBox
                    category="orchard"
                    counts={{ actions: data.orchardActions || 0 }}
                    valueBalance={data.valueBalanceOrchard}
                  />
                )}
                {hasIronwoodActivity && (
                  <PoolActivityBox
                    category="ironwood"
                    counts={{ actions: data.ironwoodActions || 0 }}
                    valueBalance={data.valueBalanceIronwood}
                  />
                )}
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
