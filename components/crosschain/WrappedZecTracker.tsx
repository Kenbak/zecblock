'use client';

import { ChartWatermark } from '@/components/ChartWatermark';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { TokenChainIcon } from '@/components/TokenChainIcon';
import { Tooltip } from '@/components/Tooltip';
import { formatAmount, formatUSD, type DisplayUnit } from '@/components/crosschain/format';

export interface WrappedZecAsset {
  id: string;
  label: string;
  issuer: string;
  chain: string;
  totalSupply: number;
  explorerUrl: string;
}

const CHAIN_NAMES: Record<string, string> = { base: 'Base', sol: 'Solana', near: 'NEAR' };

function formatSupply(supply: number, unit: DisplayUnit, zecPrice: number | null): string {
  if (unit === 'usd' && zecPrice && zecPrice > 0) {
    return formatUSD(supply * zecPrice);
  }
  return `${formatAmount(supply)} ZEC`;
}

function formatTotal(total: number, unit: DisplayUnit, zecPrice: number | null): string {
  if (unit === 'usd' && zecPrice && zecPrice > 0) {
    return formatUSD(total * zecPrice);
  }
  return `${formatAmount(total)} ZEC`;
}

export function WrappedZecTracker({
  assets,
  totalWrapped,
  unit = 'zec',
  zecPrice = null,
}: {
  assets: WrappedZecAsset[];
  totalWrapped: number;
  unit?: DisplayUnit;
  zecPrice?: number | null;
}) {
  if (assets.length === 0) return null;

  return (
    <div className="card">
      <SectionHeader
        label="WRAPPED_ZEC"
        actions={
          <div className="flex items-center gap-2">
            <Tooltip content="Live total supply of each known ZEC representation on other chains, read directly from each token's own contract via that chain's public RPC." />
            <span className="text-xs font-mono text-muted tabular-nums">
              {formatTotal(totalWrapped, unit, zecPrice)}{' '}
              {unit !== 'usd' && <span className="text-muted">total</span>}
            </span>
          </div>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {assets.map((asset) => {
          const pct = totalWrapped > 0 ? (asset.totalSupply / totalWrapped) * 100 : 0;
          return (
            <a
              key={asset.id}
              href={asset.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-3 p-3 rounded-lg border border-cipher-border hover:border-glass-12 transition-colors bg-glass-2 hover:bg-glass-3"
            >
              <TokenChainIcon token={asset.id === 'cbzec' ? 'cbzec' : 'zec'} chain={asset.chain} size={32} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-mono font-semibold text-primary truncate">{asset.label}</span>
                  <svg className="w-2.5 h-2.5 text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </div>
                <div className="text-caption text-muted truncate">{asset.issuer} · {CHAIN_NAMES[asset.chain] || asset.chain}</div>
                <div className="mt-1.5 h-1 w-full rounded-full bg-glass-4 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-glass-12"
                    style={{ width: `${Math.max(pct, 0.5)}%` }}
                  />
                </div>
              </div>
              <span className="text-sm font-mono text-primary shrink-0 tabular-nums">{formatSupply(asset.totalSupply, unit, zecPrice)}</span>
            </a>
          );
        })}
      </div>
      <ChartWatermark />
    </div>
  );
}
