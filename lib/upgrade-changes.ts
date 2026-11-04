import type { AppNetwork } from './network';
import { HISTORICAL_UPGRADE_CHANGES } from './upgrade-changes-history';
import { FUNDING_UPGRADE_CHANGES } from './upgrade-changes-funding';
import { buildRecentUpgradeChanges } from './upgrade-changes-recent';

export type UpgradeChange = {
  id: string;
  title: string;
  description: string;
  value?: string;
  sources: { label: string; href: string }[];
  links: { label: string; href: string; note?: string }[];
};

/** Major deployed changes, sourced to each upgrade's deployment/consensus ZIPs. */
export function buildUpgradeChanges(id: string, network: AppNetwork, active = false): UpgradeChange[] {
  if (network === 'crosslink-testnet') return [];
  if (Object.hasOwn(HISTORICAL_UPGRADE_CHANGES, id)) return HISTORICAL_UPGRADE_CHANGES[id];
  if (Object.hasOwn(FUNDING_UPGRADE_CHANGES, id)) return FUNDING_UPGRADE_CHANGES[id];
  return buildRecentUpgradeChanges(id, network, active);
}
