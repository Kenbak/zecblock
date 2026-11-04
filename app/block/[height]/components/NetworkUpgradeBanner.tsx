import Link from 'next/link';
import { NETWORK } from '@/lib/config';
import { useApiQuery } from '@/hooks/useApiQuery';
import { readUpgradeSnapshot, getBlockUpgrade } from '@/lib/network-upgrades';
import { Badge } from '@/components/ui/Badge';
import type { BlockData } from './types';

export function NetworkUpgradeBanner({ data }: { data: BlockData }) {
  const { data: stats, error } = useApiQuery<unknown>('/v1/network/stats', undefined, { enabled: NETWORK !== 'crosslink', refreshInterval: 30_000 });
  const network = NETWORK === 'crosslink' ? 'crosslink-testnet' : NETWORK;
  const snapshot = error ? null : readUpgradeSnapshot(stats, network);
  const upgrade = getBlockUpgrade(data.height, network, snapshot);
  if (!upgrade) return null;

  const isNu7 = upgrade.upgradeId === 'nu7';
  const pending = isNu7 && snapshot !== null && snapshot.height < data.height;
  const badgeLabel = data.isOrphaned ? 'ORPHANED' : pending ? 'SCHEDULED' : isNu7 ? 'ACTIVATED' : upgrade.badge || 'ACTIVATED';
  const linkLabel = upgrade.linkText || 'Explore the milestone →';

  return (
    <div className="mb-6 rounded-xl border border-cipher-yellow-bright/30 bg-gradient-to-r from-cipher-yellow-bright/5 to-transparent p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-cipher-yellow-bright/10 border border-cipher-yellow-bright/20">
            <svg className="w-4 h-4 text-cipher-yellow-bright" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="text-sm font-semibold text-cipher-yellow-bright">{upgrade.name}</span>
            {upgrade.zip && <Badge color="amber">{upgrade.zip}</Badge>}
            <Badge color={data.isOrphaned || pending ? 'amber' : 'green'}>{badgeLabel}</Badge>
          </div>
          <p className="text-xs sm:text-sm text-secondary leading-relaxed">
            {upgrade.description}
            {upgrade.upgradeId && data.isOrphaned && ' This block is orphaned; it is not the canonical activation block.'}
          </p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-3">
            {upgrade.link && (
              <Link
                href={upgrade.link}
                className="inline-flex items-center gap-1.5 text-xs font-mono text-cipher-yellow-bright hover:text-cipher-yellow-glow transition-colors"
              >
                {linkLabel}
              </Link>
            )}
            {upgrade.trackerLink && <Link href={upgrade.trackerLink.href} className="text-xs font-mono text-secondary hover:text-cipher-yellow-bright transition-colors">{upgrade.trackerLink.label}</Link>}
          </div>
        </div>
      </div>
    </div>
  );
}
