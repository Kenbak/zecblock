import type { AppNetwork } from './network';
import type { UpgradeSnapshot } from './network-upgrades';
import { buildUpgradeTrackers, type UpgradeTracker } from './upgrade-trackers';
import { HISTORICAL_UPGRADES } from './upgrade-history-data';

export type UpgradeMilestone = {
  id: string;
  label: string;
  height: number | null;
  status: UpgradeTracker['status'];
  sourceUrl: string;
  summary: string;
  links: { label: string; href: string }[];
};

/** Chronological protocol history; live NU7 authority stays in the tracker model. */
export function buildUpgradeHistory(snapshot: UpgradeSnapshot | null, network: AppNetwork): UpgradeMilestone[] {
  if (network === 'crosslink-testnet') return [];

  const historical: UpgradeMilestone[] = HISTORICAL_UPGRADES.map(upgrade => {
    const height = upgrade.heights[network];
    return {
      id: upgrade.id,
      label: upgrade.label,
      height,
      status: !snapshot ? 'historical' : snapshot.height >= height ? 'active' : 'scheduled',
      sourceUrl: upgrade.sourceUrl,
      summary: upgrade.summary,
      links: upgrade.links.map(link => ({ ...link })),
    };
  });

  const recent = buildUpgradeTrackers(snapshot, network).filter(tracker => tracker.id === 'nu7').map(tracker => ({
    id: tracker.id,
    label: tracker.version,
    height: tracker.height,
    status: tracker.status,
    sourceUrl: tracker.sources[0].href,
    summary: tracker.description,
    links: [{ label: tracker.linkLabel, href: tracker.href }],
  }));

  return [...historical, ...recent];
}
