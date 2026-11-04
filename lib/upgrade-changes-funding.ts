import type { UpgradeChange } from './upgrade-changes';

/** Historical funding changes; current explorer views do not audit those eras. */
export const FUNDING_UPGRADE_CHANGES: Record<string, UpgradeChange[]> = {
  nu6: [
    {
      id: 'nu6-exact-block-rewards',
      title: 'Exact block rewards',
      description: 'NU6 required coinbase transactions to claim all available miner subsidy and fees, preventing accidental burns from under-claiming.',
      sources: [{ label: 'ZIP 236', href: 'https://zips.z.cash/zip-0236' }],
      links: [{
        label: 'Current miner economics', href: '/mining#economics',
        note: 'Current view, not a historical NU6 coinbase audit.',
      }],
    },
    {
      id: 'nu6-development-funding',
      title: 'Renewed development funding',
      description: 'The NU6-era funding scheme directed 8% of block subsidy to Zcash Community Grants through FPF and 12% to the deferred lockbox.',
      value: '8% ZCG · 12% deferred',
      sources: [{ label: 'ZIP 1015', href: 'https://zips.z.cash/zip-1015' }],
      links: [{
        label: 'Current issuance & halving', href: '/network#issuance',
        note: 'Current schedule; historical NU6 recipient allocations are not charted.',
      }],
    },
    {
      id: 'nu6-deferred-lockbox',
      title: 'Deferred funding lockbox',
      description: 'NU6 introduced a separately tracked pool of issued funds for future development grants, without defining a withdrawal mechanism.',
      sources: [{ label: 'ZIP 2001', href: 'https://zips.z.cash/zip-2001' }],
      links: [],
    },
  ],
  nu61: [
    {
      id: 'nu61-lockbox-disbursement',
      title: 'Lockbox disbursement',
      description: 'NU6.1 moved 78,750 ZEC (78,750 TAZ on testnet) of already-issued lockbox funds to a 2-of-3 multisig for grants.',
      sources: [
        { label: 'ZIP 271', href: 'https://zips.z.cash/zip-0271' },
        { label: 'NU6.1 deployment', href: 'https://zips.z.cash/zip-0255' },
      ],
      links: [],
    },
    {
      id: 'nu61-funding-extension',
      title: 'Funding-stream extension',
      description: 'NU6.1 extended the 8% ZCG and 12% deferred-funding streams until the third halving, with later NU7 rules adjusting their end heights.',
      sources: [
        { label: 'ZIP 271', href: 'https://zips.z.cash/zip-0271' },
        { label: 'ZIP 1016', href: 'https://zips.z.cash/zip-1016' },
        { label: 'ZIP 214', href: 'https://zips.z.cash/zip-0214' },
      ],
      links: [{
        label: 'Current issuance & halving', href: '/network#issuance',
        note: 'Current schedule, not a historical NU6.1 funding-disbursement view.',
      }],
    },
    {
      id: 'nu61-community-coinholder-funding',
      title: 'Community and coinholder funding',
      description: 'The funding model gave ZCG and coinholders distinct grant-allocation roles, with coinholder-directed funds administered by multisig key holders.',
      sources: [
        { label: 'ZIP 1016', href: 'https://zips.z.cash/zip-1016' },
        { label: 'NU6.1 deployment', href: 'https://zips.z.cash/zip-0255' },
      ],
      links: [],
    },
  ],
};
