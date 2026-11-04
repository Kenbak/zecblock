import type { AppNetwork } from './network';
import type { UpgradeChange } from './upgrade-changes';

const zip = (number: number) => ({
  label: `ZIP ${number}`,
  href: `https://zips.z.cash/zip-${String(number).padStart(4, '0')}`,
});

/** Protocol effects and existing views are separate from activation authority. */
export function buildRecentUpgradeChanges(id: string, network: AppNetwork, active = false): UpgradeChange[] {
  if (network === 'crosslink-testnet') return [];

  const accountingNote = active ? undefined
    : `${network === 'mainnet' ? 'Mainnet' : 'Testnet'} accounting begins at NU7`;

  if (id === 'nu7') return [
    {
      id: 'nu7-block-spacing', title: '25-second blocks', value: '75s → 25s',
      description: 'Shortens the block target. Per-block subsidy and halving heights adjust to preserve the base issuance schedule, while the difficulty averaging window grows from 17 to 102 blocks.',
      sources: [zip(218)],
      links: [
        { label: 'See the effect on block speed', href: '/network/block-speed' },
        { label: 'Explore issuance and the next halving', href: '/network#issuance' },
      ],
    },
    {
      id: 'nu7-action-limits', title: 'Shielded action limits', value: '330-unit shared budget',
      description: 'Adds one shared shielded budget per block. Orchard and Ironwood each have a 330-action ceiling; Sapling spends plus outputs are capped at 300. The shared budget limits combinations across pools.',
      sources: [zip(218)],
      links: [],
    },
    {
      id: 'nu7-nsm', title: 'NSM reserve and later reissuance', value: 'Halvings preserved',
      description: `Creates a reserve seeded by historical unclaimed value, separate from issued supply. Additional issuance from that reserve starts later, at block ${(network === 'mainnet' ? 8_939_664 : 7_305_222).toLocaleString('en-US')}, alongside the existing halving schedule. The 21-million cap remains.`,
      sources: [zip(237), zip(259)],
      links: [
        { label: 'Explore the NSM reserve', href: '/network#nu7-accounting', note: accountingNote },
        { label: 'See the supply and issuance projection', href: '/network#issuance', note: 'Projects scheduled new issuance; excludes future removals and NSM reissuance.' },
      ],
    },
    {
      id: 'nu7-fee-allocation', title: 'Fees contribute to the NSM', value: '60% of block fees',
      description: 'Removes 60% of aggregate transaction fees from circulation, rounded down once per block. The remaining fee allocation goes to miners. Removed funds are intended for later reissuance, rather than permanent destruction.',
      sources: [zip(235)],
      links: [{ label: 'See fee allocation over time', href: '/network#nu7-accounting', note: accountingNote }],
    },
    {
      id: 'nu7-v4-retirement', title: 'Version 4 and Sprout retirement', value: 'v5 and v6 remain',
      description: 'From activation, version 4 transactions become invalid, including transparent and Sapling transactions in that format. Sprout funds can no longer be spent, but their balance remains issued. NU7 introduces no new transaction format.',
      sources: [zip(2003), zip(259)],
      links: [
        { label: 'See the remaining Sprout balance', href: '/pools#supply' },
        { label: 'Inspect a transaction version', href: '/tools/decode', note: 'Decodes structure; it does not validate consensus rules or proofs.' },
      ],
    },
    {
      id: 'nu7-funding-streams', title: 'Funding streams adapt',
      description: `Preserves funding streams until the adjusted third halving and keeps address periods similar in elapsed time. Permits P2PKH recipients.${network === 'mainnet' ? ' Updates the mainnet ZCG address from the first new funding period after activation.' : ' The existing testnet recipient address remains unchanged.'}`,
      sources: [zip(207), zip(214), zip(2008)],
      links: [{ label: 'See subsidy and miner allocation', href: '/network#issuance' }],
    },
  ];

  if (id === 'nu63') return [
    {
      id: 'nu63-ironwood', title: 'Ironwood shielded pool', value: 'Orchard → Ironwood',
      description: 'Creates a separate shielded value pool using the Orchard protocol. Funds can migrate from Orchard to Ironwood; public amounts crossing between pools make migration timing and denominations relevant to privacy.',
      sources: [zip(258), zip(318)],
      links: [
        { label: 'Follow the migration into Ironwood', href: '/ironwood' },
        { label: 'See migration activity and cohorts', href: '/ironwood#migration-activity' },
        { label: 'Explore migration amount patterns', href: '/ironwood#privacy-score', note: 'Observed denomination, action and anchor checks do not establish individual privacy.' },
        { label: 'Compare migration transaction sizes', href: '/ironwood#migration-tiers' },
      ],
    },
    {
      id: 'nu63-v6', title: 'Version 6 transactions', value: 'New Ironwood component',
      description: 'Adds an Ironwood component and associated transaction hashes and signatures. Existing Orchard address and key material can also be used with Ironwood; creating Ironwood notes requires version 6 support.',
      sources: [zip(229)],
      links: [
        { label: 'Inspect a version 6 transaction', href: '/tools/decode', note: 'Structural decoding is not proof or consensus validation.' },
        { label: 'Read an Ironwood memo', href: '/decrypt', note: 'Requires your viewing key; decryption stays in the browser.' },
        { label: 'Check wallet migration support', href: '/ironwood#wallet-readiness-heading', note: 'A dated support review, not a ZIP 318 compliance audit.' },
      ],
    },
    {
      id: 'nu63-orchard-exit', title: 'Orchard becomes exit-only',
      description: 'Stops new value entering Orchard, disables cross-address transfers within it and disallows Orchard coinbase actions. Existing value can still leave the pool, including through migration to Ironwood.',
      sources: [zip(258)],
      links: [{ label: 'Follow public pool inflows and outflows', href: '/pools#flows', note: 'Public pool-boundary amounts; private transfers are not visible.' }],
    },
    {
      id: 'nu63-recoverability', title: 'Notes prepared for future recovery',
      description: 'Ironwood notes use a format designed to support a future quantum recovery protocol. This prepares a migration path if existing cryptography must be retired; it does not make Zcash quantum-secure today.',
      sources: [zip(2005)],
      links: [],
    },
    {
      id: 'nu63-supply-integrity', title: 'Separate Ironwood accounting',
      description: 'Adds an Ironwood value balance, commitment tree, anchors and chain-history fields. Consensus rejects negative pool balances and supply above the existing monetary bound.',
      sources: [zip(258)],
      links: [
        { label: 'See turnstile supply verification', href: '/ironwood#supply', note: 'Public pool accounting; it does not reveal individual shielded balances.' },
        { label: 'Explore pool supply history', href: '/pools#supply' },
      ],
    },
  ];

  if (id === 'nu62') return [
    {
      id: 'nu62-orchard-reenabled', title: 'Orchard re-enabled',
      description: 'Ends the temporary Orchard security shutdown and permits Orchard Actions again under corrected proof rules.',
      sources: [zip(257)],
      links: [
        { label: 'Follow public exits since NU6.2', href: '/turnstile?period=nu6.2', note: 'Related analytics from June 1, 2026; not an exact activation-height cohort or proof of a sale.' },
        { label: 'See public Orchard flows', href: '/pools#flows' },
      ],
    },
    {
      id: 'nu62-circuit-fix', title: 'Corrected Orchard circuit',
      description: 'Fixes the variable-base scalar multiplication gadget in the Orchard Action circuit and replaces its verifying key. Historical proofs and corrected proofs use their respective consensus-era keys.',
      sources: [zip(257)],
      links: [],
    },
    {
      id: 'nu62-proof-length', title: 'Canonical proof lengths',
      description: 'Requires Orchard Action proofs to have the canonical length for the corrected circuit. This length check becomes a consensus rule from NU6.2.',
      sources: [zip(257)],
      links: [],
    },
  ];

  return [];
}
