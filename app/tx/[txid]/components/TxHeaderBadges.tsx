'use client';

import { ExportButton } from '@/components/ExportButton';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { TxTypeBadge, type TxCategory } from '@/components/ui/TxTypeBadge';
import { NetworkIcon } from '@/components/icons/common';
import { getNetworkLabel } from '@/lib/network';
import type { TransactionData, TxClassification, TxType } from './types';

interface TxHeaderBadgesProps {
  data: TransactionData;
  classification: TxClassification;
}

// The header's one categorical "Type" badge — same registry (label, color,
// AND icon) as every other Type column in the app (block table, /txs,
// /txs/shielded, mempool). No local icon logic needed — TxTypeBadge already
// carries the right icon for every category.
const TX_TYPE_TO_CATEGORY: Partial<Record<TxType, TxCategory>> = {
  COINBASE: 'coinbase',
  MIGRATION: 'migration',
  SPROUT: 'sprout',
  IRONWOOD: 'ironwood',
  ORCHARD: 'orchard',
  SHIELDED: 'sapling',
  SHIELDING: 'shielding',
  UNSHIELDING: 'unshielding',
  MIXED: 'mixed',
  REGULAR: 'transparent',
};

export function TxHeaderBadges({ data, classification }: TxHeaderBadgesProps) {
  const { txType, allBridges } = classification;
  const category = TX_TYPE_TO_CATEGORY[txType];
  const networkLabel = getNetworkLabel();

  return (
    <div className="flex items-center justify-between gap-2 mb-4 animate-fade-in-up">
      {/* General -> specific: network context, lifecycle status, bridge marker, then the tx category.
          All subtle — several badges sitting in one row read as one calm strip
          this way, with color living only in each icon rather than in four
          separate saturated fills. */}
      <div className="flex flex-wrap items-center gap-2 min-w-0 flex-1">
        <Badge color="muted" icon={<NetworkIcon />} variant="subtle">
          {networkLabel}
        </Badge>
        {data.status === 'stale' || data.isCanonical === false ? (
          <StatusBadge status="reorganized" variant="subtle" />
        ) : data.status === 'unknown' ? (
          <Badge color="muted" variant="subtle">UNKNOWN</Badge>
        ) : (
          <StatusBadge status="confirmed" variant="subtle" />
        )}
        {allBridges.length > 0 && (
          <Badge
            color="gold"
            variant="subtle"
            icon={
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
                />
              </svg>
            }
          >
            {allBridges[0].direction === 'entry' ? 'BRIDGE IN' : 'BRIDGE OUT'}
          </Badge>
        )}
        {category && <TxTypeBadge category={category} variant="subtle" />}
      </div>
      <ExportButton
        data={{
          txid: data.txid,
          blockHeight: data.blockHeight,
          blockHash: data.blockHash,
          timestamp: data.timestamp,
          confirmations: data.confirmations,
          fee: data.fee,
          size: data.size,
          version: data.version,
          locktime: data.locktime,
          totalInput: data.totalInput,
          totalOutput: data.totalOutput,
          saplingSpendCount: data.saplingSpendCount,
          saplingOutputCount: data.saplingOutputCount,
          orchardActions: data.orchardActions,
          inputs: data.inputs.map((i: any) => ({
            address: i.address || 'shielded',
            value: i.value,
            coinbase: i.coinbase || false,
          })),
          outputs: data.outputs.map((o: any) => ({
            address: o.scriptPubKey?.addresses?.[0] || 'shielded',
            value: o.value,
            index: o.n,
            spent: o.spent || false,
          })),
        }}
        filename={`tx-${data.txid.slice(0, 16)}`}
        type="json"
        label="Export"
      />
    </div>
  );
}
