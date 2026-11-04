import type { AppNetwork } from './network';
import { HISTORICAL_UPGRADES } from './upgrade-history-data';
import { ANNOUNCED_MAINNET_NU7, estimateBlockArrivalDate, type UpgradeSnapshot } from './network-upgrades';

export type UpgradeTracker = {
  id: 'nu7' | 'nu63' | 'nu62';
  version: string;
  name: string;
  description: string;
  impact: string;
  href: string;
  linkLabel: string;
  linkDescription: string;
  related: boolean;
  height: number | null;
  status: 'active' | 'scheduled' | 'announced' | 'historical' | 'unavailable';
  authority: 'node' | 'announcement' | 'historical' | 'unavailable';
  estimatedDate: string | null;
  sources: { label: string; href: string }[];
  relatedLinks: { label: string; href: string }[];
};

/** Tracker relationships are editorial; activation state is kept separate. */
export function buildUpgradeTrackers(snapshot: UpgradeSnapshot | null, network: AppNetwork): UpgradeTracker[] {
  if (network === 'crosslink-testnet') return [];
  const nu7Height = snapshot?.schedule.nu7Height ?? (network === 'mainnet' ? ANNOUNCED_MAINNET_NU7.height : null);
  const nodeScheduled = snapshot?.schedule.nu7Height != null;
  const active = nodeScheduled && snapshot!.height >= nu7Height!;
  const estimate = nodeScheduled && !active ? estimateBlockArrivalDate(snapshot, nu7Height!) : null;
  const historicalHeight = (id: string) => HISTORICAL_UPGRADES.find(upgrade => upgrade.id === id)!.heights[network];
  const historical = (height: number) => !snapshot ? 'historical' as const : snapshot.height >= height ? 'active' as const : 'scheduled' as const;

  return [
    {
      id: 'nu7', version: 'NU7', name: 'Block speed, NSM & protocol updates',
      description: 'Faster blocks, the Network Sustainability Mechanism, transaction retirement, and updated validation and funding rules.',
      impact: '75s → 25s target', href: '/network/block-speed',
      linkLabel: 'See the effect on block speed', linkDescription: 'Compare measured block times and wallet waits.', related: false,
      height: nu7Height,
      status: active ? 'active' : nodeScheduled ? 'scheduled' : network === 'mainnet' ? 'announced' : 'unavailable',
      authority: nodeScheduled ? 'node' : network === 'mainnet' ? 'announcement' : 'unavailable',
      estimatedDate: estimate?.dateTime.slice(0, 10) ?? (!nodeScheduled && network === 'mainnet' ? ANNOUNCED_MAINNET_NU7.date : null),
      sources: [{ label: 'ZIP 259', href: 'https://zips.z.cash/zip-0259' }, { label: 'ZIP 218', href: 'https://zips.z.cash/zip-0218' }],
      relatedLinks: [
        ...(network === 'mainnet' ? [{ label: 'Vote results', href: '/governance/nu7' }] : []),
        { label: 'Issuance & halving', href: '/network#issuance' },
        { label: 'NSM reserve & fees', href: '/network#nu7-accounting' },
        { label: 'Mining economics', href: '/mining#economics' },
      ],
    },
    {
      id: 'nu63', version: 'NU6.3', name: 'Ironwood',
      description: 'Ironwood replaces Orchard for new shielded activity, with a new transaction format and migration path.',
      impact: 'Orchard → Ironwood', href: '/ironwood',
      linkLabel: 'Ironwood migration tracker', linkDescription: 'Follow migration, pool supply and public activity.', related: false,
      height: historicalHeight('nu63'),
      status: historical(historicalHeight('nu63')), authority: 'historical', estimatedDate: null,
      sources: [{ label: 'ZIP 258', href: 'https://zips.z.cash/zip-0258' }, { label: 'ZIP 318', href: 'https://zips.z.cash/zip-0318' }],
      relatedLinks: [
        { label: 'Shielded supply', href: '/pools#supply' },
        { label: 'Pool flows', href: '/pools#flows' },
        { label: 'Decode transactions', href: '/tools/decode' },
        { label: 'Decrypt memos', href: '/decrypt' },
        { label: 'Privacy patterns', href: '/privacy-risks' },
      ],
    },
    {
      id: 'nu62', version: 'NU6.2', name: 'Orchard recovery',
      description: 'Orchard was re-enabled with corrected proof rules.',
      impact: 'Orchard proof update', href: '/turnstile?period=nu6.2',
      linkLabel: 'Flows since NU6.2', linkDescription: 'Public exits since Jun 1, 2026: held, reshielded or moved.', related: true,
      height: historicalHeight('nu62'),
      status: historical(historicalHeight('nu62')), authority: 'historical', estimatedDate: null,
      sources: [{ label: 'ZIP 257', href: 'https://zips.z.cash/zip-0257' }],
      relatedLinks: [
        { label: 'Pool inflows & outflows', href: '/pools#flows' },
        { label: 'Turnstile chart', href: '/charts/turnstile' },
      ],
    },
  ];
}
